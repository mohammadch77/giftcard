import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/modules/audit";
import type { AuditActor } from "@/modules/audit";
import { ensureAccount, gatewayReceivable, post, suspenseReceipt, systemAccount } from "@/modules/ledger";
import { createTasks, deliverAutoCodes, listTasksForOrder } from "@/modules/fulfillment";
import { release } from "@/modules/inventory";
import type { Clock } from "@/platform/clock";
import type { Database, Tx } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { uuidv7 } from "@/platform/ids";
import { enqueueOutbox } from "@/platform/outbox";
import type { PaymentGateway } from "@/platform/payment-gateway";
import { setTransitionContext } from "@/platform/transitions";
import { NullOrderPostingPolicy } from "../domain/types";
import type { HoldReason, OrderPaymentPostingPolicy, OrderStatus, PaymentMethod } from "../domain/types";

export type Ts = Date | string;
export const iso = (d: Date): string => d.toISOString();
export const first = <T>(r: { rows: unknown[] }): T | undefined => r.rows[0] as T | undefined;
export const toDate = (v: Ts): Date => (v instanceof Date ? v : new Date(v.replace(" ", "T").replace(/(\.\d{3})\d*/, "$1").replace(/([+-]\d{2})$/, "$1:00")));
export const SYSTEM: AuditActor = { type: "SYSTEM", id: "system:orders" };

export interface OrdersDeps {
  db: Database;
  clock: Clock;
  gateway: PaymentGateway;
  /** D10: defaults to the refusing policy. */
  policy?: OrderPaymentPostingPolicy;
  /** B3 (OPEN): no default. Undefined => checkout is refused. */
  reservationTtlSeconds?: number | undefined;
  verify?: { leaseSeconds?: number; maxAttempts?: number };
}
export const policyOf = (d: OrdersDeps): OrderPaymentPostingPolicy => d.policy ?? new NullOrderPostingPolicy();

export interface OrderRow {
  id: string; number: string; user_ref: string; status: OrderStatus; payment_status: string; payment_method: PaymentMethod; total: string | number;
  reservation_id: string | null; payment_id: string | null; expires_at: Ts; paid_at: Ts | null; settlement_ledger_txn_id: string | number | null;
}
export const ORDER_COLS = sql`id, number, user_ref, status, payment_status, payment_method, total, reservation_id, payment_id, expires_at, paid_at, settlement_ledger_txn_id`;

export const unitRef = (itemId: string, unit: number): string => `${itemId}#${unit}`;

export interface ItemRow { id: string; variant_id: string; quantity: number; snapshot: { fulfillmentMethod?: string } }
export async function loadItems(tx: Tx | Database, orderId: string): Promise<ItemRow[]> {
  return (await tx.execute(sql`select id, variant_id, quantity, snapshot from order_items where order_id = ${orderId} order by line_no`)).rows as unknown as ItemRow[];
}

/** Move an order to `to` (the database validates the transition and writes history; the actor is mandatory). */
export async function moveOrder(tx: Tx, clock: Clock, orderId: string, to: OrderStatus, actorId: string, reason: string, extra: ReturnType<typeof sql> = sql``): Promise<void> {
  await setTransitionContext(tx, { actorId, reason });
  await tx.execute(sql`update orders set status = ${to}, updated_at = ${iso(clock.now())}::timestamptz ${extra} where id = ${orderId}`);
}

export const idLike = z.string().uuid();

/**
 * Settle a verified payment: book it (D10 policy — refuses while undecided), mark the order PAID, create fulfilment tasks (the DB
 * payment gate requires the order to be PAID first), deliver inventory-backed items from the CONSUMED reservation, derive the
 * fulfilment status. Runs inside the caller's transaction; any failure rolls the whole settlement back.
 */
export async function settleOrder(tx: Tx, deps: OrdersDeps, o: OrderRow, via: { fromSuspense: boolean; actorId: string; paymentRef: string; gatewayKey?: string }): Promise<void> {
  const now = deps.clock.now();
  const posted = await policyOf(deps).postOrderPayment(tx, {
    orderId: o.id, userRef: o.user_ref, amount: Number(o.total) as never, method: o.payment_method,
    ...(via.gatewayKey ? { gatewayKey: via.gatewayKey } : {}), ...(o.payment_id ? { paymentId: o.payment_id } : {}), fromSuspense: via.fromSuspense,
  });
  await moveOrder(tx, deps.clock, o.id, "PAID", via.actorId, via.fromSuspense ? "re-reserved after late payment" : "payment verified",
    sql`, payment_status = 'SUCCEEDED', paid_at = ${iso(now)}::timestamptz, settlement_ledger_txn_id = ${posted.ledgerTransactionId}`);
  const items = await loadItems(tx, o.id);
  const units = items.flatMap((i) => Array.from({ length: i.quantity }, (_, k) => ({ orderItemRef: unitRef(i.id, k + 1), variantId: i.variant_id, method: i.snapshot.fulfillmentMethod })));
  await createTasks(tx, deps.clock, { orderRef: o.id, userRef: o.user_ref, paymentRef: via.paymentRef, items: units.map((u) => ({ orderItemRef: u.orderItemRef, variantId: u.variantId })) });
  if (o.reservation_id) {
    const reserved = units.filter((u) => u.method !== "SUPPLIER_API");
    await deliverAutoCodes(tx, deps.clock, { reservationId: o.reservation_id, assignments: reserved.map((u) => ({ variantId: u.variantId, orderItemRef: u.orderItemRef })) });
  }
  await enqueueOutbox(tx, { eventType: "order.paid", aggregateType: "order", aggregateId: o.id, payload: { orderId: o.id, method: o.payment_method } }, deps.clock);
  await recordAudit(tx, { actor: via.actorId.startsWith("system:") ? SYSTEM : { type: "USER", id: via.actorId }, action: "orders.order.paid", entity: { type: "order", id: o.id }, metadata: { method: o.payment_method, fromSuspense: via.fromSuspense }, occurredAt: now });
  await syncFulfillmentTx(tx, deps.clock, o.id);
}

