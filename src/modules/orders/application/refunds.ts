import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import type { AuditActor } from "@/modules/audit";
import { cancelTasksForOrder, deliveryStatus, listTasksForOrder } from "@/modules/fulfillment";
import { ensureAccount, findTransactionByKey, post, reverse, suspenseToWallet, systemAccount, walletAccount } from "@/modules/ledger";
import { closeReviewedPayment, getPayment } from "@/modules/payments";
import type { Database, Tx } from "@/platform/db";
import { withTransaction } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { uuidv7 } from "@/platform/ids";
import { enqueueOutbox } from "@/platform/outbox";
import { setTransitionContext } from "@/platform/transitions";
import { evaluateRefundPolicy, worstDisclosure } from "../domain/refund-policy";
import type { DisclosureStateName, RefundDecision, RefundDestination, RefundExternalOutcome, RefundStatus } from "../domain/types";
import { ORDER_COLS, SYSTEM, first, iso, loadItems, moveOrder, unitRef } from "./core";
import type { OrderRow, OrdersDeps } from "./core";

/**
 * REFUNDS (Phase 2b-9). Every rule here is either read from the versioned policy tables (B12 placeholders 'temporary-0') or is a
 * fail-closed REFUND_BLOCKED. Nothing in this file chooses a revenue, cost or prepayment treatment (D10): money is only ever returned by
 *   (a) the EXACT MIRROR (ledger reversal) of the order's own settlement posting, or
 *   (b) the approved D9 suspense rules (suspense -> wallet, or reversal of the suspense posting).
 * Everything else (delivered items, partial refunds, gateway-paid -> wallet, missing settlement posting) is blocked.
 */
export interface RefundAdmin { actor: AuditActor; authorize(permission: string): Promise<void> }
export type RefundRequester = { type: "CUSTOMER"; userId: string } | ({ type: "ADMIN" } & RefundAdmin);

export interface RefundView {
  id: string; orderId: string; holdId: string | null; source: "ORDER_PAYMENT" | "SUSPENSE_RECEIPT"; amount: number; destination: RefundDestination;
  status: RefundStatus; decision: RefundDecision; policyVersion: string; externalOutcome: RefundExternalOutcome; attempts: number;
  requestedBy: string; decidedBy: string | null; ledgerTxnId: number | null; reasonCode: string;
}
const RCOLS = sql`id, order_id, hold_id, source, suspense_key, payment_id, requested_by, requester_type, reason_code, amount, destination, status, policy_version, decision, decided_by, override_reason, external_outcome, gateway_refund_ref, attempts, ledger_txn_id`;
interface RefundRow {
  id: string; order_id: string; hold_id: string | null; source: "ORDER_PAYMENT" | "SUSPENSE_RECEIPT"; suspense_key: string | null; payment_id: string | null; requested_by: string;
  requester_type: string; reason_code: string; amount: string | number; destination: RefundDestination; status: RefundStatus; policy_version: string; decision: RefundDecision;
  decided_by: string | null; override_reason: string | null; external_outcome: RefundExternalOutcome; gateway_refund_ref: string | null; attempts: number; ledger_txn_id: string | number | null;
}
const view = (r: RefundRow): RefundView => ({
  id: r.id, orderId: r.order_id, holdId: r.hold_id, source: r.source, amount: Number(r.amount), destination: r.destination, status: r.status, decision: r.decision, policyVersion: r.policy_version,
  externalOutcome: r.external_outcome, attempts: r.attempts, requestedBy: r.requested_by, decidedBy: r.decided_by, ledgerTxnId: r.ledger_txn_id === null ? null : Number(r.ledger_txn_id), reasonCode: r.reason_code,
});
const blocked = (m: string): DomainError => new DomainError("REFUND_BLOCKED", m);

