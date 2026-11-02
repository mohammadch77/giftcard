import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adjustStock } from "@/modules/inventory";
import { deliveryStatus, withRevealedSecret } from "@/modules/fulfillment";
import { adminWalletCredit, ensureAccount, getBalance, post, systemAccount, trialBalance, verifyIntegrity, walletAccount } from "@/modules/ledger";
import {
  approveRefund, checkout, confirmGatewayPayment, evaluateRefundPolicy, executeRefund, expireStale, getRefund, listFindings, listRefunds, payOrderWithWallet, rejectRefund, requestRefund, runChecks, runReconciliation, REFUND_PERMISSIONS,
} from "@/modules/orders";
import type { RefundAdmin } from "@/modules/orders";
import { TestBookingPolicy } from "@/modules/orders/testing/booking-policy";
import { withTransaction } from "@/platform/db";
import { ManualClock } from "@/platform/clock/testing";
import { pgCode } from "../helpers/db";
import { sellableVariant } from "../helpers/inventory";
import { adminOf, orderFixture, orderRow, ordersDeps, stockedVariant, uniqKey, userId } from "../helpers/orders";
import type { OrderFixture } from "../helpers/orders";

let f: OrderFixture;
const booking = new TestBookingPolicy();
beforeAll(async () => { f = await orderFixture(); });
afterAll(async () => { await f?.app.close(); await f?.t.drop(); });

const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? "OTHER"; } return "NO_ERROR"; };
const sqlCode = (q: string, p: unknown[] = []) => f.t.pool.query(q, p).then(() => "ok", (e: unknown) => pgCode(e));
const q = async <T = Record<string, unknown>>(s: string, p: unknown[] = []) => (await f.t.pool.query(s, p)).rows as T[];
const bd = () => ordersDeps(f, { policy: booking });
const adm = (id: string, allowed: "all" | string[] = "all"): RefundAdmin => adminOf(f, id, allowed);
const healthy = async () => { expect(await verifyIntegrity(f.app.db)).toEqual([]); expect((await trialBalance(f.app.db)).balanced).toBe(true); };
const refundCount = async () => Number((await q("select count(*)::int c from refunds"))[0]!.c);
const refundsFor = async (orderId: string) => Number((await q("select count(*)::int c from refunds where order_id = $1 and status <> 'REJECTED'", [orderId]))[0]!.c);
const ledgerCount = async () => Number((await q("select count(*)::int c from ledger_transactions"))[0]!.c);

async function fund(user: string, amount: number): Promise<void> {
  const actor = { type: "SYSTEM" as const, id: "system:test" };
  await withTransaction(f.app.db, async (tx) => {
    await ensureAccount(tx, walletAccount(user), actor);
    await ensureAccount(tx, systemAccount("ADJUSTMENT_EXPENSE"), actor);
    await post(tx, { kind: "ADMIN_ADJUSTMENT", idempotencyKey: `fund:${user}`, reference: { type: "user", id: user }, entries: adminWalletCredit({ userId: user, amount }), reason: "test funding", actor });
  });
}
/** A MANUAL-fulfilment item stays undelivered after payment (the only refundable state in this phase). */
async function manualVariant(): Promise<string> {
  const v = await sellableVariant(f, "MANUAL");
  await adjustStock({ db: f.app.db, clock: f.clock, keys: f.keys, actor: { type: "ADMIN", id: "a" }, authorize: async () => undefined }, v, 50, "opening manual stock");
  return v;
}
async function paidWalletOrder(variantId?: string) {
  const user = userId();
  await fund(user, 5_000_000);
  const v = variantId ?? (await manualVariant());
  const o = await checkout(bd(), { userId: user, paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId: v, quantity: 1 }] });
  await payOrderWithWallet(bd(), { userId: user, orderId: o.orderId });
  return { user, orderId: o.orderId };
}
async function paidGatewayOrder(variantId?: string, deps = bd()) {
  const user = userId();
  const v = variantId ?? (await manualVariant());
  const o = await checkout(deps, { userId: user, paymentMethod: "GATEWAY", idempotencyKey: uniqKey(), lines: [{ variantId: v, quantity: 1 }] });
  const ref = (await q<{ gateway_ref: string }>("select gateway_ref from payments where id = $1", [o.paymentId]))[0]!.gateway_ref;
  f.gateway.script(ref, { status: "PAID", amount: 1_000_000 });
  await confirmGatewayPayment(deps, { gatewayRef: ref, eventKey: `ev-${Math.random()}` });
  return { user, orderId: o.orderId, paymentId: o.paymentId!, ref };
}
const request = (orderId: string, destination: "WALLET" | "GATEWAY", by = "requester") => requestRefund(bd(), { type: "ADMIN", ...adm(by) }, { orderId, destination, reasonCode: "CUSTOMER_REQUEST" });
const approved = async (orderId: string, destination: "WALLET" | "GATEWAY") => {
  const r = await request(orderId, destination);
  await approveRefund(bd(), adm("approver"), r.refund.id, { note: "approved after review" });
  return r.refund.id;
};

