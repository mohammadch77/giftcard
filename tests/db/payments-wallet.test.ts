import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getBalance, trialBalance, verifyIntegrity, walletAccount } from "@/modules/ledger";
import { getPayment, getPaymentForUser, initiatePayment, listNeedingReview, listVerificationDue, startGatewayPayment, verifyPayment } from "@/modules/payments";
import { completeTopUp, decideAdjustment, getTopUp, getWalletBalance, getWalletBalanceAdmin, requestAdjustment, startTopUp } from "@/modules/wallet";
import { NullPaymentGateway } from "@/platform/payment-gateway";
import type { GatewayVerifyReply } from "@/platform/payment-gateway";
import { TestPaymentGateway } from "@/platform/payment-gateway/testing/test-gateway";
import { withTransaction } from "@/platform/db";
import { pgCode } from "../helpers/db";
import { LIMITS, deps, paidTopUp, payFixture, startedTopUp, uid, walletCtx } from "../helpers/payments";
import type { PayFixture } from "../helpers/payments";

let f: PayFixture;
beforeAll(async () => {
  f = await payFixture();
});
afterAll(async () => {
  await f?.app.close();
  await f?.t.drop();
});

const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? "OTHER"; } return "NO_ERROR"; };
const sqlCode = (q: string, p: unknown[] = []) => f.t.pool.query(q, p).then(() => "ok", (e: unknown) => pgCode(e));
const payment = async (id: string) => (await f.t.pool.query("select * from payments where id = $1", [id])).rows[0];
const ledgerCount = async (key: string) => (await f.t.pool.query("select count(*)::int c from ledger_transactions where idempotency_key = $1", [key])).rows[0].c as number;
const sound = async () => {
  expect(await verifyIntegrity(f.app.db)).toEqual([]);
  const tb = await trialBalance(f.app.db);
  expect(tb.balanced).toBe(true);
};

describe("payment creation", () => {
  it("is idempotent per key; different content conflicts; input is validated", async () => {
    const mk = (over: object = {}) => withTransaction(f.app.db, (tx) => initiatePayment(tx, f.clock, { idempotencyKey: "pay-k1", purpose: "WALLET_TOPUP", topupRef: "t1", userRef: "u1", gateway: "test", amount: 50_000, ...over }));
    const a = await mk();
    const b = await mk();
    expect(a.replay).toBe(false);
    expect(b).toMatchObject({ replay: true, payment: { id: a.payment.id, status: "INITIATED" } });
    expect(await code(mk({ amount: 60_000 }))).toBe("IDEMPOTENCY_CONFLICT");
    for (const bad of [{ amount: 0 }, { amount: 1.5 }, { amount: -5 }, { amount: 10_000_000_000_010 }, { purpose: "ORDER" }, { topupRef: undefined, orderRef: undefined }, { extra: 1 }]) {
      expect(await code(mk({ idempotencyKey: uid("bad"), ...bad })), JSON.stringify(bad)).toMatch(/^(PAYMENT_INVALID|RIAL_.*)$/);
    }
    expect(await sqlCode("update payments set amount = 1 where id = $1", [a.payment.id])).toBe("PI001");
  });
  it("gateway creation: CREATED -> PENDING (reference stored), rejection -> FAILED, unknown outcome stays INITIATED and is retryable", async () => {
    const mk = async () => (await withTransaction(f.app.db, (tx) => initiatePayment(tx, f.clock, { idempotencyKey: uid("k"), purpose: "WALLET_TOPUP", topupRef: uid("t"), userRef: "u1", gateway: "test", amount: 10_000 }))).payment.id;
    const a = await mk();
    const r1 = await startGatewayPayment(f.app.db, deps(f), a);
    expect(r1).toMatchObject({ status: "PENDING", replay: false });
    expect((await payment(a)).gateway_ref).toMatch(/^tg-/);
    expect(await startGatewayPayment(f.app.db, deps(f), a)).toMatchObject({ status: "PENDING", replay: true });
    const b = await mk();
    f.gateway.createMode = "reject";
    expect(await startGatewayPayment(f.app.db, deps(f), b)).toEqual({ status: "FAILED" });
    const c = await mk();
    f.gateway.createMode = "throw";
    expect(await startGatewayPayment(f.app.db, deps(f), c)).toEqual({ status: "INITIATED", unknown: true });
    f.gateway.createMode = "ok";
    expect((await startGatewayPayment(f.app.db, deps(f), c)).status).toBe("PENDING");
    expect(await code(startGatewayPayment(f.app.db, { gateway: new NullPaymentGateway(), clock: f.clock }, await mk()))).toBe("PAYMENT_INVALID"); // key mismatch
  });
});