export async function loadPolicy(tx: Tx | Database): Promise<{ version: string; rules: Map<DisclosureStateName, RefundDecision> }> {
  const v = first<{ version: string }>(await tx.execute(sql`select version from refund_policy_versions where active`));
  if (!v) throw blocked("no active refund policy version (B12)");
  const rules = new Map<DisclosureStateName, RefundDecision>();
  for (const r of (await tx.execute(sql`select disclosure_state, decision from refund_policy_rules where version = ${v.version}`)).rows as { disclosure_state: DisclosureStateName; decision: RefundDecision }[]) rules.set(r.disclosure_state, r.decision);
  return { version: v.version, rules };
}

const PAID_LIVE = ["PAID", "FULFILLING", "PARTIALLY_COMPLETED", "COMPLETED"];

/** Request a full-order refund. One live refund per order (DB-unique); an identical repeat returns the same refund. */
export async function requestRefund(deps: OrdersDeps, by: RefundRequester, input: { orderId: string; destination: RefundDestination; reasonCode: string; holdId?: string }): Promise<{ refund: RefundView; replay: boolean }> {
  if (!/^[A-Z_]{3,40}$/.test(input.reasonCode)) throw new DomainError("REFUND_INVALID", "reasonCode must be 3-40 upper-case letters/underscores");
  if (by.type === "ADMIN") await by.authorize("orders.refunds.request");
  const requestedBy = by.type === "CUSTOMER" ? by.userId : by.actor.id;
  const hash = createHash("sha256").update(JSON.stringify([input.orderId, input.holdId ?? null, input.destination, input.reasonCode])).digest("hex");
  return withTransaction(deps.db, async (tx) => {
    const o = first<OrderRow>(await tx.execute(sql`select ${ORDER_COLS} from orders where id = ${input.orderId} for update`));
    if (!o || (by.type === "CUSTOMER" && o.user_ref !== by.userId)) throw new DomainError("ORDER_NOT_FOUND", "order not found");
    const existing = first<RefundRow & { request_hash: string }>(await tx.execute(sql`select ${RCOLS}, encode(request_hash, 'hex') as request_hash from refunds where order_id = ${o.id} and status <> 'REJECTED'`));
    if (existing) {
      if (existing.request_hash === hash) return { refund: view(existing), replay: true };
      throw new DomainError("REFUND_INVALID", "a different refund is already open for this order");
    }
    const policy = await loadPolicy(tx);
    let source: "ORDER_PAYMENT" | "SUSPENSE_RECEIPT" = "ORDER_PAYMENT";
    let suspenseKey: string | null = null;
    let amount = Number(o.total);
    let states: { itemId: string; amount: number; state: DisclosureStateName }[] = [];
    let holdId: string | null = null;
    if (input.holdId) {
      const h = first<{ id: string; order_id: string; reason: string; resolved_at: unknown }>(await tx.execute(sql`select id, order_id, reason, resolved_at from order_holds where id = ${input.holdId} for update`));
      if (!h || h.order_id !== o.id) throw new DomainError("ORDER_NOT_FOUND", "hold not found for this order");
      if (h.resolved_at) throw new DomainError("REFUND_INVALID", "hold is already resolved");
      if (!o.payment_id) throw blocked("the hold has no gateway payment to refund");
      if (h.reason !== "LATE_PAYMENT_NO_RESERVATION" && h.reason !== "PAYMENT_NEEDS_REVIEW") throw blocked(`holds of type ${h.reason} have no refund path`);
      if (o.status !== "ON_HOLD") throw new DomainError("REFUND_INVALID", "order is not on hold");
      source = "SUSPENSE_RECEIPT";
      suspenseKey = `${h.reason === "LATE_PAYMENT_NO_RESERVATION" ? "late" : "payrecv"}:${o.payment_id}`;
      const parked = await findTransactionByKey(tx, suspenseKey);
      if (!parked) throw blocked("the received money is not parked in suspense; nothing safe to refund");
      amount = Math.max(...parked.entries.map((e) => Number(e.amount)));
      holdId = h.id;
    } else {
      if (!PAID_LIVE.includes(o.status) || o.payment_status !== "SUCCEEDED") throw new DomainError("REFUND_INVALID", `order is ${o.status}; only a paid order (or a payment hold) can be refunded`);
      if (o.payment_method !== input.destination) throw blocked(`a ${o.payment_method}-paid order can only be refunded to ${o.payment_method} (other conversions need the accountant's decision, D10)`);
      if (o.settlement_ledger_txn_id === null) throw blocked("the order has no settlement posting to reverse (D10 undecided)");
      for (const i of await loadItems(tx, o.id)) {
        const per: DisclosureStateName[] = [];
        for (let k = 1; k <= i.quantity; k++) per.push((await deliveryStatus(tx, unitRef(i.id, k))).state);
        const li = first<{ line_total: string }>(await tx.execute(sql`select line_total from order_items where id = ${i.id}`))!;
        states.push({ itemId: i.id, amount: Number(li.line_total), state: worstDisclosure(per) });
      }
    }
    if (source === "SUSPENSE_RECEIPT") states = [];
    if (input.destination === "GATEWAY" && !o.payment_id) throw blocked("this order has no gateway payment");
    const decision: RefundDecision = source === "SUSPENSE_RECEIPT" ? "ELIGIBLE" : evaluateRefundPolicy(policy.rules, states.map((s) => s.state));
    const id = uuidv7(deps.clock);
    const now = iso(deps.clock.now());
    await setTransitionContext(tx, { actorId: requestedBy, reason: "refund requested" });
    await tx.execute(sql`insert into refunds (id, order_id, hold_id, source, suspense_key, payment_id, requested_by, requester_type, reason_code, amount, destination, status, policy_version, eligibility_snapshot, decision, request_hash, created_at, updated_at)
      values (${id}, ${o.id}, ${holdId}, ${source}, ${suspenseKey}, ${o.payment_id}, ${requestedBy}, ${by.type}, ${input.reasonCode}, ${amount}, ${input.destination}, 'REQUESTED', ${policy.version},
              ${JSON.stringify({ policyVersion: policy.version, items: states, source })}::jsonb, ${decision}, decode(${hash}, 'hex'), ${now}::timestamptz, ${now}::timestamptz)`);
    for (const s of states) await tx.execute(sql`insert into refund_items (id, refund_id, order_item_id, amount, disclosure_state) values (${uuidv7(deps.clock)}, ${id}, ${s.itemId}, ${s.amount}, ${s.state})`);
    await recordAudit(tx, { actor: by.type === "CUSTOMER" ? { type: "USER", id: by.userId } : by.actor, action: "orders.refund.requested", entity: { type: "refund", id }, metadata: { orderId: o.id, amount, destination: input.destination, decision, source }, occurredAt: deps.clock.now() });
    const row = first<RefundRow>(await tx.execute(sql`select ${RCOLS} from refunds where id = ${id}`))!;
    return { refund: view(row), replay: false };
  });
}