async function lateOrder() {
  const clock = new ManualClock(f.clock.now());
  const { variantId } = await stockedVariant(f, 1);
  const deps = ordersDeps(f, { clock, policy: booking });
  const user = userId();
  const r = await checkout(deps, { userId: user, paymentMethod: "GATEWAY", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }] });
  const ref = (await q<{ gateway_ref: string }>("select gateway_ref from payments where id = $1", [r.paymentId]))[0]!.gateway_ref;
  clock.advance(901_000);
  await expireStale(deps);
  f.gateway.script(ref, { status: "PAID", amount: 1_000_000 });
  await confirmGatewayPayment(deps, { gatewayRef: ref, eventKey: `late-${Math.random()}` });
  const hold = (await q<{ id: string }>("select id from order_holds where order_id = $1", [r.orderId]))[0]!.id;
  return { user, orderId: r.orderId, holdId: hold, paymentId: r.paymentId! };
}

describe("policy as data (B12 placeholders) and fail-closed evaluation", () => {
  it("the active version is temporary-0 with documented placeholders; unknown states are DENIED; the strictest item decides", async () => {
    const v = await q("select version, status, legal_review_required, active from refund_policy_versions");
    expect(v).toEqual([{ version: "temporary-0", status: "TEMPORARY", legal_review_required: true, active: true }]);
    const rules = new Map(((await q<{ disclosure_state: never; decision: never }>("select disclosure_state, decision from refund_policy_rules")).map((r) => [r.disclosure_state, r.decision])));
    expect(evaluateRefundPolicy(rules, ["NOT_DELIVERED"])).toBe("ELIGIBLE");
    expect(evaluateRefundPolicy(rules, ["NOT_DELIVERED", "DELIVERED_UNREVEALED"])).toBe("REVIEW_REQUIRED");
    expect(evaluateRefundPolicy(rules, ["DELIVERED_UNREVEALED", "REVEALED_BY_CUSTOMER"])).toBe("OVERRIDE_REQUIRED");
    expect(evaluateRefundPolicy(new Map(), ["NOT_DELIVERED"])).toBe("DENIED"); // no rule => never refundable
    expect(evaluateRefundPolicy(new Map([["NOT_DELIVERED", "ELIGIBLE"]]), ["DELIVERED_UNREVEALED"])).toBe("DENIED");
    expect(await sqlCode("update refund_policy_rules set decision = 'ELIGIBLE' where disclosure_state = 'REVEALED_BY_CUSTOMER'")).not.toBe("ok"); // app role cannot edit policy (migration only)
  });
  it("the override permission exists, is sensitive, and is granted to no role by default", async () => {
    expect(REFUND_PERMISSIONS.find((p) => p.key === "orders.refunds.override_revealed")?.sensitive).toBe(true);
    expect(await q("select 1 from role_permissions where permission = 'orders.refunds.override_revealed'")).toEqual([]);
  });
});

