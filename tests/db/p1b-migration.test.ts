import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pgCode, createTestDatabase } from "../helpers/db";
import type { TestDatabase } from "../helpers/db";

/**
 * Migrations 0026/0027 tighten the fulfilment matrix and add expiry/game columns to tables that may already hold data. This suite builds a database at
 * the state of migration 0025, fills it with historical data (including variants the new matrix no longer allows), applies 0026 + 0027 and proves that
 * NOTHING historical is rewritten while the new rules apply from then on.
 */
const dir = path.resolve(process.cwd(), "db/migrations");
const chunks = (file: string) => readFileSync(path.join(dir, file), "utf8").split("--> statement-breakpoint").map((c) => c.trim()).filter(Boolean);
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

let t: TestDatabase | undefined;
afterAll(async () => { await t?.drop(); });

async function apply(db: TestDatabase, names: string[]): Promise<void> {
  for (const n of names) for (const c of chunks(n)) await db.pool.query(c);
}
const id = (n: number) => `0190b000-0000-7000-8000-${String(n).padStart(12, "0")}`;

describe("migration 0026/0027 on a database that already contains catalog, stock and orders", () => {
  it("keeps every historical row byte-for-byte, tightens the matrix, and applies the new rules only going forward", async () => {
    t = await createTestDatabase({ migrate: false });
    const upTo0025 = files.filter((f) => f < "0026");
    expect(upTo0025.at(-1)).toBe("0025_p1a_settings_guards.sql");
    await apply(t, upTo0025);

    const c = await t.pool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.actor_id', 'legacy-seed', true), set_config('app.reason', 'legacy data for the migration test', true)");
      await c.query(`insert into brands (id, slug, name, created_at, updated_at) values ('${id(1)}', 'legacy-brand', 'Legacy', now(), now())`);
      await c.query(`insert into categories (id, slug, name, created_at, updated_at) values ('${id(2)}', 'legacy-cat', 'Legacy', now(), now())`);
      const products: [number, string][] = [[10, "GIFT_CARD"], [11, "GAME_ACCOUNT"], [12, "GAME_SUBSCRIPTION"], [13, "DIGITAL_SERVICE"]];
      for (const [n, type] of products) {
        await c.query(`insert into products (id, type, brand_id, category_id, slug, name, status, created_at, updated_at) values ('${id(n)}', '${type}', '${id(1)}', '${id(2)}', 'legacy-${n}', 'Legacy ${n}', 'DRAFT', now(), now())`);
      }
      // (variant, product, method): the first four are what the OLD matrix allowed and the NEW one does not
      const variants: [number, number, string][] = [[20, 10, "MANUAL"], [21, 10, "SUPPLIER_API"], [22, 11, "AUTO_CODE"], [23, 12, "AUTO_CODE"], [24, 10, "AUTO_CODE"], [25, 11, "MANUAL"], [26, 13, "SUPPLIER_API"]];
      for (const [n, p, m] of variants) {
        await c.query(`insert into product_variants (id, product_id, sku, name, fulfillment_method, price, status, availability, created_at, updated_at) values ('${id(n)}', '${id(p)}', 'SKU-${n}', 'Variant ${n}', '${m}', 1000000, 'DRAFT', 'AVAILABLE', now(), now())`);
      }
      await c.query(`update products set status = 'PUBLISHED' where id in ('${id(10)}', '${id(11)}')`);
      await c.query(`update product_variants set status = 'PUBLISHED' where id in ('${id(20)}', '${id(24)}')`); // one grandfathered (GIFT_CARD/MANUAL), one compliant
      // stock: a batch with an available, a void and a counted row; and a legacy order with its snapshots
      await c.query(`insert into inventory_batches (id, variant_id, code_count, created_by, created_at) values ('${id(30)}', '${id(24)}', 2, 'legacy-seed', now())`);
      for (const [n, status] of [[31, "AVAILABLE"], [32, "VOID"]] as const) {
        await c.query(
          `insert into digital_codes (id, variant_id, batch_id, code_fp, hmac_version, sealed, payload_kind, status, created_at, updated_at)
           values ('${id(n)}', '${id(24)}', '${id(30)}', decode(md5('fp${n}') || md5('fp${n}x'), 'hex'), 1, decode('00', 'hex'), 'CODE', 'AVAILABLE', now(), now())`,
        );
        if (status === "VOID") await c.query(`update digital_codes set status = 'VOID' where id = '${id(n)}'`);
      }
      await c.query(`insert into stock_counters (variant_id, available, reserved, updated_at) values ('${id(20)}', 7, 0, now())`);
      await c.query(
        `insert into orders (id, number, user_ref, payment_method, total, pricing_version, refund_policy_version, policy_snapshot, idempotency_key, request_hash, expires_at, created_at, updated_at)
         values ('${id(40)}', 'LEGACY-1', 'legacy-user', 'WALLET', 1000000, 'pv-1', 'temporary-0', '{"refundPolicyVersion":"temporary-0","backfilled":false,"reservationTtlSeconds":900}'::jsonb, 'legacy-1', decode('01', 'hex'), now() + interval '15 minutes', now(), now())`,
      );
      await c.query(
        `insert into order_items (id, order_id, line_no, variant_id, quantity, unit_price, line_total, snapshot, created_at)
         values ('${id(41)}', '${id(40)}', 1, '${id(20)}', 1, 1000000, 1000000, '{"fulfillmentMethod":"MANUAL","productType":"GIFT_CARD","name":"Variant 20"}'::jsonb, now())`,
      );
      await c.query("commit");
    } catch (e) {
      await c.query("rollback");
      throw e;
    } finally {
      c.release();
    }

    const q = async (sql: string, p: unknown[] = []) => (await t!.pool.query(sql, p)).rows;
    const snapshot = async () => ({
      variants: await q("select to_jsonb(v) - 'platform_id' as j from product_variants v order by id"),
      products: await q("select to_jsonb(p) - 'game_id' as j from products p order by id"),
      codes: await q("select to_jsonb(c) - 'expires_at' as j from digital_codes c order by id"),
      batches: await q("select to_jsonb(b) - 'expires_at' as j from inventory_batches b order by id"),
      counters: await q("select to_jsonb(s) as j from stock_counters s order by variant_id"),
      orders: await q("select to_jsonb(o) as j from orders o order by id"),
      items: await q("select to_jsonb(i) as j from order_items i order by id"),
      movements: await q("select count(*)::int n from inventory_movements"),
      history: await q("select count(*)::int n from variant_status_history"),
    });
    const before = await snapshot();
    expect(before.variants).toHaveLength(7);

    await apply(t, ["0026_p1b_catalog_inventory_tables.sql", "0027_p1b_catalog_inventory_guards.sql"]);

    // 1. nothing historical changed
    expect(await snapshot()).toEqual(before);
    // 2. the new columns exist, are NULL for history, and the new tables are empty
    expect((await q("select count(*)::int n from product_variants where platform_id is not null")) [0].n).toBe(0);
    expect((await q("select count(*)::int n from products where game_id is not null")) [0].n).toBe(0);
    expect((await q("select count(*)::int n from digital_codes where expires_at is not null")) [0].n).toBe(0);
    for (const tbl of ["games", "platforms", "game_platforms", "game_platform_regions", "game_account_attributes", "variant_fulfillment_changes"]) expect((await q(`select count(*)::int n from ${tbl}`))[0].n, tbl).toBe(0);
    // 3. the matrix is the approved one, exactly
    const matrix: Record<string, string[]> = {};
    for (const r of await q("select product_type, method from product_type_fulfillment order by product_type, method")) (matrix[r.product_type] ??= []).push(r.method);
    expect(matrix).toEqual({
      DIGITAL_SERVICE: ["MANUAL", "SUPPLIER_API"], GAME_ACCOUNT: ["MANUAL"], GAME_SUBSCRIPTION: ["MANUAL", "SUPPLIER_API"], GIFT_CARD: ["AUTO_CODE"],
      OTHER: ["AUTO_CODE", "MANUAL", "SUPPLIER_API"], STREAMING_SUBSCRIPTION: ["MANUAL", "SUPPLIER_API"],
    });
    // 4. grandfathered variants keep working but cannot be PUBLISHED again; compliant ones can
    const err = (sql: string, p: unknown[] = []) => t!.pool.query(sql, p).then(() => "ok", (e: unknown) => pgCode(e));
    const actor = async (sql: string) => {
      const k = await t!.pool.connect();
      try {
        await k.query("begin");
        await k.query("select set_config('app.actor_id', 'admin', true), set_config('app.reason', 'post-migration check', true)");
        const r = await k.query(sql).then(() => "ok", (e: unknown) => pgCode(e));
        await k.query("rollback");
        return r;
      } finally {
        k.release();
      }
    };
    expect(await actor(`update product_variants set status = 'DRAFT' where id = '${id(20)}'`)).toBe("ok");
    expect(await actor(`update product_variants set status = 'DRAFT' where id = '${id(20)}'; update product_variants set status = 'PUBLISHED' where id = '${id(20)}'`)).toBe("PC003"); // grandfathered: not publishable again
    expect(await actor(`update product_variants set status = 'DRAFT' where id = '${id(24)}'; update product_variants set status = 'PUBLISHED' where id = '${id(24)}'`)).toBe("ok");
    // the method of ANY variant changes only through the recorded protected change
    expect(await err(`update product_variants set fulfillment_method = 'AUTO_CODE' where id = '${id(21)}'`)).toBe("PC003");
    // 5. expiry: history is unexpired stock; the guards apply from now on
    expect((await q("select status from digital_codes order by id")).map((r) => r.status)).toEqual(["AVAILABLE", "VOID"]);
    expect(await err(`update digital_codes set expires_at = now() where id = '${id(31)}'`)).toBe("PI001");
    // 6. the owner role holds the new permission and nothing else was added
    const perms = (await q("select rp.permission from role_permissions rp join roles r on r.id = rp.role_id where r.name = 'owner' and rp.permission = 'catalog.fulfillment.change'")).map((r) => r.permission);
    expect(perms).toEqual(["catalog.fulfillment.change"]);
    expect((await q("select count(*)::int n from role_permissions rp join roles r on r.id = rp.role_id where r.name <> 'owner' and rp.permission = 'catalog.fulfillment.change'"))[0].n).toBe(0);
    // 7. a code can be marked EXPIRED only once its (supplier-provided) expiry has passed; unexpiring history stays as it is
    expect(await err(`update digital_codes set status = 'EXPIRED', updated_at = now() where id = '${id(31)}'`)).toBe("PV003");
  }, 180_000);
});
