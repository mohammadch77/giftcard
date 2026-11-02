import { sql } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import type { AuditActor } from "@/modules/audit";
import { consume, release, reserve } from "@/modules/inventory";
import type { Tx } from "@/platform/db";
import { withTransaction } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { enqueueOutbox } from "@/platform/outbox";
import { setTransitionContext } from "@/platform/transitions";
import { ORDER_COLS, SYSTEM, assertCheckoutConfigured, first, iso, loadItems, moveOrder, policyOf, settleOrder, syncFulfillmentTx, toDate } from "./core";
import type { OrderRow, OrdersDeps } from "./core";

type Who = { type: "CUSTOMER"; userId: string } | { type: "ADMIN"; actor: AuditActor; authorize(permission: string): Promise<void> } | { type: "SYSTEM" };

/** Expire ONE unpaid order whose hold has lapsed and return its stock. Idempotent; a payment that arrives later takes the D9 late path. */
export async function expireOrder(deps: OrdersDeps, orderId: string): Promise<boolean> {
  return withTransaction(deps.db, async (tx) => {
    const o = first<OrderRow>(await tx.execute(sql`select ${ORDER_COLS} from orders where id = ${orderId} for update`));
    if (!o || o.status !== "PENDING_PAYMENT" || deps.clock.now().getTime() < toDate(o.expires_at).getTime()) return false;
    return expireLocked(tx, deps, o);
  });
}

async function expireLocked(tx: Tx, deps: OrdersDeps, o: OrderRow): Promise<boolean> {
  if (o.reservation_id) await release(tx, deps.clock, o.reservation_id, "order expired"); // false when the sweeper already did it
  await moveOrder(tx, deps.clock, o.id, "EXPIRED", SYSTEM.id, "payment window elapsed");
  await enqueueOutbox(tx, { eventType: "order.expired", aggregateType: "order", aggregateId: o.id, payload: { orderId: o.id } }, deps.clock);
  await recordAudit(tx, { actor: SYSTEM, action: "orders.order.expired", entity: { type: "order", id: o.id }, occurredAt: deps.clock.now() });
  return true;
}

/** Worker entry: expire lapsed unpaid orders in small SKIP LOCKED batches (safe from many workers). Returns how many. */
export async function expireStale(deps: OrdersDeps, opts: { batchSize?: number } = {}): Promise<number> {
  return withTransaction(deps.db, async (tx) => {
    const ids = (await tx.execute(sql`select id from orders where status = 'PENDING_PAYMENT' and expires_at <= ${iso(deps.clock.now())}::timestamptz order by expires_at limit ${Math.min(opts.batchSize ?? 50, 200)} for update skip locked`)).rows as { id: string }[];
    let n = 0;
    for (const r of ids) {
      const o = first<OrderRow>(await tx.execute(sql`select ${ORDER_COLS} from orders where id = ${r.id}`))!;
      if (await expireLocked(tx, deps, o)) n++;
    }
    return n;
  });
}

/**
 * Cancel an UNPAID order and release its reservation (idempotent). Paid orders are never cancelled here — that is a refund
 * (2b-9; B12/B13). A gateway payment that still arrives afterwards takes the D9 late path.
 */
export async function cancelOrder(deps: OrdersDeps, input: { orderId: string; by: Who; reason: string }): Promise<{ status: string; replay: boolean }> {
  if (input.reason.trim().length < 3) throw new DomainError("ORDER_INVALID", "a reason is required");
  if (input.by.type === "ADMIN") await input.by.authorize("orders.cancel");
  return withTransaction(deps.db, async (tx) => {
    const o = first<OrderRow>(await tx.execute(sql`select ${ORDER_COLS} from orders where id = ${input.orderId} for update`));
    if (!o || (input.by.type === "CUSTOMER" && o.user_ref !== input.by.userId)) throw new DomainError("ORDER_NOT_FOUND", "order not found");
    if (o.status === "CANCELLED") return { status: "CANCELLED", replay: true };
    if (o.status !== "PENDING_PAYMENT") throw new DomainError("ORDER_INVALID", `order is ${o.status}; only unpaid orders can be cancelled here (refunds: 2b-9)`);
    if (o.reservation_id) await release(tx, deps.clock, o.reservation_id, "order cancelled");
    const actor: AuditActor = input.by.type === "CUSTOMER" ? { type: "USER", id: input.by.userId } : input.by.type === "ADMIN" ? input.by.actor : SYSTEM;
    await moveOrder(tx, deps.clock, o.id, "CANCELLED", actor.id, input.reason.trim());
    await enqueueOutbox(tx, { eventType: "order.cancelled", aggregateType: "order", aggregateId: o.id, payload: { orderId: o.id } }, deps.clock);
    await recordAudit(tx, { actor, action: "orders.order.cancelled", entity: { type: "order", id: o.id }, metadata: { reason: input.reason.trim() }, occurredAt: deps.clock.now() });
    return { status: "CANCELLED", replay: false };
  });
}