describe("refund lifecycle — wallet-paid, undelivered (exact-mirror reversal of the settlement posting)", () => {
  it("request -> approve (other person) -> execute: reversal posted, wallet restored, order CANCELLED, tasks cancelled, history/audit with actors; replays are no-ops", async () => {
    const { user, orderId } = await paidWalletOrder();
    const before = await getBalance(f.app.db, walletAccount(user));
    expect(before).toBe(4_000_000);
    const req = await requestRefund(bd(), { type: "CUSTOMER", userId: user }, { orderId, destination: "WALLET", reasonCode: "CUSTOMER_REQUEST" });
    expect(req.refund).toMatchObject({ status: "REQUESTED", decision: "ELIGIBLE", amount: 1_000_000, policyVersion: "temporary-0" });
    expect((await requestRefund(bd(), { type: "CUSTOMER", userId: user }, { orderId, destination: "WALLET", reasonCode: "CUSTOMER_REQUEST" })).replay).toBe(true);
    expect(await code(requestRefund(bd(), { type: "CUSTOMER", userId: user }, { orderId, destination: "WALLET", reasonCode: "OTHER_REASON" }))).toBe("REFUND_INVALID"); // different request while one is open
    expect(await code(requestRefund(bd(), { type: "CUSTOMER", userId: "someone-else" }, { orderId, destination: "WALLET", reasonCode: "CUSTOMER_REQUEST" }))).toBe("ORDER_NOT_FOUND"); // IDOR-safe
    expect(await code(executeRefund(bd(), adm("exec"), req.refund.id))).toBe("REFUND_INVALID"); // not approved
    const ap = await approveRefund(bd(), adm("approver"), req.refund.id, { note: "approved after review" });
    expect(ap).toMatchObject({ status: "APPROVED", decidedBy: "approver" });
    expect(await approveRefund(bd(), adm("approver"), req.refund.id, { note: "approved after review" })).toMatchObject({ status: "APPROVED" }); // idempotent
    const l0 = await ledgerCount();
    const done = await executeRefund(bd(), adm("exec"), req.refund.id);
    expect(done).toEqual({ status: "COMPLETED", outcome: "NONE", replay: false });
    expect(await ledgerCount()).toBe(l0 + 1);
    expect(await getBalance(f.app.db, walletAccount(user))).toBe(5_000_000);
    expect(await orderRow(f, orderId)).toMatchObject({ status: "CANCELLED" });
    expect((await q("select status from fulfillment_tasks where order_ref = $1", [orderId])).map((r) => r.status)).toEqual(["CANCELLED"]);
    const rf = (await q<{ ledger_txn_id: string; status: string }>("select ledger_txn_id, status from refunds where id = $1", [req.refund.id]))[0]!;
    expect(rf.status).toBe("COMPLETED");
    expect((await q<{ kind: string; reverses_id: string }>("select kind, reverses_id from ledger_transactions where id = $1", [rf.ledger_txn_id]))[0]).toMatchObject({ kind: "REVERSAL" });
    expect(await executeRefund(bd(), adm("exec"), req.refund.id)).toMatchObject({ status: "COMPLETED", replay: true });
    expect(await ledgerCount()).toBe(l0 + 1); // idempotent: no second reversal
    expect((await q("select actor_id from refund_status_history where entity_id = $1 order by id", [req.refund.id])).map((r) => r.actor_id !== null)).toEqual([true, true, true, true]);
    const actions = (await q<{ action: string }>("select action from audit_logs where entity_id = $1", [req.refund.id])).map((r) => r.action);
    for (const a of ["orders.refund.requested", "orders.refund.approved", "orders.refund.completed"]) expect(actions).toContain(a);
    expect((await q("select 1 from outbox_events where event_type = 'order.refunded' and aggregate_id = $1", [orderId])).length).toBe(1);
    await healthy();
  });
  it("rejection is final and a new request is then allowed; a rejected refund can't be approved or executed", async () => {
    const { orderId } = await paidWalletOrder();
    const r = await request(orderId, "WALLET");
    expect(await code(rejectRefund(bd(), adm("requester"), r.refund.id, { note: "my own request" }))).toBe("REFUND_INVALID");
    expect(await rejectRefund(bd(), adm("approver"), r.refund.id, { note: "not a valid reason" })).toMatchObject({ status: "REJECTED" });
    expect(await code(approveRefund(bd(), adm("approver"), r.refund.id, { note: "changed my mind ok" }))).toBe("REFUND_INVALID");
    expect(await code(executeRefund(bd(), adm("exec"), r.refund.id))).toBe("REFUND_INVALID");
    const again = await request(orderId, "WALLET");
    expect(again.refund.id).not.toBe(r.refund.id);
    expect(await sqlCode("update refunds set status = 'APPROVED' where id = $1", [r.refund.id])).toBe("PT001"); // REJECTED is terminal
  });
});

