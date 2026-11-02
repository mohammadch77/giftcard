import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { trialBalance, verifyIntegrity } from "@/modules/ledger";
import { completeTopUp, decideAdjustment, getWalletBalance, requestAdjustment } from "@/modules/wallet";
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

const all = <T>(n: number, fn: (i: number) => Promise<T>) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
const sound = async () => {
  expect(await verifyIntegrity(f.app.db)).toEqual([]);
  expect((await trialBalance(f.app.db)).balanced).toBe(true);
};

describe("C3 — duplicate callbacks", () => {
  it("100 parallel callbacks for one top-up: ONE settlement, ONE ledger transaction, wallet credited once", async () => {
    const user = uid();
    const t = await startedTopUp(f, user, 300_000);
    f.gateway.script(t.gatewayRef, { status: "PAID", amount: 300_000 });
    f.gateway.verifyDelayMs = 40; // make the callbacks overlap with the slow verification
    const calls0 = f.gateway.verifyCalls;
    const results = await all(100, (i) => completeTopUp(f.app.db, deps(f), { gatewayRef: t.gatewayRef, eventKey: `ev-${i % 40}` })); // some event keys repeat on purpose
    f.gateway.verifyDelayMs = 0;
    expect(results.filter((r) => r.outcome === "SUCCEEDED")).toHaveLength(1);
    expect(results.every((r) => ["SUCCEEDED", "IN_PROGRESS", "FINAL"].includes(r.outcome))).toBe(true);
    expect(f.gateway.verifyCalls - calls0).toBe(1); // only the claim winner asked the gateway
    expect(await getWalletBalance(f.app.db, user)).toBe(300_000);
    expect((await f.t.pool.query("select count(*)::int c from ledger_transactions where idempotency_key = $1", [`topup:${t.paymentId}`])).rows[0].c).toBe(1);
    expect((await f.t.pool.query("select count(*)::int c from outbox_events where event_type = 'payment.succeeded' and aggregate_id = $1", [t.paymentId])).rows[0].c).toBe(1);
    expect((await f.t.pool.query("select count(*)::int c from payment_status_history where entity_id = $1 and to_status = 'VERIFYING'", [t.paymentId])).rows[0].c).toBe(1);
    await sound();
  });

  it("20 users top up at the same time with 5 duplicate callbacks each: every wallet credited exactly once", async () => {
    const users = Array.from({ length: 20 }, () => uid());
    const tops = await Promise.all(users.map((u, i) => startedTopUp(f, u, 10_000 * (i + 1))));
    tops.forEach((t, i) => f.gateway.script(t.gatewayRef, { status: "PAID", amount: 10_000 * (i + 1) }));
    await Promise.all(tops.flatMap((t, i) => Array.from({ length: 5 }, (_, k) => completeTopUp(f.app.db, deps(f), { gatewayRef: t.gatewayRef, eventKey: `m-${i}-${k}` }))));
    for (let i = 0; i < users.length; i++) expect(await getWalletBalance(f.app.db, users[i]!), users[i]).toBe(10_000 * (i + 1));
    await sound();
  });

  it("concurrent start requests with one key create one top-up and one payment", async () => {
    const user = uid();
    const key = uid("k");
    const { startTopUp } = await import("@/modules/wallet");
    const res = await all(25, () => startTopUp(f.app.db, deps(f), { userId: user, amount: 50_000, idempotencyKey: key }, LIMITS));
    expect(new Set(res.map((r) => r.topupId)).size).toBe(1);
    expect(new Set(res.map((r) => r.paymentId)).size).toBe(1);
    expect((await f.t.pool.query("select count(*)::int c from payments where topup_ref = $1", [res[0]!.topupId])).rows[0].c).toBe(1);
  });
});

describe("S2 analogue — concurrent wallet debits through the service", () => {
  it("40 two-person debit approvals of 10,000 against a 250,000 balance: exactly 25 succeed, the wallet ends at 0, never negative", async () => {
    const user = uid();
    await paidTopUp(f, user, 250_000);
    const alice = walletCtx(f, "alice");
    const ids = await all(40, () => requestAdjustment(alice, { userId: user, direction: "DEBIT", amount: 10_000, reason: "bulk correction scenario" }));
    const outcome = await Promise.all(ids.map((r, i) => decideAdjustment(walletCtx(f, `bob-${i % 5}`), r.adjustmentId, { approve: true, reason: "approved in bulk run" }).then(() => "OK", (e: { code?: string }) => e.code ?? "ERR")));
    const ok = outcome.filter((o) => o === "OK").length;
    expect(ok).toBe(25);
    expect(outcome.filter((o) => o === "INSUFFICIENT_FUNDS")).toHaveLength(15);
    expect(await getWalletBalance(f.app.db, user)).toBe(0);
    expect((await f.t.pool.query("select count(*)::int c from wallet_adjustments where user_ref = $1 and status = 'COMPLETED'", [user])).rows[0].c).toBe(25);
    await sound();
  });

  it("the same adjustment approved by 20 admins at once is applied once", async () => {
    const user = uid();
    await paidTopUp(f, user, 100_000);
    const { adjustmentId } = await requestAdjustment(walletCtx(f, "alice"), { userId: user, direction: "DEBIT", amount: 40_000, reason: "single correction scenario" });
    const out = await all(20, (i) => decideAdjustment(walletCtx(f, `bob-${i}`), adjustmentId, { approve: true, reason: "race approval run" }).then(() => "OK", (e: { code?: string }) => e.code ?? "ERR"));
    expect(out.filter((o) => o === "OK")).toHaveLength(1);
    expect(await getWalletBalance(f.app.db, user)).toBe(60_000);
    await sound();
  });
});