export interface HoldDecision { resolution: "RE_RESERVE" | "KEEP_ON_HOLD"; note: string }

/**
 * Resolve a hold (permission orders.resolve_hold, sensitive; note mandatory; audited).
 *  RE_RESERVE (LATE_PAYMENT_NO_RESERVATION only, D9): a NEW reservation is taken through the normal atomic path and consumed at once
 *  (the lapsed one is never used); then the order settles (D10 posting from suspense — refuses while undecided, rolling everything back)
 *  and the hold closes in the same transaction. Insufficient stock leaves the order ON_HOLD.
 *  KEEP_ON_HOLD: records the review only.
 *  Any other hold reason (PAYMENT_NEEDS_REVIEW, ...) cannot be resolved yet: it needs the refund / review policy (B12/B13).
 */
export async function resolveHold(deps: OrdersDeps, admin: { actor: AuditActor; authorize(permission: string): Promise<void> }, holdId: string, d: HoldDecision): Promise<{ status: string }> {
  await admin.authorize("orders.resolve_hold");
  if (d.note.trim().length < 10) throw new DomainError("ORDER_INVALID", "a note of at least 10 characters is required");
  return withTransaction(deps.db, async (tx) => {
    const h = first<{ id: string; order_id: string; reason: string; resolved_at: unknown }>(await tx.execute(sql`select id, order_id, reason, resolved_at from order_holds where id = ${holdId} for update`));
    if (!h) throw new DomainError("ORDER_NOT_FOUND", "hold not found");
    if (h.resolved_at) throw new DomainError("ORDER_INVALID", "hold is already resolved");
    const o = first<OrderRow>(await tx.execute(sql`select ${ORDER_COLS} from orders where id = ${h.order_id} for update`))!;
    if (d.resolution === "KEEP_ON_HOLD") {
      await recordAudit(tx, { actor: admin.actor, action: "orders.hold.reviewed", entity: { type: "order_hold", id: holdId }, metadata: { note: d.note.trim() }, occurredAt: deps.clock.now() });
      return { status: o.status };
    }
    if (h.reason !== "LATE_PAYMENT_NO_RESERVATION") throw new DomainError("ORDER_INVALID", `holds of type ${h.reason} cannot be resolved yet (refund/review policy B12/B13 is open)`);
    if (o.status !== "ON_HOLD" || o.payment_status !== "SUCCEEDED") throw new DomainError("ORDER_INVALID", "order is not a paid late-payment hold");
    if (!policyOf(deps).configured) assertCheckoutConfigured(deps, "WALLET"); // throws ORDER_ACCOUNTING_NOT_CONFIGURED / TTL error BEFORE any change
    const ttl = assertCheckoutConfigured(deps, "WALLET");
    const items = await loadItems(tx, o.id);
    const reservable = items.filter((i) => i.snapshot.fulfillmentMethod !== "SUPPLIER_API").map((i) => ({ variantId: i.variant_id, quantity: i.quantity })).sort((a, b) => (a.variantId < b.variantId ? -1 : 1));
    let reservationId: string | null = null;
    if (reservable.length) {
      const r = await reserve(tx, deps.clock, { reservationKey: `rereserve:${holdId}`, orderRef: o.id, ttlSeconds: ttl, lines: reservable }); // INVENTORY_INSUFFICIENT => order stays ON_HOLD
      const c = await consume(tx, deps.clock, r.reservationId);
      if (c.outcome !== "CONSUMED") throw new DomainError("ORDER_EXPIRED", "the new reservation could not be consumed");
      reservationId = r.reservationId;
      await tx.execute(sql`update orders set reservation_id = ${reservationId} where id = ${o.id}`);
    }
    const gateway = o.payment_id ? deps.gateway.key : undefined;
    await settleOrder(tx, deps, { ...o, reservation_id: reservationId }, { fromSuspense: true, actorId: admin.actor.id, paymentRef: o.payment_id ?? `wallet:${o.id}`, ...(gateway ? { gatewayKey: gateway } : {}) });
    await setTransitionContext(tx, { actorId: admin.actor.id, reason: "hold resolved" });
    await tx.execute(sql`update order_holds set resolved_at = ${iso(deps.clock.now())}::timestamptz, resolved_by = ${admin.actor.id}, resolution = 'RE_RESERVED', note = ${d.note.trim()} where id = ${holdId}`);
    await recordAudit(tx, { actor: admin.actor, action: "orders.hold.resolved", entity: { type: "order_hold", id: holdId }, metadata: { resolution: "RE_RESERVE", note: d.note.trim(), newReservation: reservationId !== null }, occurredAt: deps.clock.now() });
    return { status: "PAID" };
  });
}

/** Re-derive the order's fulfilment status from its tasks (call after fulfilment progress, e.g. from an outbox consumer). Idempotent. */
export async function syncFulfillment(deps: OrdersDeps, orderId: string): Promise<string> {
  return withTransaction(deps.db, (tx) => syncFulfillmentTx(tx, deps.clock, orderId));
}