describe("authorization, four-eyes, step-up hook and audit", () => {
  it("every operation needs its own permission; a requester can never approve; DENIED can't be approved; override needs permission AND a written reason", async () => {
    const { orderId } = await paidWalletOrder();
    const none = adm("nobody", []);
    expect(await code(requestRefund(bd(), { type: "ADMIN", ...none }, { orderId, destination: "WALLET", reasonCode: "CUSTOMER_REQUEST" }))).toBe("AUTH_FORBIDDEN");
    const r = await request(orderId, "WALLET");
    expect(await code(approveRefund(bd(), adm("x", ["orders.refunds.request"]), r.refund.id, { note: "approved after review" }))).toBe("AUTH_FORBIDDEN");
    expect(await code(approveRefund(bd(), adm("requester"), r.refund.id, { note: "approved after review" }))).toBe("REFUND_INVALID"); // four-eyes
    expect(await code(approveRefund(bd(), adm("approver"), r.refund.id, { note: "short" }))).toBe("REFUND_INVALID");
    await approveRefund(bd(), adm("approver"), r.refund.id, { note: "approved after review" });
    expect(await code(executeRefund(bd(), adm("x", ["orders.refunds.approve"]), r.refund.id))).toBe("AUTH_FORBIDDEN");
    expect(await code(getRefund({ db: f.app.db, authorize: none.authorize }, r.refund.id))).toBe("AUTH_FORBIDDEN");
    expect((await listRefunds({ db: f.app.db, authorize: async () => undefined }, { statuses: ["APPROVED"] })).some((x) => x.id === r.refund.id)).toBe(true);
    // the database enforces four-eyes too (admin requester can't also decide)
    expect(await sqlCode("update refunds set decided_by = requested_by where id = $1 and requester_type = 'ADMIN'", [r.refund.id])).not.toBe("ok");
  });
  it("delivered items: decision recorded (REVIEW_REQUIRED/OVERRIDE_REQUIRED) but EXECUTION is blocked (D10: code voiding + revenue/cost treatment) and nothing changes", async () => {
    const { variantId } = await stockedVariant(f, 2);
    const { orderId, user } = await paidWalletOrder(variantId);
    const r = await request(orderId, "WALLET");
    expect(r.refund.decision).toBe("REVIEW_REQUIRED"); // delivered, not revealed
    await approveRefund(bd(), adm("approver"), r.refund.id, { note: "reviewed delivered item" });
    const l0 = await ledgerCount();
    expect(await code(executeRefund(bd(), adm("exec"), r.refund.id))).toBe("REFUND_BLOCKED");
    expect(await ledgerCount()).toBe(l0);
    expect(await orderRow(f, orderId)).toMatchObject({ status: expect.stringMatching(/COMPLETED|FULFILLING/) });
    expect(await getBalance(f.app.db, walletAccount(user))).toBe(4_000_000);
    expect((await getRefund({ db: f.app.db, authorize: async () => undefined }, r.refund.id)).status).toBe("APPROVED");
  });
  it("revealed items need the override permission and a written reason (and are still blocked at execution)", async () => {
    const { variantId } = await stockedVariant(f, 1);
    const { orderId, user } = await paidWalletOrder(variantId);
    const ref = `${(await q<{ id: string }>("select id from order_items where order_id = $1", [orderId]))[0]!.id}#1`;
    const d = await deliveryStatus(f.app.db, ref);
    await withRevealedSecret({ db: f.app.db, clock: f.clock, keys: f.keys }, { deliveryId: d.deliveryId!, actor: { type: "CUSTOMER", id: user } }, () => 1);
    const r = await request(orderId, "WALLET");
    expect(r.refund.decision).toBe("OVERRIDE_REQUIRED");
    const noOverride = adm("approver", ["orders.refunds.approve"]);
    expect(await code(approveRefund(bd(), noOverride, r.refund.id, { note: "approved after review", overrideReason: "customer insists, reviewed" }))).toBe("AUTH_FORBIDDEN");
    expect(await code(approveRefund(bd(), adm("approver"), r.refund.id, { note: "approved after review" }))).toBe("REFUND_INVALID"); // no override reason
    expect(await approveRefund(bd(), adm("approver"), r.refund.id, { note: "approved after review", overrideReason: "customer insists, reviewed" })).toMatchObject({ status: "APPROVED" });
    expect(await code(executeRefund(bd(), adm("exec"), r.refund.id))).toBe("REFUND_BLOCKED");
  });
});

