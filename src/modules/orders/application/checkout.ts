import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/modules/audit";
import { getFulfillmentCompatibility, getVariantSnapshot } from "@/modules/catalog";
import { consume, reserve } from "@/modules/inventory";
import { findPaymentByGatewayRef, initiatePayment, startGatewayPayment, verifyPayment } from "@/modules/payments";
import type { PaymentView, VerifyOutcome } from "@/modules/payments";
import { quote } from "@/modules/pricing";
import type { Tx } from "@/platform/db";
import { withTransaction } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { generateOrderNumber, uuidv7 } from "@/platform/ids";
import { enqueueOutbox } from "@/platform/outbox";
import { setTransitionContext } from "@/platform/transitions";
import { ORDER_COLS, SYSTEM, assertCheckoutConfigured, first, handleLatePayment, iso, moveOrder, openHold, settleOrder, toDate } from "./core";
import type { OrderRow, OrdersDeps } from "./core";
import type { PaymentMethod } from "../domain/types";
import { cancelOrder, expireOrder } from "./lifecycle";
import { getOrderSettings } from "./settings";

const checkoutInput = z.strictObject({
  userId: z.string().min(1).max(200),
  paymentMethod: z.enum(["WALLET", "GATEWAY"]),
  idempotencyKey: z.string().min(1).max(200),
  // NOTE: deliberately no monetary field — checkout is structurally unable to accept anything the client says about money.
  lines: z.array(z.strictObject({ variantId: z.string().uuid(), quantity: z.number().int().min(1).max(100) })).min(1).max(50),
});

export interface CheckoutResult { orderId: string; number: string; status: string; paymentMethod: PaymentMethod; total: number; expiresAt: Date; paymentId: string | null; redirectUrl?: string; replay: boolean }

/**
 * Create an order. ONE transaction: server-side quote (no client price exists), immutable snapshots, inventory reservation
 * (all-or-nothing — a shortage rolls back the whole order), INITIATED payment for gateway orders. Idempotent per (user, key):
 * the same request returns the same order and takes no more stock; a different request with the same key is IDEMPOTENCY_CONFLICT.
 * The gateway is contacted AFTER the commit. Supplier-backed variants have no stock to reserve (they are bought on payment).
 */
