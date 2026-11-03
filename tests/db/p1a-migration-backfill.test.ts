import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pgCode, createTestDatabase } from "../helpers/db";
import type { TestDatabase } from "../helpers/db";

/**
 * Migration 0024 adds NOT NULL snapshot columns to a table that may already hold orders. This suite builds a database at the state of
 * migration 0023, inserts LEGACY orders (no snapshot columns exist yet), applies 0024 + 0025 and checks the backfill: derived only from
 * facts already recorded, flagged, immutable afterwards, and nothing else about the orders changes.
 */
const dir = path.resolve(process.cwd(), "db/migrations");
const chunks = (file: string) => readFileSync(path.join(dir, file), "utf8").split("--> statement-breakpoint").map((c) => c.trim()).filter(Boolean);
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

let t: TestDatabase | undefined;
afterAll(async () => { await t?.drop(); });

async function apply(db: TestDatabase, names: string[]): Promise<void> {
  for (const n of names) for (const c of chunks(n)) await db.pool.query(c);
}

describe("migration 0024/0025 on a database that already contains orders", () => {
  it("backfills legacy orders from recorded facts, flags them, then locks the columns", async () => {
    t = await createTestDatabase({ migrate: false });
    const upTo0023 = files.filter((f) => f < "0024");
    expect(upTo0023.at(-1)).toBe("0023_refunds_guards.sql");
    await apply(t, upTo0023);

    // Two legacy orders created under the only policy that existed ('temporary-0'): TTL 900 s with an AUTO_CODE item, TTL 1800 s with MANUAL + AUTO_CODE items.
    const legacy = async (id: string, number: string, ttlSeconds: number, methods: string[]) => {
      const c = await t!.pool.connect();
      try {
        await c.query("begin");
        await c.query("select set_config('app.actor_id', 'legacy-seed', true), set_config('app.reason', 'legacy order for the migration test', true)");
        await c.query(
          `insert into orders (id, number, user_ref, payment_method, total, pricing_version, idempotency_key, request_hash, expires_at, created_at, updated_at)
           values ($1, $2, 'legacy-user', 'WALLET', $3, 'pv-1', $2, '\\x01', '2026-01-01T00:00:00Z'::timestamptz + make_interval(secs => $4), '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
          [id, number, methods.length * 1_000_000, ttlSeconds],
        );
        for (const [i, m] of methods.entries()) {
          await c.query(
            `insert into order_items (id, order_id, line_no, variant_id, quantity, unit_price, line_total, snapshot, created_at)
             values (gen_random_uuid(), $1, $2, gen_random_uuid(), 1, 1000000, 1000000, $3::jsonb, '2026-01-01T00:00:00Z')`,
            [id, i + 1, JSON.stringify({ fulfillmentMethod: m, name: `item ${i}` })],
          );
        }
        await c.query("commit");
      } catch (e) {
        await c.query("rollback");
        throw e;
      } finally {
        c.release();
      }
    };
    const a = "0190a000-0000-7000-8000-00000000000a";
    const b = "0190a000-0000-7000-8000-00000000000b";
    await legacy(a, "LEGACY-A", 900, ["AUTO_CODE"]);
    await legacy(b, "LEGACY-B", 1800, ["MANUAL", "AUTO_CODE"]);
    const rowBefore = async (id: string) => (await t!.pool.query("select to_jsonb(o) - 'refund_policy_version' - 'policy_snapshot' as j from orders o where id = $1", [id])).rows[0].j;
    const beforeA = await rowBefore(a);
    const beforeB = await rowBefore(b);

    await apply(t, ["0024_p1a_settings_tables.sql", "0025_p1a_settings_guards.sql"]);

    const o = (await t.pool.query("select id, refund_policy_version, policy_snapshot from orders order by number")).rows;
    expect(o).toHaveLength(2);
    expect(o[0].refund_policy_version).toBe("temporary-0");
    expect(o[0].policy_snapshot).toEqual({
      schema: 1, backfilled: true, backfilledBy: "0024_p1a_settings_tables", refundPolicyVersion: "temporary-0",
      reservationTtlSeconds: 900, orderSettingsVersion: null, fulfillmentRules: null, itemFulfillmentMethods: ["AUTO_CODE"],
    });
    expect(o[1].policy_snapshot).toMatchObject({ backfilled: true, reservationTtlSeconds: 1800, itemFulfillmentMethods: ["AUTO_CODE", "MANUAL"] });
    // nothing else about a historical order changed
    expect(await rowBefore(a)).toEqual(beforeA);
    expect(await rowBefore(b)).toEqual(beforeB);

    // the columns are now mandatory and immutable, and the rules apply to the backfilled rows too
    const err = (sql: string, p: unknown[] = []) => t!.pool.query(sql, p).then(() => "ok", (e: unknown) => pgCode(e));
    expect(await err("update orders set policy_snapshot = '{}'::jsonb where id = $1", [a])).toBe("PI001");
    expect(await err("update orders set refund_policy_version = 'temporary-0' where id = $1", [a])).toBe("ok"); // unchanged value is not a change
    expect((await t.pool.query("select is_nullable from information_schema.columns where table_name = 'orders' and column_name in ('refund_policy_version', 'policy_snapshot')")).rows.map((r) => r.is_nullable)).toEqual(["NO", "NO"]);

    // seeds: owner-approved defaults exist as version 1 of their module-owned settings
    expect((await t.pool.query("select version, reservation_ttl_seconds, source from order_settings_versions")).rows).toEqual([{ version: 1, reservation_ttl_seconds: 900, source: "SEED" }]);
    expect((await t.pool.query("select approved_seq, min_rial, max_rial, daily_max_rial, status, source from wallet_limit_versions")).rows).toEqual([
      { approved_seq: 1, min_rial: "1000000", max_rial: "100000000", daily_max_rial: "300000000", status: "APPROVED", source: "SEED" },
    ]);
    // owner permissions were seeded for the new settings
    const perms = (await t.pool.query("select rp.permission from role_permissions rp join roles r on r.id = rp.role_id where r.name = 'owner' and rp.permission like '%.settings.%' order by 1")).rows.map((r) => r.permission);
    expect(perms).toEqual(["orders.settings.manage", "orders.settings.read", "wallet.settings.approve", "wallet.settings.read", "wallet.settings.request"]);
  }, 180_000);
});