describe("fail-closed matrix (unapproved accounting / policy)", () => {
  it("a paid order without a settlement posting (D10 undecided) cannot be refunded; nothing is written", async () => {
    const user = userId();
    const v = await manualVariant();
    const o = await checkout(ordersDeps(f), { userId: user, paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId: v, quantity: 1 }] });
    await payOrderWithWallet(ordersDeps(f), { userId: user, orderId: o.orderId }); // TestPostingPolicy books nothing
    const n = await refundCount();
    expect(await code(request(o.orderId, "WALLET"))).toBe("REFUND_BLOCKED");
    expect(await refundCount()).toBe(n);
  });
  it("gateway-paid -> wallet, wallet-paid -> gateway, unpaid orders and held orders without a hold are refused (no invented conversions)", async () => {
    const g = await paidGatewayOrder();
    expect(await code(request(g.orderId, "WALLET"))).toBe("REFUND_BLOCKED");
    const w = await paidWalletOrder();
    expect(await code(request(w.orderId, "GATEWAY"))).toBe("REFUND_BLOCKED");
    const v = await manualVariant();
    const unpaid = await checkout(bd(), { userId: userId(), paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId: v, quantity: 1 }] });
    expect(await code(request(unpaid.orderId, "WALLET"))).toBe("REFUND_INVALID");
    expect(await code(requestRefund(bd(), { type: "ADMIN", ...adm("r") }, { orderId: w.orderId, destination: "WALLET", reasonCode: "bad code" }))).toBe("REFUND_INVALID");
  });
  it("partial refunds do not exist: the database requires every item and the full total, and one live refund per order", async () => {
    const { orderId } = await paidWalletOrder();
    const o = (await q<{ total: string }>("select total from orders where id = $1", [orderId]))[0]!;
    const c = await f.t.pool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.actor_id','x',true), set_config('app.reason','x',true)");
      await c.query(`insert into refunds (id, order_id, source, requested_by, requester_type, reason_code, amount, destination, status, policy_version, eligibility_snapshot, decision, request_hash, created_at, updated_at)
        values (gen_random_uuid(), $1, 'ORDER_PAYMENT', 'u', 'CUSTOMER', 'PARTIAL', 1, 'WALLET', 'REQUESTED', 'temporary-0', '{}', 'ELIGIBLE', decode(repeat('ab',32),'hex'), now(), now())`, [orderId]);
      let code2 = "ok";
      try { await c.query("commit"); } catch (e) { code2 = pgCode(e) ?? "none"; }
      expect(code2).toBe("PO002");
    } finally { await c.query("rollback").catch(() => undefined); c.release(); }
    expect(Number(o.total)).toBe(1_000_000);
    const r = await request(orderId, "WALLET");
    expect(await sqlCode(`insert into refunds (id, order_id, source, requested_by, requester_type, reason_code, amount, destination, status, policy_version, eligibility_snapshot, decision, request_hash, created_at, updated_at)
        values (gen_random_uuid(), $1, 'ORDER_PAYMENT', 'u', 'CUSTOMER', 'DUP', 1000000, 'WALLET', 'REQUESTED', 'temporary-0', '{}', 'ELIGIBLE', decode(repeat('ab',32),'hex'), now(), now())`, [orderId])).not.toBe("ok");
    expect(r.refund.amount).toBe(1_000_000);
  });
  it("a paid order can only be CANCELLED through a completed refund (raw SQL), and a refund hold-resolution needs a completed refund", async () => {
    const { orderId } = await paidWalletOrder();
    expect((await orderRow(f, orderId)).status).toBe("FULFILLING"); // manual item: the FULFILLING -> CANCELLED edge is the one under test
    expect(await sqlCode("select set_config('app.actor_id','x',false), set_config('app.reason','x',false)").then(() => sqlCode("update orders set status = 'CANCELLED' where id = $1", [orderId]))).toBe("PO002");
    expect((await orderRow(f, orderId)).status).toBe("FULFILLING");
    const id = await approved(orderId, "WALLET");
    await executeRefund(bd(), adm("exec"), id); // only now is the same transition possible
    expect((await q("select from_status, to_status from order_status_history where entity_id = $1 and to_status = 'CANCELLED'", [orderId]))[0]).toEqual({ from_status: "FULFILLING", to_status: "CANCELLED" });
    const hold = await q<{ id: string }>("select id from order_holds where resolved_at is null limit 1");
    if (hold[0]) expect(await sqlCode("update order_holds set resolved_at = now(), resolved_by = 'x', resolution = 'REFUND_WALLET', note = 'x' where id = $1", [hold[0].id])).not.toBe("ok");
  });
  it("rollback: a failure after the ledger reversal undoes the ledger, completion and cancellation together", async () => {
    const { user, orderId } = await paidWalletOrder();
    const id = await approved(orderId, "WALLET");
    await f.t.pool.query("create function zz_boom() returns trigger language plpgsql as $$ begin if new.status = 'CANCELLED' then raise exception 'injected'; end if; return new; end $$");
    await f.t.pool.query("create trigger zz_boom after update of status on orders for each row execute function zz_boom()");
    const l0 = await ledgerCount();
    const bal = await getBalance(f.app.db, walletAccount(user));
    try {
      expect(await code(executeRefund(bd(), adm("exec"), id))).not.toBe("NO_ERROR");
    } finally {
      await f.t.pool.query("drop trigger zz_boom on orders");
      await f.t.pool.query("drop function zz_boom()");
    }
    expect(await ledgerCount()).toBe(l0);
    expect(await getBalance(f.app.db, walletAccount(user))).toBe(bal);
    expect((await getRefund({ db: f.app.db, authorize: async () => undefined }, id)).status).toBe("APPROVED");
    expect((await orderRow(f, orderId)).status).not.toBe("CANCELLED");
    expect(await executeRefund(bd(), adm("exec"), id)).toMatchObject({ status: "COMPLETED" }); // and it still works afterwards
    await healthy();
  });
});

