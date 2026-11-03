import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completeTopUp, decideLimitChange, getTopUpLimits, getTopUpLimitsAdmin, getWalletBalance, requestLimitChange, startTopUp, tehranDayWindow } from "@/modules/wallet";
import { pgCode } from "../helpers/db";
import { deps, paidTopUp, payFixture, startedTopUp, uid, walletCtx } from "../helpers/payments";
import type { PayFixture } from "../helpers/payments";

// This suite runs under the OWNER-APPROVED DEFAULTS (no test limits applied): 1,000,000 / 100,000,000 / 300,000,000 IRR.
let f: PayFixture;
beforeAll(async () => { f = await payFixture({ testLimits: false }); });
afterAll(async () => { await f?.app.close(); await f?.t.drop(); });

const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? "OTHER"; } return "NO_ERROR"; };
const q = async <T = Record<string, unknown>>(s: string, p: unknown[] = []) => (await f.t.pool.query(s, p)).rows as T[];
const ownerSql = (s: string, p: unknown[] = []) => f.t.pool.query(s, p).then(() => "ok", (e: unknown) => pgCode(e));
const appSql = (s: string, p: unknown[] = []) => f.app.pool.query(s, p).then(() => "ok", (e: unknown) => pgCode(e));
const start = (user: string, amount: number, key = uid("k")) => startTopUp(f.app.db, deps(f), { userId: user, amount, idempotencyKey: key });
const rows = async () => Number((await q("select count(*)::int c from wallet_limit_versions"))[0]!.c);
const GOOD = { minRial: 2_000_000, maxRial: 50_000_000, dailyMaxRial: 200_000_000, reason: "tighten limits for the pilot" };