/** Approve (four-eyes: never your own request; override for revealed items needs its own permission + written reason; DENIED can never be approved). */
export async function approveRefund(deps: OrdersDeps, admin: RefundAdmin, refundId: string, input: { note: string; overrideReason?: string }): Promise<RefundView> {
  await admin.authorize("orders.refunds.approve");
  if (input.note.trim().length < 10) throw new DomainError("REFUND_INVALID", "a note of at least 10 characters is required");
  return withTransaction(deps.db, async (tx) => {
    const r = first<RefundRow>(await tx.execute(sql`select ${RCOLS} from refunds where id = ${refundId} for update`));
    if (!r) throw new DomainError("REFUND_NOT_FOUND", "refund not found");
    if (r.status === "APPROVED" && r.decided_by === admin.actor.id) return view(r); // idempotent replay by the same approver
    if (r.status !== "REQUESTED") throw new DomainError("REFUND_INVALID", `refund is ${r.status}`);
    if (r.requested_by === admin.actor.id) throw new DomainError("REFUND_INVALID", "the requester cannot approve their own refund");
    if (r.decision === "DENIED") throw new DomainError("REFUND_INVALID", "the policy denies this refund");
    if (r.decision === "OVERRIDE_REQUIRED") {
      await admin.authorize("orders.refunds.override_revealed");
      if ((input.overrideReason ?? "").trim().length < 10) throw new DomainError("REFUND_INVALID", "an override reason of at least 10 characters is required for a revealed item");
    }
    await setTransitionContext(tx, { actorId: admin.actor.id, reason: "refund approved" });
    await tx.execute(sql`update refunds set status = 'APPROVED', decided_by = ${admin.actor.id}, decided_at = ${iso(deps.clock.now())}::timestamptz, decision_note = ${input.note.trim()}, override_reason = ${r.decision === "OVERRIDE_REQUIRED" ? input.overrideReason!.trim() : null}, updated_at = ${iso(deps.clock.now())}::timestamptz where id = ${refundId}`);
    await recordAudit(tx, { actor: admin.actor, action: "orders.refund.approved", entity: { type: "refund", id: refundId }, metadata: { decision: r.decision, override: r.decision === "OVERRIDE_REQUIRED" }, occurredAt: deps.clock.now() });
    return view(first<RefundRow>(await tx.execute(sql`select ${RCOLS} from refunds where id = ${refundId}`))!);
  });
}