describe("wallet top-up (verified payment -> ledger)", () => {
  it("credits the wallet exactly once, with ledger transaction, completed top-up, outbox event and audit; a replayed callback changes nothing", async () => {
    const user = uid();
    const t = await paidTopUp(f, user, 250_000);
    expect(t.out).toMatchObject({ outcome: "SUCCEEDED", status: "SUCCEEDED" });
    expect(await getWalletBalance(f.app.db, user)).toBe(250_000);
    const p = await payment(t.paymentId!);
    expect(p).toMatchObject({ status: "SUCCEEDED" });
    expect(Number(p.verified_amount)).toBe(250_000);
    expect(await ledgerCount(`topup:${t.paymentId}`)).toBe(1);
    expect(await getTopUp(f.app.db, user, t.topupId)).toMatchObject({ status: "COMPLETED", amount: 250_000 });
    expect((await f.t.pool.query("select 1 from outbox_events where event_type = 'payment.succeeded' and aggregate_id = $1", [t.paymentId])).rows).toHaveLength(1);
    for (const a of ["payments.payment.succeeded", "wallet.topup.requested", "wallet.topup.completed"]) expect((await f.t.pool.query("select 1 from audit_logs where action = $1", [a])).rows.length, a).toBeGreaterThan(0);
    const again = await completeTopUp(f.app.db, deps(f), { gatewayRef: t.gatewayRef, eventKey: uid("ev") });
    expect(again).toEqual({ outcome: "FINAL", status: "SUCCEEDED", replay: true });
    expect(await getWalletBalance(f.app.db, user)).toBe(250_000);
    expect(await ledgerCount(`topup:${t.paymentId}`)).toBe(1);
    await sound();
  });
  it("is idempotent per key and fails closed without configured limits (B5 open) or outside them", async () => {
    const user = uid();
    const key = uid("k");
    const a = await startTopUp(f.app.db, deps(f), { userId: user, amount: 50_000, idempotencyKey: key }, LIMITS);
    const b = await startTopUp(f.app.db, deps(f), { userId: user, amount: 50_000, idempotencyKey: key }, LIMITS);
    expect(b).toMatchObject({ topupId: a.topupId, paymentId: a.paymentId, replay: true });
    expect((await f.t.pool.query("select count(*)::int c from payments where topup_ref = $1", [a.topupId])).rows[0].c).toBe(1);
    expect(await code(startTopUp(f.app.db, deps(f), { userId: user, amount: 60_000, idempotencyKey: key }, LIMITS))).toBe("IDEMPOTENCY_CONFLICT");
    expect(await code(startTopUp(f.app.db, deps(f), { userId: user, amount: 50_000, idempotencyKey: uid("k") }, {}))).toBe("WALLET_LIMITS_NOT_CONFIGURED");
    expect(await code(startTopUp(f.app.db, deps(f), { userId: user, amount: 50_000, idempotencyKey: uid("k") }, { minRial: 10_000 }))).toBe("WALLET_LIMITS_NOT_CONFIGURED");
    for (const amount of [5_000, 100_000_010, 15_005, 0, -10, 12.5]) expect(await code(startTopUp(f.app.db, deps(f), { userId: user, amount, idempotencyKey: uid("k") }, LIMITS)), String(amount)).not.toBe("NO_ERROR");
  });
  it("with no gateway configured the failure is loud and nothing is credited", async () => {
    const user = uid();
    const dead = { gateway: new NullPaymentGateway(), clock: f.clock };
    expect(await code(startTopUp(f.app.db, dead, { userId: user, amount: 50_000, idempotencyKey: uid("k") }, LIMITS))).toBe("PAYMENT_GATEWAY_NOT_CONFIGURED");
    expect(await getWalletBalance(f.app.db, user)).toBe(0);
  });
  it("a callback is only a trigger: unknown references are harmless, an unanswered verification credits nothing", async () => {
    expect(await completeTopUp(f.app.db, deps(f), { gatewayRef: "does-not-exist", eventKey: uid("ev") })).toEqual({ outcome: "UNKNOWN_REFERENCE" });
    const user = uid();
    const t = await startedTopUp(f, user, 70_000); // gateway has no script for it => UNKNOWN reply
    const out = await completeTopUp(f.app.db, deps(f), { gatewayRef: t.gatewayRef, eventKey: uid("ev"), raw: { browser: "redirect", success: true } });
    expect(out).toEqual({ outcome: "RETRY_LATER", status: "VERIFYING" });
    expect(await getWalletBalance(f.app.db, user)).toBe(0);
    expect((await payment(t.paymentId!)).status).toBe("VERIFYING");
  });
  it("amount or reference mismatch => NEEDS_REVIEW, the RECEIVED amount goes to suspense, the wallet is NOT credited", async () => {
    const user = uid();
    const t = await paidTopUp(f, user, 100_000, 90_000);
    expect(t.out).toMatchObject({ outcome: "NEEDS_REVIEW" });
    expect(await getWalletBalance(f.app.db, user)).toBe(0);
    expect(await ledgerCount(`payrecv:${t.paymentId}`)).toBe(1);
    expect(await ledgerCount(`topup:${t.paymentId}`)).toBe(0);
    const susp = (await f.t.pool.query("select e.amount, e.side from ledger_entries e join ledger_accounts a on a.id = e.account_id join ledger_transactions x on x.id = e.transaction_id where a.code = 'SUSPENSE_UNRESOLVED_RECEIPTS' and x.idempotency_key = $1", [`payrecv:${t.paymentId}`])).rows;
    expect(susp.map((r) => [Number(r.amount), r.side])).toEqual([[90_000, "CREDIT"]]);
    expect((await payment(t.paymentId!)).review_reason).toContain("mismatch");
    expect((await listNeedingReview({ db: f.app.db, authorize: async () => undefined })).some((p) => p.id === t.paymentId)).toBe(true);
    // PAID without an amount: review, no posting
    const u2 = await startedTopUp(f, uid(), 40_000);
    f.gateway.script(u2.gatewayRef, { status: "PAID" });
    expect((await completeTopUp(f.app.db, deps(f), { gatewayRef: u2.gatewayRef, eventKey: uid("ev") })).outcome).toBe("NEEDS_REVIEW");
    expect(await ledgerCount(`payrecv:${u2.paymentId}`)).toBe(0);
    // DB invariant: nobody can force SUCCEEDED with a different verified amount
    expect(await sqlCode("update payments set status = 'SUCCEEDED', verified_at = now(), verified_amount = 90000 where id = $1", [t.paymentId])).toBe("23514");
    await sound();
  });
  it("gateway FAILED => payment and top-up FAILED, nothing credited", async () => {
    const user = uid();
    const t = await startedTopUp(f, user, 30_000);
    f.gateway.script(t.gatewayRef, { status: "FAILED" });
    expect((await completeTopUp(f.app.db, deps(f), { gatewayRef: t.gatewayRef, eventKey: uid("ev") })).outcome).toBe("FAILED");
    expect((await getTopUp(f.app.db, user, t.topupId))?.status).toBe("FAILED");
    expect(await getWalletBalance(f.app.db, user)).toBe(0);
  });
  it("timeouts are not failures: lease blocks duplicates, re-claim after the lease, NEEDS_REVIEW after the attempt budget, workers can list due payments", async () => {
    const user = uid();
    const t = await startedTopUp(f, user, 20_000);
    f.gateway.script(t.gatewayRef, "THROW");
    const cb = () => completeTopUp(f.app.db, { ...deps(f), leaseSeconds: 120, maxAttempts: 3 }, { gatewayRef: t.gatewayRef, eventKey: uid("ev") });
    expect(await cb()).toEqual({ outcome: "RETRY_LATER", status: "VERIFYING" });
    expect(await cb()).toEqual({ outcome: "IN_PROGRESS" });
    expect(await listVerificationDue(f.app.db, f.clock)).not.toContain(t.gatewayRef);
    f.clock.advance(121_000);
    expect(await listVerificationDue(f.app.db, f.clock)).toContain(t.gatewayRef);
    f.gateway.script(t.gatewayRef, { status: "UNKNOWN" });
    expect(await cb()).toEqual({ outcome: "RETRY_LATER", status: "VERIFYING" });
    f.clock.advance(121_000);
    expect(await cb()).toMatchObject({ outcome: "NEEDS_REVIEW" }); // third attempt exhausts the budget
    expect((await payment(t.paymentId!)).review_reason).toBe("gateway did not answer");
    expect(await getWalletBalance(f.app.db, user)).toBe(0);
    // the late answer after review must not credit anything
    f.gateway.script(t.gatewayRef, { status: "PAID", amount: 20_000 });
    expect(await cb()).toMatchObject({ outcome: "FINAL", status: "NEEDS_REVIEW" });
    expect(await getWalletBalance(f.app.db, user)).toBe(0);
  });
  it("the gateway is called with NO database transaction open, and a failing success hook rolls the whole settlement back", async () => {
    let idleInTx = -1;
    class Probe extends TestPaymentGateway {
      override async verifyPayment(req: { gatewayRef: string }): Promise<GatewayVerifyReply> {
        idleInTx = Number((await f.t.pool.query("select count(*)::int c from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'")).rows[0].c);
        return super.verifyPayment(req);
      }
    }
    const probe = new Probe();
    const user = uid();
    const t = await startedTopUp(f, user, 80_000);
    probe.script(t.gatewayRef, { status: "PAID", amount: 80_000 });
    const failing = await code(verifyPayment(f.app.db, { gateway: probe, clock: f.clock }, { gatewayRef: t.gatewayRef, eventKey: uid("ev") }, { onSucceeded: async () => { throw new Error("boom"); } }));
    expect(failing).toBe("OTHER");
    expect(idleInTx).toBe(0);
    expect((await payment(t.paymentId!)).status).toBe("VERIFYING"); // nothing half-done
    f.clock.advance(121_000);
    f.gateway.script(t.gatewayRef, { status: "PAID", amount: 80_000 });
    expect((await completeTopUp(f.app.db, deps(f), { gatewayRef: t.gatewayRef, eventKey: uid("ev") })).outcome).toBe("SUCCEEDED"); // retry succeeds, credits once
    expect(await getWalletBalance(f.app.db, user)).toBe(80_000);
  });
  it("is user-scoped (IDOR-safe) and the database refuses forged transitions and deletions", async () => {
    const user = uid();
    const t = await paidTopUp(f, user, 30_000);
    expect(await getPaymentForUser(f.app.db, user, t.paymentId!)).not.toBeNull();
    expect(await getPaymentForUser(f.app.db, "someone-else", t.paymentId!)).toBeNull();
    expect(await getTopUp(f.app.db, "someone-else", t.topupId)).toBeNull();
    const pending = await startedTopUp(f, uid(), 30_000);
    expect(await sqlCode("update payments set status = 'SUCCEEDED', verified_at = now(), verified_amount = 30000 where id = $1", [pending.paymentId])).toBe("PT001"); // PENDING -> SUCCEEDED does not exist
    expect(await sqlCode("update payments set status = 'PENDING' where id = $1", [t.paymentId])).toBe("PT001");
    for (const q of ["delete from payments", "delete from payment_events", "delete from wallet_topups", "delete from wallet_adjustments", "update payment_events set kind = 'CALLBACK'"]) {
      expect(await f.app.pool.query(q).then(() => "ok", (e: unknown) => pgCode(e)), q).toBe("42501");
    }
    expect(await sqlCode("update wallet_topups set amount = 10 where id = $1", [t.topupId])).toBe("PI001");
    expect((await getPayment(f.app.db, t.paymentId!))?.status).toBe("SUCCEEDED");
  });
});

