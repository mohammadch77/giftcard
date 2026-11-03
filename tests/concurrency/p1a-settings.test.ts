import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideLimitChange, getTopUpLimits, requestLimitChange, startTopUp } from "@/modules/wallet";
import { getOrderSettings, setReservationTtl } from "@/modules/orders";
import { gatewayCheckout, orderFixture, stockedVariant, userId } from "../helpers/orders";
import type { OrderFixture } from "../helpers/orders";
import { deps, payFixture, uid, walletCtx } from "../helpers/payments";
import type { PayFixture } from "../helpers/payments";

const settle = async (ps: Promise<unknown>[]) => Promise.allSettled(ps);
const codeOf = (r: PromiseSettledResult<unknown>) => (r.status === "rejected" ? ((r.reason as { code?: string }).code ?? "OTHER") : "OK");

describe("B5 daily limit is concurrency-safe", () => {
  let f: PayFixture;
  beforeAll(async () => { f = await payFixture({ testLimits: false }); });
  afterAll(async () => { await f?.app.close(); await f?.t.drop(); });
  const start = (user: string, amount: number) => startTopUp(f.app.db, deps(f), { userId: user, amount, idempotencyKey: uid("k") });
  const q = async <T = Record<string, unknown>>(s: string, p: unknown[] = []) => (await f.t.pool.query(s, p)).rows as T[];

  it("16 parallel 100,000,000 top-ups of ONE user: exactly 3 succeed (300,000,000), 13 are refused, the stored total never exceeds the limit", async () => {
    const user = uid();
    const res = await settle(Array.from({ length: 16 }, () => start(user, 100_000_000)));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(res.filter((r) => codeOf(r) === "WALLET_DAILY_LIMIT_EXCEEDED")).toHaveLength(13);
    expect(res.every((r) => r.status === "fulfilled" || codeOf(r) === "WALLET_DAILY_LIMIT_EXCEEDED")).toBe(true);
    const row = (await q<{ n: number; total: string }>("select count(*)::int n, coalesce(sum(amount), 0) total from wallet_topups where user_ref = $1", [user]))[0]!;
    expect(row.n).toBe(3);
    expect(Number(row.total)).toBe(300_000_000);
    expect((await q("select count(*)::int c from payments where user_ref = $1", [user]))[0]!.c).toBe(3); // refused attempts leave no payment behind
  });

  it("mixed amounts from several users in parallel: every user ends at or under the limit, and no user is blocked by another", async () => {
    const users = [uid(), uid(), uid()];
    const amounts = [40_000_000, 90_000_000, 70_000_000, 100_000_000, 30_000_000, 60_000_000, 80_000_000, 20_000_000];
    const res = await settle(users.flatMap((u) => amounts.map((a) => start(u, a))));
    expect(res.every((r) => r.status === "fulfilled" || codeOf(r) === "WALLET_DAILY_LIMIT_EXCEEDED")).toBe(true);
    for (const u of users) {
      const total = Number((await q<{ t: string }>("select coalesce(sum(amount), 0) t from wallet_topups where user_ref = $1", [u]))[0]!.t);
      expect(total).toBeLessThanOrEqual(300_000_000);
      expect(total).toBeGreaterThan(0);
    }
  });

  it("the same idempotency key from 20 parallel requests is ONE top-up and does not consume extra allowance", async () => {
    const user = uid();
    const key = uid("k");
    const res = await settle(Array.from({ length: 20 }, () => startTopUp(f.app.db, deps(f), { userId: user, amount: 100_000_000, idempotencyKey: key })));
    expect(res.every((r) => r.status === "fulfilled")).toBe(true);
    expect((await q("select count(*)::int c from wallet_topups where user_ref = $1", [user]))[0]!.c).toBe(1);
    await start(user, 100_000_000);
    await start(user, 100_000_000); // 300M used; only the single real top-up counted once
  });

  it("two requests approved concurrently against the same active version: exactly one wins, the other is STALE", async () => {
    const a = await requestLimitChange(walletCtx(f, "req-a"), { minRial: 2_000_000, maxRial: 80_000_000, dailyMaxRial: 250_000_000, reason: "competing request A" });
    const b = await requestLimitChange(walletCtx(f, "req-b"), { minRial: 3_000_000, maxRial: 70_000_000, dailyMaxRial: 240_000_000, reason: "competing request B" });
    const res = await settle([
      decideLimitChange(walletCtx(f, "approver-1"), a.requestId, { approve: true, reason: "approve request A now" }),
      decideLimitChange(walletCtx(f, "approver-2"), b.requestId, { approve: true, reason: "approve request B now" }),
    ]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(res.map(codeOf).sort()).toEqual(["OK", "SETTINGS_STALE"]);
    expect((await getTopUpLimits(f.app.db)).version).toBe(2);
    expect((await q("select count(*)::int c from wallet_limit_versions where approved_seq is not null"))[0]!.c).toBe(2); // seed + exactly one
  });
});

describe("B3 order settings are concurrency-safe", () => {
  let o: OrderFixture;
  beforeAll(async () => { o = await orderFixture(); });
  afterAll(async () => { await o?.app.close(); await o?.t.drop(); });
  const admin = (id: string) => ({ db: o.app.db, clock: o.clock, actor: { type: "ADMIN" as const, id }, authorize: async () => undefined });
  const q = async <T = Record<string, unknown>>(s: string, p: unknown[] = []) => (await o.t.pool.query(s, p)).rows as T[];

  it("10 parallel TTL changes produce 10 contiguous versions and every one succeeds in sequence", async () => {
    const res = await settle(Array.from({ length: 10 }, (_, i) => setReservationTtl(admin(`admin-${i}`), { reservationTtlSeconds: 100 + i * 10, reason: `parallel change number ${i}` })));
    expect(res.every((r) => r.status === "fulfilled")).toBe(true);
    const versions = (await q<{ version: number }>("select version from order_settings_versions order by version")).map((r) => r.version);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect((await q("select count(*)::int c from audit_logs where action = 'orders.settings.reservation_ttl_changed'"))[0]!.c).toBe(10);
    expect((await getOrderSettings(o.app.db)).version).toBe(11);
  });

  it("checkouts racing with TTL changes: every order is internally consistent (snapshot TTL = the TTL of the version it names = its real expiry)", async () => {
    const { variantId } = await stockedVariant(o, 30);
    const changes = [120, 600, 1800, 3000, 900].map((t, i) => setReservationTtl(admin(`racer-${i}`), { reservationTtlSeconds: t, reason: `race change to ${t} seconds` }));
    const orders = Array.from({ length: 12 }, () => gatewayCheckout(o, userId(), [{ variantId, quantity: 1 }]));
    const res = await settle([...changes, ...orders]);
    expect(res.filter((r) => r.status === "rejected")).toEqual([]);
    const rows = await q<{ ttl: number; ver: number; secs: string; tbl: number }>(
      `select (o.policy_snapshot->>'reservationTtlSeconds')::int ttl, (o.policy_snapshot->>'orderSettingsVersion')::int ver,
              extract(epoch from (o.expires_at - o.created_at)) secs, s.reservation_ttl_seconds tbl
         from orders o join order_settings_versions s on s.version = (o.policy_snapshot->>'orderSettingsVersion')::int where o.policy_snapshot->>'backfilled' = 'false'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(12);
    for (const r of rows) {
      expect(r.ttl).toBe(r.tbl);
      expect(Number(r.secs)).toBe(r.ttl);
    }
  });
});