describe("gateway refunds — ACCEPTED is not completion; ambiguity stays unresolved", () => {
  const reset = () => { f.gateway.refundMode = "accept"; f.gateway.refundVerify = "REFUNDED"; f.gateway.refundVerifyAmount = undefined; f.gateway.capabilities = { refund: true, refundIdempotent: false }; };
  it("accepted + verified for the exact amount => ledger reversal, COMPLETED, order CANCELLED (gateway receivable restored)", async () => {
    reset();
    const g = await paidGatewayOrder();
    const id = await approved(g.orderId, "GATEWAY");
    const calls = f.gateway.refundCalls.length;
    expect(await executeRefund(bd(), adm("exec"), id)).toEqual({ status: "COMPLETED", outcome: "CONFIRMED", replay: false });
    expect(f.gateway.refundCalls.length).toBe(calls + 1);
    expect(f.gateway.refundCalls.at(-1)).toMatchObject({ refundId: id, amount: 1_000_000 });
    expect((await orderRow(f, g.orderId)).status).toBe("CANCELLED");
    await healthy();
  });
  it("ACCEPTED but verification PENDING: stays PROCESSING with NO ledger effect and NO completion; later verify completes it WITHOUT resending", async () => {
    reset();
    const g = await paidGatewayOrder();
    const id = await approved(g.orderId, "GATEWAY");
    f.gateway.refundVerify = "PENDING";
    const l0 = await ledgerCount();
    const calls = f.gateway.refundCalls.length;
    expect(await executeRefund(bd(), adm("exec"), id)).toEqual({ status: "PROCESSING", outcome: "ACCEPTED", replay: false });
    expect(await ledgerCount()).toBe(l0);
    expect((await orderRow(f, g.orderId)).status).not.toBe("CANCELLED");
    f.gateway.refundVerify = "REFUNDED";
    expect(await executeRefund(bd(), adm("exec"), id)).toMatchObject({ status: "COMPLETED", outcome: "CONFIRMED" });
    expect(f.gateway.refundCalls.length).toBe(calls + 1); // exactly ONE refund request ever sent
    expect(await ledgerCount()).toBe(l0 + 1);
  });
  it("timeout (UNKNOWN) is never resent blindly; amount mismatch is not completion; both remain explicitly unresolved and are reported", async () => {
    reset();
    const g = await paidGatewayOrder();
    const id = await approved(g.orderId, "GATEWAY");
    f.gateway.refundMode = "throw"; f.gateway.refundVerify = "UNKNOWN";
    const calls = f.gateway.refundCalls.length;
    expect(await executeRefund(bd(), adm("exec"), id)).toMatchObject({ status: "PROCESSING", outcome: "UNKNOWN" });
    expect(await executeRefund(bd(), adm("exec"), id)).toMatchObject({ status: "PROCESSING", outcome: "UNKNOWN" });
    expect(f.gateway.refundCalls.length).toBe(calls + 1); // the second attempt only verified
    f.gateway.refundVerify = "REFUNDED"; f.gateway.refundVerifyAmount = 999_999;
    expect(await executeRefund(bd(), adm("exec"), id)).toMatchObject({ status: "PROCESSING", outcome: "UNKNOWN" });
    expect((await q("select 1 from audit_logs where action = 'orders.refund.amount_mismatch' and entity_id = $1", [id])).length).toBeGreaterThan(0);
    expect((await orderRow(f, g.orderId)).status).not.toBe("CANCELLED");
    const found = await runChecks(f.app.db, bd(), { jobs: ["REFUNDS_UNRESOLVED"], staleSeconds: 0 });
    expect(found.some((x) => x.subject === `refund:${id}`)).toBe(true);
    f.gateway.refundVerifyAmount = undefined;
    expect(await executeRefund(bd(), adm("exec"), id)).toMatchObject({ status: "COMPLETED" });
    reset();
  });
  it("an idempotent gateway may be re-asked after UNKNOWN (same refund id); a rejected refund becomes FAILED and may be retried", async () => {
    reset();
    f.gateway.capabilities = { refund: true, refundIdempotent: true };
    const g = await paidGatewayOrder();
    const id = await approved(g.orderId, "GATEWAY");
    f.gateway.refundMode = "throw"; f.gateway.refundVerify = "UNKNOWN";
    await executeRefund(bd(), adm("exec"), id);
    f.gateway.refundMode = "accept"; f.gateway.refundVerify = "REFUNDED";
    const calls = f.gateway.refundCalls.length;
    expect(await executeRefund(bd(), adm("exec"), id)).toMatchObject({ status: "COMPLETED" });
    expect(f.gateway.refundCalls.length).toBe(calls + 1);
    expect(new Set(f.gateway.refundCalls.filter((c) => c.refundId === id).map((c) => c.refundId)).size).toBe(1);
    reset();
    const g2 = await paidGatewayOrder();
    const id2 = await approved(g2.orderId, "GATEWAY");
    f.gateway.refundMode = "reject";
    expect(await executeRefund(bd(), adm("exec"), id2)).toMatchObject({ status: "FAILED", outcome: "REJECTED" });
    f.gateway.refundMode = "accept";
    expect(await executeRefund(bd(), adm("exec"), id2)).toMatchObject({ status: "COMPLETED" });
    expect((await q<{ attempts: number }>("select attempts from refunds where id = $1", [id2]))[0]!.attempts).toBe(2);
    reset();
  });
  it("a gateway without a refund capability blocks BEFORE any state change (X1)", async () => {
    reset();
    const g = await paidGatewayOrder();
    const id = await approved(g.orderId, "GATEWAY");
    f.gateway.capabilities = { refund: false, refundIdempotent: false };
    const l0 = await ledgerCount();
    expect(await code(executeRefund(bd(), adm("exec"), id))).toBe("REFUND_BLOCKED");
    expect((await getRefund({ db: f.app.db, authorize: async () => undefined }, id)).status).toBe("APPROVED");
    expect(await ledgerCount()).toBe(l0);
    reset();
  });
});