describe("B5 limits — approved defaults, versioned, two-person (ADM-1)", () => {
  it("version 1 holds the owner-approved integer-Rial defaults, approved by the migration", async () => {
    expect(await getTopUpLimits(f.app.db)).toEqual({ version: 1, values: { minRial: 1_000_000, maxRial: 100_000_000, dailyMaxRial: 300_000_000 }, source: "SEED" });
    expect((await q("select status, approved_seq, requested_by, decided_by from wallet_limit_versions"))[0]).toMatchObject({ status: "APPROVED", approved_seq: 1 });
  });

  it("permissions: request, approve and read each need their own permission; a denied call writes nothing", async () => {
    const n = await rows();
    expect(await code(requestLimitChange(walletCtx(f, "a", []), GOOD))).toBe("AUTH_FORBIDDEN");
    expect(await code(requestLimitChange(walletCtx(f, "a", ["wallet.settings.approve"]), GOOD))).toBe("AUTH_FORBIDDEN");
    const { requestId } = await requestLimitChange(walletCtx(f, "req-1", ["wallet.settings.request"]), GOOD);
    expect(await code(decideLimitChange(walletCtx(f, "app-1", ["wallet.settings.request"]), requestId, { approve: true, reason: "approved it" }))).toBe("AUTH_FORBIDDEN");
    expect(await code(getTopUpLimitsAdmin({ db: f.app.db, authorize: walletCtx(f, "a", []).authorize }))).toBe("AUTH_FORBIDDEN");
    expect((await getTopUpLimitsAdmin({ db: f.app.db, authorize: walletCtx(f, "a", ["wallet.settings.read"]).authorize })).version).toBe(1);
    expect(await rows()).toBe(n + 1);
    await decideLimitChange(walletCtx(f, "app-1"), requestId, { approve: false, reason: "not needed after all" });
  });

  it("server-side validation: integers, multiples of 10, relationship min <= max <= daily, technical ceilings, mandatory reason — nothing is written on failure", async () => {
    const n = await rows();
    const c = walletCtx(f, "req-v");
    const bad: Array<Partial<typeof GOOD>> = [
      { minRial: 5_000, maxRial: 4_000 }, // min > max
      { maxRial: 400_000_000 }, // max > daily
      { minRial: 0 }, { minRial: -10 }, { minRial: 5 }, { minRial: 1_000_005 }, { minRial: 1_000_000.5 }, { minRial: Number.NaN },
      { maxRial: 1_000_000_000_010, dailyMaxRial: 10_000_000_000_000 }, // above the per-top-up ceiling
      { dailyMaxRial: 10_000_000_000_010 },
      { minRial: "1000000" as unknown as number },
      { reason: "short" }, { reason: "" },
    ];
    for (const b of bad) expect(await code(requestLimitChange(c, { ...GOOD, ...b })), JSON.stringify(b)).toBe("SETTINGS_INVALID");
    expect(await code(requestLimitChange(c, { ...GOOD, minRial: 1_000_000, maxRial: 100_000_000, dailyMaxRial: 300_000_000 }))).toBe("SETTINGS_INVALID"); // equals the active limits
    expect(await rows()).toBe(n);
  });

  it("a REQUEST has no effect; only a different administrator's approval activates it (version 2), with a full audit trail", async () => {
    const { requestId, baseVersion } = await requestLimitChange(walletCtx(f, "req-2"), GOOD);
    expect(baseVersion).toBe(1);
    expect((await getTopUpLimits(f.app.db)).version).toBe(1); // unchanged while only requested
    expect(await code(decideLimitChange(walletCtx(f, "req-2"), requestId, { approve: true, reason: "self approval" }))).toBe("SETTINGS_INVALID"); // two-person rule
    expect((await getTopUpLimits(f.app.db)).version).toBe(1);
    expect(await decideLimitChange(walletCtx(f, "app-2"), requestId, { approve: true, reason: "approved by second admin" })).toEqual({ status: "APPROVED", version: 2 });
    expect(await getTopUpLimits(f.app.db)).toEqual({ version: 2, values: { minRial: 2_000_000, maxRial: 50_000_000, dailyMaxRial: 200_000_000 }, source: "ADMIN" });
    expect(await code(decideLimitChange(walletCtx(f, "app-3"), requestId, { approve: true, reason: "again" }))).toBe("SETTINGS_INVALID"); // a decision is final
    const audits = await q("select action, actor_id, before, after, metadata from audit_logs where action like 'wallet.settings.limits_%' and entity_id = $1 order by id", [requestId]);
    expect(audits.map((a) => [a.action, a.actor_id])).toEqual([["wallet.settings.limits_requested", "req-2"], ["wallet.settings.limits_approved", "app-2"]]);
    expect(audits[1]!.before).toMatchObject({ version: 1, minRial: 1_000_000 });
    expect(audits[1]!.after).toMatchObject({ version: 2, minRial: 2_000_000, maxRial: 50_000_000, dailyMaxRial: 200_000_000 });
    expect(audits[0]!.metadata).toMatchObject({ reason: "tighten limits for the pilot", baseVersion: 1 });
  });

  it("rejection keeps the active limits; a request made against an older version is STALE and cannot be approved", async () => {
    const a = await requestLimitChange(walletCtx(f, "req-3"), { ...GOOD, minRial: 3_000_000, reason: "first competing request" });
    const b = await requestLimitChange(walletCtx(f, "req-4"), { ...GOOD, minRial: 4_000_000, reason: "second competing request" });
    expect(await decideLimitChange(walletCtx(f, "app-4"), a.requestId, { approve: true, reason: "approve the first" })).toMatchObject({ status: "APPROVED", version: 3 });
    expect(await code(decideLimitChange(walletCtx(f, "app-5"), b.requestId, { approve: true, reason: "approve the stale one" }))).toBe("SETTINGS_STALE");
    expect(await decideLimitChange(walletCtx(f, "app-5"), b.requestId, { approve: false, reason: "superseded by another request" })).toEqual({ status: "REJECTED" });
    expect((await getTopUpLimits(f.app.db)).version).toBe(3);
    // restore the approved defaults through the same flow, so the boundary tests below run against them
    const r = await requestLimitChange(walletCtx(f, "req-5"), { minRial: 1_000_000, maxRial: 100_000_000, dailyMaxRial: 300_000_000, reason: "restore the approved defaults" });
    await decideLimitChange(walletCtx(f, "app-6"), r.requestId, { approve: true, reason: "restore defaults" });
    expect((await getTopUpLimits(f.app.db)).values).toEqual({ minRial: 1_000_000, maxRial: 100_000_000, dailyMaxRial: 300_000_000 });
  });

  it("database invariants: two-person CHECK, decided rows frozen, stale approval refused, bounds, append-only", async () => {
    const { requestId } = await requestLimitChange(walletCtx(f, "req-db"), { ...GOOD, minRial: 1_500_000, reason: "database invariant probe" });
    const cur = (await getTopUpLimits(f.app.db)).version;
    // self-approval is a CHECK violation even for the table owner
    expect(await ownerSql("update wallet_limit_versions set status = 'APPROVED', approved_seq = $2, decided_by = requested_by, decided_at = now(), decision_reason = 'self approval' where id = $1", [requestId, cur + 1])).toBe("23514");
    // approving with a wrong sequence (or against a stale base) is refused by the guard trigger
    expect(await ownerSql("update wallet_limit_versions set status = 'APPROVED', approved_seq = $2, decided_by = 'other', decided_at = now(), decision_reason = 'wrong sequence' where id = $1", [requestId, cur + 5])).toBe("PO003");
    // the values of a request are immutable
    expect(await ownerSql("update wallet_limit_versions set min_rial = 20 where id = $1", [requestId])).toBe("PI001");
    expect(await appSql("update wallet_limit_versions set min_rial = 20 where id = $1", [requestId])).toBe("42501");
    expect(await appSql("delete from wallet_limit_versions")).toBe("42501");
    expect(await ownerSql("delete from wallet_limit_versions where id = $1", [requestId])).not.toBe("ok");
    await decideLimitChange(walletCtx(f, "app-db"), requestId, { approve: false, reason: "probe finished" });
    expect(await appSql("update wallet_limit_versions set status = 'APPROVED' where id = $1", [requestId])).toBe("PO003"); // a decided row never changes
    // raw inserts cannot bypass the bounds
    const ins = (min: number, max: number, daily: number) =>
      ownerSql("insert into wallet_limit_versions (id, min_rial, max_rial, daily_max_rial, source, status, requested_by, reason, created_at) values (gen_random_uuid(), $1, $2, $3, 'ADMIN', 'REQUESTED', 'x', 'raw insert probe', now())", [min, max, daily]);
    expect(await ins(100, 50, 200)).toBe("23514");
    expect(await ins(100, 500, 200)).toBe("23514");
    expect(await ins(105, 500, 900)).toBe("23514");
    expect(await ins(100, 2_000_000_000_000, 20_000_000_000_000)).toBe("23514");
  });

  it("fails closed when no approved version can be read", async () => {
    const c = await f.t.pool.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      await c.query("delete from wallet_limit_versions");
      expect(await code(getTopUpLimits(drizzle(c) as never))).toBe("WALLET_LIMITS_NOT_CONFIGURED");
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});

describe("B5 enforcement under the approved defaults", () => {
  it("minimum and maximum boundaries (integer Rial, multiples of 10)", async () => {
    const user = uid();
    for (const amount of [999_990, 100_000_010, 0, -10, 1_000_005, 1_500_000.5]) expect(await code(start(user, amount)), String(amount)).not.toBe("NO_ERROR");
    expect(await code(start(user, 999_990))).toBe("WALLET_INVALID");
    expect(await code(start(user, 100_000_010))).toBe("WALLET_INVALID");
    expect((await start(user, 1_000_000)).amount).toBe(1_000_000);
    expect((await start(user, 100_000_000)).amount).toBe(100_000_000);
  });

  it("daily limit 300,000,000 per user: exactly the limit is allowed, one more is refused and writes nothing", async () => {
    const user = uid();
    for (let i = 0; i < 3; i++) await start(user, 100_000_000);
    const before = (await q("select (select count(*)::int from wallet_topups where user_ref = $1) t, (select count(*)::int from payments where user_ref = $1) p", [user]))[0]!;
    expect(await code(start(user, 1_000_000))).toBe("WALLET_DAILY_LIMIT_EXCEEDED");
    expect(await code(start(user, 100_000_000))).toBe("WALLET_DAILY_LIMIT_EXCEEDED");
    expect((await q("select (select count(*)::int from wallet_topups where user_ref = $1) t, (select count(*)::int from payments where user_ref = $1) p", [user]))[0]).toEqual(before);
    const other = uid();
    expect((await start(other, 100_000_000)).amount).toBe(100_000_000); // another user is independent
  });

  it("in-flight (REQUESTED) AND completed top-ups count; a FAILED one frees its allowance", async () => {
    const user = uid();
    await paidTopUp(f, user, 100_000_000); // COMPLETED
    const inflight = await startedTopUp(f, user, 100_000_000); // REQUESTED, never confirmed
    const third = await startedTopUp(f, user, 100_000_000);
    expect(await code(start(user, 1_000_000))).toBe("WALLET_DAILY_LIMIT_EXCEEDED");
    expect(await getWalletBalance(f.app.db, user)).toBe(100_000_000); // only the completed one is credited
    f.gateway.script(third.gatewayRef, { status: "FAILED" });
    await completeTopUp(f.app.db, deps(f), { gatewayRef: third.gatewayRef, eventKey: uid("ev") });
    expect((await q("select status from wallet_topups where id = $1", [third.topupId]))[0]!.status).toBe("FAILED");
    expect((await start(user, 100_000_000)).amount).toBe(100_000_000); // allowance freed by the failure
    expect(await code(start(user, 1_000_000))).toBe("WALLET_DAILY_LIMIT_EXCEEDED");
    expect(inflight.topupId).toBeTruthy();
  });

  it("the day is the Asia/Tehran calendar day: it resets at 00:00 Tehran time (20:30:00Z), not at UTC midnight", async () => {
    const win = await tehranDayWindow(f.app.db, new Date("2026-06-01T10:00:00Z"));
    expect([win.start.toISOString(), win.end.toISOString()]).toEqual(["2026-05-31T20:30:00.000Z", "2026-06-01T20:30:00.000Z"]);
    const w2 = await tehranDayWindow(f.app.db, new Date("2026-06-01T20:30:00Z")); // the reset instant belongs to the NEW day
    expect(w2.start.toISOString()).toBe("2026-06-01T20:30:00.000Z");
    const w3 = await tehranDayWindow(f.app.db, new Date("2026-06-01T20:29:59.999Z"));
    expect(w3.start.toISOString()).toBe("2026-05-31T20:30:00.000Z");
    const w4 = await tehranDayWindow(f.app.db, new Date("2026-12-21T10:00:00Z")); // winter: no daylight saving in Iran since 2022
    expect(w4.start.toISOString()).toBe("2026-12-20T20:30:00.000Z");

    const user = uid();
    f.clock.set("2026-06-01T20:00:00Z"); // 23:30 Tehran
    for (let i = 0; i < 3; i++) await start(user, 100_000_000);
    f.clock.set("2026-06-01T20:29:59Z"); // one second before Tehran midnight: still the same Tehran day
    expect(await code(start(user, 1_000_000))).toBe("WALLET_DAILY_LIMIT_EXCEEDED");
    f.clock.set("2026-06-01T20:30:00Z"); // Tehran midnight: new day
    expect((await start(user, 100_000_000)).amount).toBe(100_000_000);
    // UTC midnight is NOT a reset: 20:30Z (00:00 Tehran) opened a new day; two more top-ups at 23:59Z (03:29 Tehran) fill exactly its 300,000,000
    f.clock.set("2026-06-01T23:59:00Z");
    await start(user, 100_000_000);
    await start(user, 100_000_000);
    f.clock.set("2026-06-02T00:30:00Z"); // after UTC midnight, still the same Tehran day (04:00 Tehran)
    expect(await code(start(user, 1_000_000))).toBe("WALLET_DAILY_LIMIT_EXCEEDED");
    f.clock.set("2026-06-02T20:30:00Z"); // next Tehran midnight
    expect((await start(user, 1_000_000)).amount).toBe(1_000_000);
    f.clock.set("2026-06-01T10:00:00Z");
  });

  it("a settings change never alters a top-up already started: replays succeed even beyond the new limits, and its recorded limits version is immutable", async () => {
    const user = uid();
    const key = uid("k");
    const t = await start(user, 100_000_000, key);
    const v1 = (await q("select limits_version from wallet_topups where id = $1", [t.topupId]))[0]!.limits_version;
    expect(v1).toBe((await getTopUpLimits(f.app.db)).version);
    const r = await requestLimitChange(walletCtx(f, "req-7"), { minRial: 1_000_000, maxRial: 10_000_000, dailyMaxRial: 20_000_000, reason: "much tighter limits afterwards" });
    await decideLimitChange(walletCtx(f, "app-7"), r.requestId, { approve: true, reason: "tightened for the test" });
    const again = await start(user, 100_000_000, key); // 100M now exceeds both max and daily — but this top-up already started
    expect(again).toMatchObject({ topupId: t.topupId, replay: true });
    expect(await code(start(user, 100_000_000))).toBe("WALLET_INVALID"); // a NEW one is judged by the new limits
    expect((await q("select limits_version from wallet_topups where id = $1", [t.topupId]))[0]!.limits_version).toBe(v1);
    expect(await ownerSql("update wallet_topups set limits_version = 99 where id = $1", [t.topupId])).toBe("PI001");
    const back = await requestLimitChange(walletCtx(f, "req-8"), { minRial: 1_000_000, maxRial: 100_000_000, dailyMaxRial: 300_000_000, reason: "restore the approved defaults" });
    await decideLimitChange(walletCtx(f, "app-8"), back.requestId, { approve: true, reason: "restore defaults" });
  });

  it("replaying an existing top-up is never refused by the daily limit", async () => {
    const user = uid();
    const keys = [uid("k"), uid("k"), uid("k")];
    for (const k of keys) await start(user, 100_000_000, k);
    expect(await code(start(user, 1_000_000))).toBe("WALLET_DAILY_LIMIT_EXCEEDED");
    for (const k of keys) expect(await start(user, 100_000_000, k)).toMatchObject({ replay: true });
  });

  it("the wallet stays ledger-based: there is no balance column and a completed top-up credits exactly the ledger", async () => {
    expect(await q("select 1 from information_schema.columns where table_name like 'wallet%' and column_name ilike '%balance%'")).toHaveLength(0);
    const user = uid();
    await paidTopUp(f, user, 5_000_000);
    expect(await getWalletBalance(f.app.db, user)).toBe(5_000_000);
  });
});