describe("administrative wallet adjustments (two people, always)", () => {
  it("request -> second admin approves -> ledger posting, balance, audit; the requester can never approve", async () => {
    const user = uid();
    const alice = walletCtx(f, "alice"), bob = walletCtx(f, "bob");
    expect(await code(requestAdjustment(walletCtx(f, "x", []), { userId: user, direction: "CREDIT", amount: 1000, reason: "goodwill credit for outage" }))).toBe("AUTH_FORBIDDEN");
    expect(await code(requestAdjustment(alice, { userId: user, direction: "CREDIT", amount: 1000, reason: "short" }))).toBe("WALLET_INVALID");
    expect(await code(requestAdjustment(alice, { userId: user, direction: "CREDIT", amount: 0, reason: "goodwill credit for outage" }))).not.toBe("NO_ERROR");
    const { adjustmentId } = await requestAdjustment(alice, { userId: user, direction: "CREDIT", amount: 5_000, reason: "goodwill credit for outage" });
    expect(await code(decideAdjustment(alice, adjustmentId, { approve: true, reason: "self approval attempt" }))).toBe("WALLET_INVALID");
    expect(await sqlCode("update wallet_adjustments set status='COMPLETED', decided_by=requested_by, decided_at=now(), decision_reason='forged self approval', ledger_txn_id=1 where id=$1", [adjustmentId])).toBe("23514");
    expect(await code(decideAdjustment(walletCtx(f, "bob", ["wallet.read"]), adjustmentId, { approve: true, reason: "no permission here" }))).toBe("AUTH_FORBIDDEN");
    const done = await decideAdjustment(bob, adjustmentId, { approve: true, reason: "verified outage ticket" });
    expect(done.status).toBe("COMPLETED");
    expect(await getWalletBalanceAdmin(bob, user)).toBe(5_000);
    expect(await code(decideAdjustment(bob, adjustmentId, { approve: true, reason: "double approval" }))).toBe("WALLET_INVALID");
    expect(await ledgerCount(`walletadj:${adjustmentId}`)).toBe(1);
    const aud = (await f.t.pool.query("select actor_id, action from audit_logs where entity_id = $1 order by id", [adjustmentId])).rows;
    expect(aud).toEqual([{ actor_id: "alice", action: "wallet.adjustment.requested" }, { actor_id: "bob", action: "wallet.adjustment.approved" }]);
    expect(await code(getWalletBalanceAdmin(walletCtx(f, "z", []), user))).toBe("AUTH_FORBIDDEN");
    await sound();
  });
  it("a debit beyond the balance rolls back (stays REQUESTED); rejection moves nothing", async () => {
    const user = uid();
    await paidTopUp(f, user, 20_000);
    const alice = walletCtx(f, "alice"), bob = walletCtx(f, "bob");
    const big = await requestAdjustment(alice, { userId: user, direction: "DEBIT", amount: 30_000, reason: "chargeback correction case 1" });
    expect(await code(decideAdjustment(bob, big.adjustmentId, { approve: true, reason: "approve over balance" }))).toBe("INSUFFICIENT_FUNDS");
    expect((await f.t.pool.query("select status from wallet_adjustments where id = $1", [big.adjustmentId])).rows[0].status).toBe("REQUESTED");
    expect(await getWalletBalance(f.app.db, user)).toBe(20_000);
    expect((await decideAdjustment(bob, big.adjustmentId, { approve: false, reason: "not justified" })).status).toBe("REJECTED");
    const ok = await requestAdjustment(alice, { userId: user, direction: "DEBIT", amount: 20_000, reason: "chargeback correction case 2" });
    await decideAdjustment(bob, ok.adjustmentId, { approve: true, reason: "confirmed with finance" });
    expect(await getWalletBalance(f.app.db, user)).toBe(0);
    expect(await getBalance(f.app.db, walletAccount(user))).toBe(0);
    await sound();
  });
});