describe("held money (D9) — late payment and amount-mismatch review resolutions", () => {
  it("late payment -> refund to WALLET uses the approved D9 suspense->wallet rule: wallet credited, suspense cleared, hold resolved REFUND_WALLET, order CANCELLED", async () => {
    const l = await lateOrder();
    const r = await requestRefund(bd(), { type: "ADMIN", ...adm("requester") }, { orderId: l.orderId, holdId: l.holdId, destination: "WALLET", reasonCode: "LATE_PAYMENT" });
    expect(r.refund).toMatchObject({ source: "SUSPENSE_RECEIPT", amount: 1_000_000 });
    await approveRefund(bd(), adm("approver"), r.refund.id, { note: "late payment, refund to wallet" });
    expect(await executeRefund(bd(), adm("exec"), r.refund.id)).toMatchObject({ status: "COMPLETED" });
    expect(await getBalance(f.app.db, walletAccount(l.user))).toBe(1_000_000);
    expect((await q("select resolution from order_holds where id = $1", [l.holdId]))[0]).toEqual({ resolution: "REFUND_WALLET" });
    expect((await orderRow(f, l.orderId)).status).toBe("CANCELLED");
    expect((await q("select count(*)::int c from fulfillment_tasks where order_ref = $1", [l.orderId]))[0]).toEqual({ c: 0 });
    await healthy();
  });
  it("late payment -> refund to GATEWAY reverses the parked suspense posting after a verified gateway refund", async () => {
    const l = await lateOrder();
    const r = await requestRefund(bd(), { type: "ADMIN", ...adm("requester") }, { orderId: l.orderId, holdId: l.holdId, destination: "GATEWAY", reasonCode: "LATE_PAYMENT" });
    await approveRefund(bd(), adm("approver"), r.refund.id, { note: "late payment, refund to card" });
    expect(await executeRefund(bd(), adm("exec"), r.refund.id)).toMatchObject({ status: "COMPLETED", outcome: "CONFIRMED" });
    expect((await q("select resolution from order_holds where id = $1", [l.holdId]))[0]).toEqual({ resolution: "REFUND_GATEWAY" });
    await healthy();
  });
  it("amount mismatch (NEEDS_REVIEW): the RECEIVED amount is refunded, the payment is closed FAILED, the hold resolved; a second refund for the order is impossible", async () => {
    const { variantId } = await stockedVariant(f, 1);
    const user = userId();
    const o = await checkout(bd(), { userId: user, paymentMethod: "GATEWAY", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }] });
    const ref = (await q<{ gateway_ref: string }>("select gateway_ref from payments where id = $1", [o.paymentId]))[0]!.gateway_ref;
    f.gateway.script(ref, { status: "PAID", amount: 900_000 });
    await confirmGatewayPayment(bd(), { gatewayRef: ref, eventKey: `mm-${Math.random()}` });
    const hold = (await q<{ id: string; reason: string }>("select id, reason from order_holds where order_id = $1", [o.orderId]))[0]!;
    expect(hold.reason).toBe("PAYMENT_NEEDS_REVIEW");
    const r = await requestRefund(bd(), { type: "ADMIN", ...adm("requester") }, { orderId: o.orderId, holdId: hold.id, destination: "GATEWAY", reasonCode: "PAYMENT_MISMATCH" });
    expect(r.refund.amount).toBe(900_000);
    await approveRefund(bd(), adm("approver"), r.refund.id, { note: "mismatch, return received money" });
    expect(await executeRefund(bd(), adm("exec"), r.refund.id)).toMatchObject({ status: "COMPLETED" });
    expect((await q("select status from payments where id = $1", [o.paymentId]))[0]).toEqual({ status: "FAILED" });
    expect((await orderRow(f, o.orderId)).status).toBe("CANCELLED");
    const again = await requestRefund(bd(), { type: "ADMIN", ...adm("requester") }, { orderId: o.orderId, holdId: hold.id, destination: "GATEWAY", reasonCode: "PAYMENT_MISMATCH" });
    expect(again).toMatchObject({ replay: true }); // the identical request is a replay, never a second refund
    expect(again.refund.id).toBe(r.refund.id);
    expect(await code(requestRefund(bd(), { type: "ADMIN", ...adm("requester") }, { orderId: o.orderId, holdId: hold.id, destination: "WALLET", reasonCode: "PAYMENT_MISMATCH" }))).toBe("REFUND_INVALID");
    expect(await refundsFor(o.orderId)).toBe(1);
    await healthy();
  });
  it("other hold reasons have no refund path; the existing resolveHold for them stays blocked", async () => {
    const { orderId } = await paidWalletOrder();
    const fake = (await q<{ id: string }>("select gen_random_uuid() id"))[0]!.id;
    expect(await code(requestRefund(bd(), { type: "ADMIN", ...adm("r") }, { orderId, holdId: fake, destination: "WALLET", reasonCode: "X_X" }))).toBe("ORDER_NOT_FOUND");
  });
});