/** Derive FULFILLING / PARTIALLY_COMPLETED / COMPLETED from the fulfilment tasks (the source of truth). Idempotent. */
export async function syncFulfillmentTx(tx: Tx, clock: Clock, orderId: string): Promise<OrderStatus> {
  const o = first<{ status: OrderStatus }>(await tx.execute(sql`select status from orders where id = ${orderId} for update`))!;
  if (!["PAID", "FULFILLING", "PARTIALLY_COMPLETED"].includes(o.status)) return o.status;
  const tasks = await listTasksForOrder(tx, orderId);
  if (tasks.length === 0) return o.status;
  const done = tasks.filter((t) => t.status === "COMPLETED").length;
  const failed = tasks.filter((t) => t.status === "FAILED" || t.status === "CANCELLED").length;
  let target: OrderStatus = "FULFILLING";
  if (done === tasks.length) target = "COMPLETED";
  else if (done + failed === tasks.length && failed > 0 && done > 0) target = "PARTIALLY_COMPLETED";
  if (target === o.status) return o.status;
  if (o.status === "PAID" && target === "PARTIALLY_COMPLETED") {
    await moveOrder(tx, clock, orderId, "FULFILLING", SYSTEM.id, "fulfilment started");
    o.status = "FULFILLING";
  }
  if (o.status === "PARTIALLY_COMPLETED" && target === "FULFILLING") return o.status; // never go backwards
  await moveOrder(tx, clock, orderId, target, SYSTEM.id, "fulfilment progress");
  if (target === "COMPLETED") await enqueueOutbox(tx, { eventType: "order.completed", aggregateType: "order", aggregateId: orderId, payload: { orderId } }, clock);
  return target;
}

export async function openHold(tx: Tx, clock: Clock, orderId: string, reason: HoldReason, openedBy: string): Promise<string> {
  const id = uuidv7(clock);
  await tx.execute(sql`insert into order_holds (id, order_id, reason, opened_at, opened_by) values (${id}, ${orderId}, ${reason}, ${iso(clock.now())}::timestamptz, ${openedBy})`);
  return id;
}

/**
 * D9 late-payment path. The money is real (the gateway verified it) so the payment stays SUCCEEDED and the received amount is parked in
 * SUSPENSE_UNRESOLVED_RECEIPTS (the approved D9 rule — no D10 decision involved). The order goes ON_HOLD with an open hold, nothing is
 * consumed, sold or delivered, no fulfilment task is created, and a still-ACTIVE (but lapsed) reservation is released. A human resolves it.
 */
export async function handleLatePayment(tx: Tx, deps: OrdersDeps, o: OrderRow, gatewayKey: string, paymentId: string, amount: number): Promise<void> {
  const now = deps.clock.now();
  await ensureAccount(tx, gatewayReceivable(gatewayKey), SYSTEM, { clock: deps.clock });
  await ensureAccount(tx, systemAccount("SUSPENSE_UNRESOLVED_RECEIPTS"), SYSTEM, { clock: deps.clock });
  await post(tx, { kind: "SUSPENSE_RECEIPT", idempotencyKey: `late:${paymentId}`, reference: { type: "payment", id: paymentId }, entries: suspenseReceipt({ gatewayKey, amount }), description: "late payment (D9)", actor: SYSTEM }, { clock: deps.clock });
  if (o.reservation_id) await release(tx, deps.clock, o.reservation_id, "late payment: lapsed reservation released"); // never consumed
  await moveOrder(tx, deps.clock, o.id, "ON_HOLD", SYSTEM.id, "late payment", sql`, payment_status = 'SUCCEEDED'`);
  await openHold(tx, deps.clock, o.id, "LATE_PAYMENT_NO_RESERVATION", SYSTEM.id);
  await enqueueOutbox(tx, { eventType: "order.on_hold", aggregateType: "order", aggregateId: o.id, payload: { orderId: o.id, reason: "LATE_PAYMENT_NO_RESERVATION" } }, deps.clock);
  await recordAudit(tx, { actor: SYSTEM, action: "orders.order.late_payment_hold", entity: { type: "order", id: o.id }, metadata: { amount, paymentStatus: o.status }, occurredAt: now });
}

/** Fail-closed business configuration: B3 (hold) and D10 (accounting) must be decided before any order can be created. */
export function assertCheckoutConfigured(deps: OrdersDeps, method: PaymentMethod): number {
  const ttl = deps.reservationTtlSeconds;
  if (ttl === undefined || !Number.isInteger(ttl) || ttl < 60 || ttl > 3600) throw new DomainError("ORDER_RESERVATION_TTL_NOT_CONFIGURED", "the checkout reservation hold is not configured (decision B3 is open)");
  if (!policyOf(deps).configured) throw new DomainError("ORDER_ACCOUNTING_NOT_CONFIGURED", "order payment accounting is not decided (D10): checkout is blocked");
  if (method === "GATEWAY" && deps.gateway.key === "none") throw new DomainError("PAYMENT_GATEWAY_NOT_CONFIGURED", "no payment gateway is configured");
  return ttl;
}