export async function rejectRefund(deps: OrdersDeps, admin: RefundAdmin, refundId: string, input: { note: string }): Promise<RefundView> {
  await admin.authorize("orders.refunds.approve");
  if (input.note.trim().length < 10) throw new DomainError("REFUND_INVALID", "a note of at least 10 characters is required");
  return withTransaction(deps.db, async (tx) => {
    const r = first<RefundRow>(await tx.execute(sql`select ${RCOLS} from refunds where id = ${refundId} for update`));
    if (!r) throw new DomainError("REFUND_NOT_FOUND", "refund not found");
    if (r.status === "REJECTED") return view(r);
    if (r.status !== "REQUESTED") throw new DomainError("REFUND_INVALID", `refund is ${r.status}`);
    if (r.requested_by === admin.actor.id) throw new DomainError("REFUND_INVALID", "the requester cannot decide their own refund");
    await setTransitionContext(tx, { actorId: admin.actor.id, reason: "refund rejected" });
    await tx.execute(sql`update refunds set status = 'REJECTED', decided_by = ${admin.actor.id}, decided_at = ${iso(deps.clock.now())}::timestamptz, decision_note = ${input.note.trim()}, updated_at = ${iso(deps.clock.now())}::timestamptz where id = ${refundId}`);
    await recordAudit(tx, { actor: admin.actor, action: "orders.refund.rejected", entity: { type: "refund", id: refundId }, occurredAt: deps.clock.now() });
    return view(first<RefundRow>(await tx.execute(sql`select ${RCOLS} from refunds where id = ${refundId}`))!);
  });
}

/** Everything that would make execution unsafe or unapproved. Throws REFUND_BLOCKED BEFORE any state change or external call. */
async function assertExecutable(tx: Tx, deps: OrdersDeps, r: RefundRow, o: OrderRow): Promise<void> {
  if (r.source === "ORDER_PAYMENT") {
    if (!PAID_LIVE.includes(o.status)) throw new DomainError("REFUND_INVALID", `order is ${o.status}`);
    if (o.settlement_ledger_txn_id === null) throw blocked("the order has no settlement posting to reverse (D10 undecided)");
    const undelivered = (await tx.execute(sql`select count(*)::int c from refund_items where refund_id = ${r.id} and disclosure_state <> 'NOT_DELIVERED'`)).rows[0] as { c: number };
    // Re-check live: an item may have been delivered after the request.
    let delivered = undelivered.c;
    for (const i of await loadItems(tx, o.id)) for (let k = 1; k <= i.quantity; k++) if ((await deliveryStatus(tx, unitRef(i.id, k))).state !== "NOT_DELIVERED") delivered++;
    if (delivered > 0) throw blocked("refunding delivered items needs the accountant's decision on revenue/cost treatment and code voiding (D10); not approved");
    for (const t of await listTasksForOrder(tx, o.id)) if (t.supplierOrderId && t.status !== "CANCELLED") throw blocked("a supplier order is outstanding for this order; it must be reconciled first");
  } else if (o.status !== "ON_HOLD") throw new DomainError("REFUND_INVALID", `order is ${o.status}`);
  if (r.destination === "GATEWAY") {
    if (!deps.gateway.capabilities?.refund || !deps.gateway.refundPayment || !deps.gateway.verifyRefund) throw blocked("the configured payment gateway has no verified refund capability (X1)");
    if (!r.payment_id) throw blocked("no gateway payment to refund");
  }
}