export async function checkout(deps: OrdersDeps, raw: unknown): Promise<CheckoutResult> {
  const p = checkoutInput.safeParse(raw);
  if (!p.success) throw new DomainError("ORDER_INVALID", `invalid checkout: ${p.error.issues.map((i) => `${i.path.join(".")}: ${i.code}`).join("; ")}`);
  const i = p.data;
  assertCheckoutConfigured(deps, i.paymentMethod);
  if (new Set(i.lines.map((l) => l.variantId)).size !== i.lines.length) throw new DomainError("ORDER_INVALID", "duplicate variant in order");
  const lines = [...i.lines].sort((a, b) => (a.variantId < b.variantId ? -1 : 1));
  const hash = createHash("sha256").update(JSON.stringify([i.paymentMethod, lines.map((l) => [l.variantId, l.quantity])])).digest();

  const res = await withTransaction(deps.db, async (tx): Promise<CheckoutResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`checkout:${i.userId}:${i.idempotencyKey}`}, 0))`);
    const ex = first<OrderRow & { request_hash: Buffer }>(await tx.execute(sql`select ${ORDER_COLS}, request_hash from orders where user_ref = ${i.userId} and idempotency_key = ${i.idempotencyKey}`));
    if (ex) {
      if (!Buffer.from(ex.request_hash).equals(hash)) throw new DomainError("IDEMPOTENCY_CONFLICT", "checkout key was used with different content");
      return { orderId: ex.id, number: ex.number, status: ex.status, paymentMethod: ex.payment_method, total: Number(ex.total), expiresAt: toDate(ex.expires_at), paymentId: ex.payment_id, replay: true };
    }
    const now = deps.clock.now();
    // P1-A: settings are read INSIDE this transaction, so the snapshot, the reservation and the order expiry all use the same version.
    const settings = await getOrderSettings(tx);
    const ttl = settings.values.reservationTtlSeconds;
    const refundPolicy = (await tx.execute(sql`select version from refund_policy_versions where active`)).rows[0] as { version: string } | undefined;
    if (!refundPolicy) throw new DomainError("ORDER_REFUND_POLICY_NOT_CONFIGURED", "no active refund policy version exists (B12): checkout is refused");
    const q = await quote(tx, lines, now);
    const snaps = await Promise.all(lines.map((l) => getVariantSnapshot(tx, l.variantId)));
    const orderId = uuidv7(deps.clock);
    const expiresAt = new Date(now.getTime() + ttl * 1000);
    const reservable = lines.filter((_, k) => snaps[k]!.fulfillmentMethod !== "SUPPLIER_API");
    let reservationId: string | null = null;
    if (reservable.length) {
      reservationId = (await reserve(tx, deps.clock, { reservationKey: `checkout:${orderId}`, orderRef: orderId, ttlSeconds: ttl, lines: reservable })).reservationId;
    }
    let payment: PaymentView | null = null;
    if (i.paymentMethod === "GATEWAY") {
      payment = (await initiatePayment(tx, deps.clock, { idempotencyKey: `orderpay:${orderId}`, purpose: "ORDER", orderRef: orderId, userRef: i.userId, gateway: deps.gateway.key, amount: q.subtotal })).payment;
    }
    const number = generateOrderNumber();
    const productTypes = [...new Set(snaps.map((s) => s!.productType))].sort();
    const policySnapshot = {
      schema: 1, backfilled: false, capturedAt: iso(now),
      refundPolicyVersion: refundPolicy.version,
      reservationTtlSeconds: ttl, orderSettingsVersion: settings.version,
      fulfillmentRules: await getFulfillmentCompatibility(tx, productTypes),
      itemFulfillmentMethods: [...new Set(snaps.map((s) => s!.fulfillmentMethod))].sort(),
    };
    await setTransitionContext(tx, { actorId: i.userId, reason: "checkout" });
    await tx.execute(
      sql`insert into orders (id, number, user_ref, status, payment_status, payment_method, currency, total, pricing_version, refund_policy_version, policy_snapshot, idempotency_key, request_hash, reservation_id, payment_id, expires_at, created_at, updated_at)
          values (${orderId}, ${number}, ${i.userId}, 'PENDING_PAYMENT', 'PENDING', ${i.paymentMethod}, 'IRR', ${q.subtotal}, ${q.pricingVersion}, ${refundPolicy.version}, ${JSON.stringify(policySnapshot)}::jsonb, ${i.idempotencyKey}, ${hash}, ${reservationId}, ${payment?.id ?? null}, ${iso(expiresAt)}::timestamptz, ${iso(now)}::timestamptz, ${iso(now)}::timestamptz)`,
    );
    for (let k = 0; k < lines.length; k++) {
      const l = q.lines[k]!;
      await tx.execute(sql`insert into order_items (id, order_id, line_no, variant_id, quantity, unit_price, line_total, snapshot, created_at) values (${uuidv7(deps.clock)}, ${orderId}, ${k + 1}, ${l.variantId}, ${l.quantity}, ${l.unitPrice}, ${l.lineTotal}, ${JSON.stringify({ ...snaps[k], onSale: l.onSale })}::jsonb, ${iso(now)}::timestamptz)`);
    }
    await enqueueOutbox(tx, { eventType: "order.created", aggregateType: "order", aggregateId: orderId, payload: { orderId } }, deps.clock);
    await recordAudit(tx, { actor: { type: "USER", id: i.userId }, action: "orders.order.created", entity: { type: "order", id: orderId }, metadata: { method: i.paymentMethod, total: q.subtotal, lines: lines.length }, occurredAt: now });
    return { orderId, number, status: "PENDING_PAYMENT", paymentMethod: i.paymentMethod, total: q.subtotal, expiresAt, paymentId: payment?.id ?? null, replay: false };
  });

  if (res.paymentId && !res.replay) {
    const started = await startGatewayPayment(deps.db, { gateway: deps.gateway, clock: deps.clock }, res.paymentId);
    if (started.status === "FAILED") {
      await cancelOrder(deps, { orderId: res.orderId, by: { type: "SYSTEM" }, reason: "gateway rejected the payment" });
      return { ...res, status: "CANCELLED" };
    }
    if ("redirectUrl" in started && started.redirectUrl) return { ...res, redirectUrl: started.redirectUrl };
  }
  return res;
}

/**
 * Pay a WALLET order. One transaction: expiry check, reservation CONSUMED (strictly before expiry — D9), D10 posting policy
 * (refuses while accounting is undecided and rolls the consume back with it), order PAID, tasks, delivery. An expired order is never paid
 * (the order expires instead and nothing is debited).
 */
export async function payOrderWithWallet(deps: OrdersDeps, input: { userId: string; orderId: string }): Promise<{ status: string }> {
  assertCheckoutConfigured(deps, "WALLET");
  return withTransaction(deps.db, async (tx) => {
    const o = first<OrderRow>(await tx.execute(sql`select ${ORDER_COLS} from orders where id = ${input.orderId} and user_ref = ${input.userId} for update`));
    if (!o) throw new DomainError("ORDER_NOT_FOUND", "order not found");
    if (o.payment_method !== "WALLET") throw new DomainError("ORDER_INVALID", "this order is not a wallet order");
    if (o.status !== "PENDING_PAYMENT") throw new DomainError("ORDER_INVALID", `order is ${o.status}`);
    const now = deps.clock.now();
    if (now.getTime() >= toDate(o.expires_at).getTime()) throw new DomainError("ORDER_EXPIRED", "the reservation has expired; the order can no longer be paid");
    if (o.reservation_id) {
      const c = await consume(tx, deps.clock, o.reservation_id);
      if (c.outcome !== "CONSUMED") throw new DomainError("ORDER_EXPIRED", "the reservation has expired; the order can no longer be paid");
    }
    await settleOrder(tx, deps, o, { fromSuspense: false, actorId: input.userId, paymentRef: `wallet:${o.id}` });
    return { status: "PAID" };
  }).catch(async (e: unknown) => {
    // An order whose reservation lapsed is expired by the normal expiry path, never silently kept payable.
    if (e instanceof DomainError && e.code === "ORDER_EXPIRED") await expireIfLapsed(deps, input.orderId);
    throw e;
  });
}

async function expireIfLapsed(deps: OrdersDeps, orderId: string): Promise<void> {
  await expireOrder(deps, orderId);
}

/**
 * Gateway callback / return: only a TRIGGER for server-to-server verification (payments.verifyPayment). The order becomes PAID only
 * inside the transaction that marks the payment SUCCEEDED, via the onSucceeded hook:
 *   PENDING_PAYMENT and before expiry and reservation CONSUMED  -> settle (D10 policy; refuses while undecided => nothing commits)
 *   anything else (expired / cancelled / reservation lapsed)    -> D9 late-payment path (suspense + hold; nothing consumed or delivered)
 * A verification that ends NEEDS_REVIEW (amount mismatch) puts the order on a PAYMENT_NEEDS_REVIEW hold; its resolution is blocked (B12/B13).
 */
export async function confirmGatewayPayment(deps: OrdersDeps, input: { gatewayRef: string; eventKey: string; raw?: unknown }): Promise<VerifyOutcome> {
  const out = await verifyPayment(deps.db, { gateway: deps.gateway, clock: deps.clock, ...(deps.verify ?? {}) }, input, { onSucceeded: (tx, payment) => onGatewayPaymentSucceeded(tx, deps, payment) });
  if (out.outcome === "NEEDS_REVIEW" || (out.outcome === "FINAL" && out.status === "NEEDS_REVIEW")) await holdForReview(deps, input.gatewayRef);
  return out;
}

async function onGatewayPaymentSucceeded(tx: Tx, deps: OrdersDeps, payment: PaymentView): Promise<void> {
  if (payment.purpose !== "ORDER" || !payment.orderRef) return; // wallet top-ups etc. are handled by their own owners
  const o = first<OrderRow>(await tx.execute(sql`select ${ORDER_COLS} from orders where id = ${payment.orderRef} for update`));
  if (!o || o.payment_id !== payment.id || o.user_ref !== payment.userRef || Number(o.total) !== payment.amount) throw new DomainError("ORDER_NOT_FOUND", "payment does not match an order");
  if (["PAID", "FULFILLING", "PARTIALLY_COMPLETED", "COMPLETED"].includes(o.status) || (o.status === "ON_HOLD" && o.payment_status === "SUCCEEDED")) return; // already settled (idempotent)
  const now = deps.clock.now();
  const fresh = o.status === "PENDING_PAYMENT" && now.getTime() < toDate(o.expires_at).getTime();
  if (fresh) {
    if (!o.reservation_id) return void (await settleOrder(tx, deps, o, { fromSuspense: false, actorId: SYSTEM.id, paymentRef: payment.id, gatewayKey: payment.gateway }));
    const c = await consume(tx, deps.clock, o.reservation_id);
    if (c.outcome === "CONSUMED") return void (await settleOrder(tx, deps, o, { fromSuspense: false, actorId: SYSTEM.id, paymentRef: payment.id, gatewayKey: payment.gateway }));
  }
  await handleLatePayment(tx, deps, o, payment.gateway, payment.id, payment.amount);
}

async function holdForReview(deps: OrdersDeps, gatewayRef: string): Promise<void> {
  const payment = await findPaymentByGatewayRef(deps.db, deps.gateway.key, gatewayRef);
  if (!payment?.orderRef) return;
  await withTransaction(deps.db, async (tx) => {
    const o = first<OrderRow>(await tx.execute(sql`select ${ORDER_COLS} from orders where id = ${payment.orderRef} for update`));
    if (!o || o.status !== "PENDING_PAYMENT") return;
    await moveOrder(tx, deps.clock, o.id, "ON_HOLD", SYSTEM.id, "payment needs review");
    await openHold(tx, deps.clock, o.id, "PAYMENT_NEEDS_REVIEW", SYSTEM.id);
    await recordAudit(tx, { actor: SYSTEM, action: "orders.order.payment_needs_review", entity: { type: "order", id: o.id }, occurredAt: deps.clock.now() });
  });
}