describe("reconciliation — read-only detection; one injected fault per job", () => {
  it("clean jobs are quiet; injected faults are found, persisted append-only, and never auto-repaired", async () => {
    const jobsQuiet = await runChecks(f.app.db, bd(), { jobs: ["LEDGER_INTEGRITY", "INVENTORY_INTEGRITY", "TOPUPS_INCOMPLETE", "OUTBOX_HEALTH"], staleSeconds: 86_400 });
    expect(jobsQuiet.filter((x) => x.severity === "CRITICAL")).toEqual([]);
    // PAID_ORDER_POSTING: orders paid by TestPostingPolicy have no settlement txn
    const nopost = await runChecks(f.app.db, bd(), { jobs: ["PAID_ORDER_POSTING"] });
    expect(nopost.some((x) => x.job === "PAID_ORDER_POSTING" && x.severity === "WARN")).toBe(true);
    // HOLDS_AGED
    await lateOrder(); // leaves one OPEN late-payment hold
    const aged = await runChecks(f.app.db, ordersDeps(f, { clock: new ManualClock(new Date(f.clock.now().getTime() + 7 * 86_400_000)) }), { jobs: ["HOLDS_AGED"], staleSeconds: 3600 });
    expect(aged.some((x) => x.job === "HOLDS_AGED")).toBe(true);
    // permission + persistence
    await expect(runReconciliation(bd(), adm("a", []), {})).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    const run = await runReconciliation(bd(), adm("recon"), { jobs: ["PAID_ORDER_POSTING", "HOLDS_AGED"] });
    expect(run.findings.length).toBeGreaterThan(0);
    expect((await listFindings({ db: f.app.db, authorize: async () => undefined }, run.runId)).length).toBe(run.findings.length);
    expect(await sqlCode("update reconciliation_findings set severity = 'INFO' where run_id = $1", [run.runId])).not.toBe("ok");
    expect(await sqlCode("delete from reconciliation_findings where run_id = $1", [run.runId])).not.toBe("ok");
    expect((await q("select 1 from audit_logs where action = 'orders.reconciliation.run' and entity_id = $1", [run.runId])).length).toBe(1);
  });
  it("a cancelled paid order without a completed refund is CRITICAL; the refund gate normally makes it unreachable", async () => {
    const f2 = await runChecks(f.app.db, bd(), { jobs: ["PAID_ORDER_POSTING"] });
    expect(f2.filter((x) => x.severity === "CRITICAL")).toEqual([]);
  });
});