export type RefundExecResult = { status: RefundStatus; outcome: RefundExternalOutcome; replay: boolean };

export async function executeRefund(deps: OrdersDeps, admin: RefundAdmin, refundId: string): Promise<RefundExecResult> {
  await admin.authorize("orders.refunds.execute");
  // Phase 1 (tx): validate, move to PROCESSING.
  const prep = await withTransaction(deps.db, async (tx) => {
    const r = first<RefundRow>(await tx.execute(sql`select ${RCOLS} from refunds where id = ${refundId} for update`));
    if (!r) throw new DomainError("REFUND_NOT_FOUND", "refund not found");
    if (r.status === "COMPLETED") return { done: true as const, replay: true, r };
    if (!["APPROVED", "FAILED", "PROCESSING"].includes(r.status)) throw new DomainError("REFUND_INVALID", `refund is ${r.status}; it must be approved first`);
    const o = first<OrderRow>(await tx.execute(sql`select ${ORDER_COLS} from orders where id = ${r.order_id} for update`))!;
    await assertExecutable(tx, deps, r, o);
    if (r.destination === "WALLET") { // single transaction: no external party
      await finalize(tx, deps, r, o, admin.actor);
      return { done: true as const, replay: false, r };
    }
    if (r.status !== "PROCESSING") {
      await setTransitionContext(tx, { actorId: admin.actor.id, reason: "refund execution started" });
      await tx.execute(sql`update refunds set status = 'PROCESSING', attempts = attempts + 1, updated_at = ${iso(deps.clock.now())}::timestamptz where id = ${refundId}`);
    }
    // The executor that moves NONE/REJECTED -> UNKNOWN (under the row lock) is the ONLY one that may send: the intent is committed BEFORE the
    // call, so a crash or a concurrent executor sees UNKNOWN (the request may exist) and can only verify.
    const send = r.external_outcome === "NONE" || r.external_outcome === "REJECTED";
    if (send) await tx.execute(sql`update refunds set external_outcome = 'UNKNOWN' where id = ${refundId}`);
    return { done: false as const, r, send };
  });
  if (prep.done) return { status: "COMPLETED", outcome: prep.r.external_outcome, replay: prep.replay };

  const r = prep.r;
  const gw = deps.gateway;
  const pay = await getPayment(deps.db, r.payment_id!);
  if (!pay?.gatewayRef) throw blocked("the payment has no gateway reference to refund against");

  // Phase 2 (NO transaction): talk to the gateway.
  let outcome: RefundExternalOutcome = prep.send ? "UNKNOWN" : r.external_outcome;
  let ref = r.gateway_refund_ref;
  // Never blindly resend: only the executor that committed the send intent, or — for an idempotent gateway — a repeat of an UNKNOWN one.
  const mayResend = prep.send || (outcome === "UNKNOWN" && gw.capabilities?.refundIdempotent === true);
  if (mayResend) {
    try {
      const res = await gw.refundPayment!({ refundId, gatewayRef: pay.gatewayRef, amount: Number(r.amount) as never });
      if (res.status === "REJECTED") { outcome = "REJECTED"; } else { outcome = "ACCEPTED"; ref = res.refundRef ?? ref; } // ACCEPTED is NOT completion
    } catch { outcome = "UNKNOWN"; } // timeout / transport error: the refund may exist
  }
  let confirmed = outcome === "CONFIRMED";
  if (outcome === "ACCEPTED" || outcome === "UNKNOWN") {
    try {
      const v = await gw.verifyRefund!({ refundId, gatewayRef: pay.gatewayRef, ...(ref ? { refundRef: ref } : {}) });
      if (v.status === "REFUNDED") { if (v.amount === Number(r.amount)) { outcome = "CONFIRMED"; confirmed = true; } else outcome = "UNKNOWN"; }
      else if (v.status === "FAILED") outcome = "REJECTED";
      else outcome = outcome === "UNKNOWN" && v.status === "UNKNOWN" ? "UNKNOWN" : "ACCEPTED";
      if (v.status === "REFUNDED" && !confirmed) await auditOnly(deps, "orders.refund.amount_mismatch", refundId, { expected: Number(r.amount), reported: v.amount ?? null });
    } catch { /* verification unreachable: stay unresolved */ }
  }

  // Phase 3 (tx): record the outcome.
  await withTransaction(deps.db, async (tx) => {
    const cur = first<RefundRow>(await tx.execute(sql`select ${RCOLS} from refunds where id = ${refundId} for update`))!;
    if (cur.status === "COMPLETED") return;
    if (cur.status !== "PROCESSING") return;
    // Never regress a stronger fact recorded by a concurrent executor (CONFIRMED > ACCEPTED > UNKNOWN).
    if (cur.external_outcome === "CONFIRMED" || (outcome === "UNKNOWN" && cur.external_outcome === "ACCEPTED")) outcome = cur.external_outcome;
    const rejected = outcome === "REJECTED";
    if (rejected) { await setTransitionContext(tx, { actorId: admin.actor.id, reason: "gateway refund failed" }); }
    await tx.execute(sql`update refunds set external_outcome = ${outcome}, gateway_refund_ref = coalesce(gateway_refund_ref, ${ref}), ${rejected ? sql`status = 'FAILED',` : sql``} updated_at = ${iso(deps.clock.now())}::timestamptz where id = ${refundId}`);
    await recordAudit(tx, { actor: admin.actor, action: "orders.refund.gateway_outcome", entity: { type: "refund", id: refundId }, metadata: { outcome, attempt: cur.attempts }, occurredAt: deps.clock.now() });
  });
  if (!confirmed) return { status: outcome === "REJECTED" ? "FAILED" : "PROCESSING", outcome, replay: false };

  // Phase 4 (tx): finalize ONLY after a verified refund of the exact amount.
  await withTransaction(deps.db, async (tx) => {
    const cur = first<RefundRow>(await tx.execute(sql`select ${RCOLS} from refunds where id = ${refundId} for update`))!;
    if (cur.status === "COMPLETED") return;
    const o = first<OrderRow>(await tx.execute(sql`select ${ORDER_COLS} from orders where id = ${cur.order_id} for update`))!;
    await finalize(tx, deps, cur, o, admin.actor);
  });
  return { status: "COMPLETED", outcome: "CONFIRMED", replay: false };
}

async function auditOnly(deps: OrdersDeps, action: string, refundId: string, metadata: Record<string, unknown>): Promise<void> {
  await withTransaction(deps.db, (tx) => recordAudit(tx, { actor: SYSTEM, action, entity: { type: "refund", id: refundId }, metadata, occurredAt: deps.clock.now() }));
}

/** Ledger + completion + order consequences in ONE transaction (any failure rolls all of it back). */
async function finalize(tx: Tx, deps: OrdersDeps, r: RefundRow, o: OrderRow, actor: AuditActor): Promise<void> {
  const now = deps.clock.now();
  const reason = `refund ${r.id}: ${r.reason_code}`;
  let txnId: number;
  if (r.source === "ORDER_PAYMENT") {
    txnId = (await reverse(tx, { originalTransactionId: Number(o.settlement_ledger_txn_id), idempotencyKey: `refund:${r.id}`, reason, actor }, { clock: deps.clock })).transactionId;
  } else if (r.destination === "WALLET") {
    await ensureAccount(tx, systemAccount("SUSPENSE_UNRESOLVED_RECEIPTS"), actor, { clock: deps.clock });
    await ensureAccount(tx, walletAccount(o.user_ref), actor, { clock: deps.clock });
    txnId = (await post(tx, { kind: "SUSPENSE_RESOLUTION", idempotencyKey: `refund:${r.id}`, reference: { type: "refund", id: r.id }, entries: suspenseToWallet({ userId: o.user_ref, amount: Number(r.amount) }), description: "suspense -> wallet (D9)", actor }, { clock: deps.clock })).transactionId;
  } else {
    const parked = await findTransactionByKey(tx, r.suspense_key!);
    if (!parked) throw blocked("the parked suspense posting disappeared");
    txnId = (await reverse(tx, { originalTransactionId: parked.id, idempotencyKey: `refund:${r.id}`, reason, actor }, { clock: deps.clock })).transactionId;
  }
  if (r.status !== "PROCESSING") { await setTransitionContext(tx, { actorId: actor.id, reason: "refund execution started" }); await tx.execute(sql`update refunds set status = 'PROCESSING', attempts = attempts + 1 where id = ${r.id}`); }
  await setTransitionContext(tx, { actorId: actor.id, reason: "refund completed" });
  await tx.execute(sql`update refunds set status = 'COMPLETED', ledger_txn_id = ${txnId}, completed_at = ${iso(now)}::timestamptz, updated_at = ${iso(now)}::timestamptz where id = ${r.id}`);

  if (r.source === "ORDER_PAYMENT") {
    const c = await cancelTasksForOrder(tx, deps.clock, o.id, actor.id, "order refunded");
    if (c.blocked > 0) throw blocked("a task is already completed; the order cannot be cancelled by refund");
  }
  await moveOrder(tx, deps.clock, o.id, "CANCELLED", actor.id, `refunded (${r.id})`);
  if (r.hold_id) {
    await setTransitionContext(tx, { actorId: actor.id, reason: "hold resolved by refund" });
    await tx.execute(sql`update order_holds set resolved_at = ${iso(now)}::timestamptz, resolved_by = ${actor.id}, resolution = ${r.destination === "WALLET" ? "REFUND_WALLET" : "REFUND_GATEWAY"}, note = ${`refund ${r.id}`} where id = ${r.hold_id} and resolved_at is null`);
    if (r.suspense_key?.startsWith("payrecv:") && r.payment_id) await closeReviewedPayment(tx, deps.clock, r.payment_id, `refund ${r.id} completed`);
  }
  await enqueueOutbox(tx, { eventType: "order.refunded", aggregateType: "order", aggregateId: o.id, payload: { orderId: o.id, refundId: r.id, amount: Number(r.amount), destination: r.destination } }, deps.clock);
  await recordAudit(tx, { actor, action: "orders.refund.completed", entity: { type: "refund", id: r.id }, metadata: { orderId: o.id, amount: Number(r.amount), destination: r.destination, ledgerTxnId: txnId }, occurredAt: now });
}

export async function getRefund(c: { db: Database; authorize(permission: string): Promise<void> }, refundId: string): Promise<RefundView> {
  await c.authorize("orders.refunds.read");
  const r = first<RefundRow>(await c.db.execute(sql`select ${RCOLS} from refunds where id = ${refundId}`));
  if (!r) throw new DomainError("REFUND_NOT_FOUND", "refund not found");
  return view(r);
}

export async function listRefunds(c: { db: Database; authorize(permission: string): Promise<void> }, filter: { statuses?: RefundStatus[]; limit?: number } = {}): Promise<RefundView[]> {
  await c.authorize("orders.refunds.read");
  const st = filter.statuses?.length ? sql`and status in (${sql.join(filter.statuses.map((s) => sql`${s}`), sql`, `)})` : sql``;
  const rows = (await c.db.execute(sql`select ${RCOLS} from refunds where true ${st} order by created_at desc limit ${Math.min(filter.limit ?? 50, 200)}`)).rows as unknown as RefundRow[];
  return rows.map(view);
}
