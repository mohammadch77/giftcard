import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changeFulfillmentMethod, createProduct, createVariant, setVariantStatus } from "@/modules/catalog";
import type { AdminContext } from "@/modules/catalog";
import { fulfillmentVariantUsage } from "@/modules/fulfillment";
import { adjustStock, availability, expireDueCodes, importCodes, inventoryVariantUsage, reserve, verifyInventory } from "@/modules/inventory";
import { orderVariantUsage } from "@/modules/orders";
import { supplierVariantUsage } from "@/modules/suppliers";
import { withTransaction } from "@/platform/db";
import { adminCtx, uniq } from "../helpers/catalog";
import { invCtx, makeCodes, sellableVariant } from "../helpers/inventory";
import { orderFixture } from "../helpers/orders";
import type { OrderFixture } from "../helpers/orders";

let f: OrderFixture;
beforeAll(async () => { f = await orderFixture(); });
afterAll(async () => { await f?.app.close(); await f?.t.drop(); });

const BASE = new Date("2026-06-01T10:00:00Z").getTime();
const at = (minutes: number) => new Date(BASE + minutes * 60_000);
let k = 0;
const key = () => `p1b-${++k}-${Math.random().toString(36).slice(2, 7)}`;
const res = (variantId: string, quantity = 1) => {
  const reservationKey = key();
  return withTransaction(f.app.db, (tx) => reserve(tx, f.clock, { reservationKey, orderRef: `o-${reservationKey}`, lines: [{ variantId, quantity }] }));
};
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string }) => e.code ?? "ERR");
const healthy = async () => expect(await verifyInventory(f.app.db)).toEqual([]);
const PROBES = [inventoryVariantUsage, fulfillmentVariantUsage, supplierVariantUsage, orderVariantUsage];
const ctx = (): AdminContext => ({ ...adminCtx(f), usage: PROBES });

describe("OPS-2 — the expiry sweeper under contention", () => {
  it("12 sweepers over 600 expired codes: every code expires exactly once, one movement each, counters exact", async () => {
    f.clock.set(at(0));
    const v = await sellableVariant(f);
    for (let i = 0; i < 3; i++) await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: makeCodes(200).map((c) => ({ code: c, expiresAt: at(10) })) });
    await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: makeCodes(40) }); // no expiry: must survive
    f.clock.set(at(20));
    const runs = await Promise.all(Array.from({ length: 12 }, async () => {
      let total = 0;
      for (;;) {
        const r = await expireDueCodes(f.app.db, f.clock, { batchSize: 50 });
        if (r.expired === 0) return total;
        total += r.expired;
      }
    }));
    expect(runs.reduce((a, b) => a + b, 0)).toBe(600);
    const st = Object.fromEntries((await f.t.pool.query("select status, count(*)::int n from digital_codes where variant_id = $1 group by status", [v])).rows.map((r) => [r.status, r.n]));
    expect(st).toEqual({ AVAILABLE: 40, EXPIRED: 600 });
    const moves = (await f.t.pool.query("select count(*)::int n, count(distinct code_id)::int d from inventory_movements where variant_id = $1 and type = 'CODE_EXPIRE'", [v])).rows[0];
    expect(moves).toEqual({ n: 600, d: 600 });
    expect((await availability(f.app.db, [v], f.clock.now()))[0]).toMatchObject({ itemisedAvailable: 40, itemisedReserved: 0 });
    await healthy();
    f.clock.set(at(0));
  }, 120_000);

  it("sweepers racing 60 reservations: an expiring code is never reserved, nothing is double-counted, the integrity report stays clean", async () => {
    f.clock.set(at(0));
    const v = await sellableVariant(f);
    const expiring = makeCodes(30), steady = makeCodes(30), outliving = makeCodes(30);
    await importCodes(invCtx(f), v, {
      payloadKind: "CODE",
      codes: [...expiring.map((c) => ({ code: c, expiresAt: at(10) })), ...outliving.map((c) => ({ code: c, expiresAt: at(16) })), ...steady],
    });
    // phase 1 (t = 0, holds end at +15): codes expiring at +10 are off limits; +16 and "never" are fair game
    const p1 = await Promise.all([...Array.from({ length: 40 }, () => outcome(res(v))), ...Array.from({ length: 4 }, () => outcome(expireDueCodes(f.app.db, f.clock)))]);
    expect(p1.filter((x) => x === "OK").length).toBe(44); // 40 reservations + 4 sweeps (which find nothing yet)
    let reservedExpiries = (await f.t.pool.query("select expires_at from digital_codes where variant_id = $1 and status = 'RESERVED'", [v])).rows.map((r) => r.expires_at);
    expect(reservedExpiries).toHaveLength(40);
    expect(reservedExpiries.every((e) => e === null || e.getTime() === at(16).getTime())).toBe(true);
    // phase 2 (t = +11, holds end at +26): only never-expiring codes may be reserved; the +10 ones are being expired concurrently
    f.clock.set(at(11));
    const p2 = await Promise.all([...Array.from({ length: 40 }, () => outcome(res(v))), ...Array.from({ length: 6 }, () => outcome(expireDueCodes(f.app.db, f.clock, { batchSize: 7 })))]);
    const ok2 = p2.slice(0, 40).filter((x) => x === "OK").length;
    expect(p2.slice(0, 40).every((x) => x === "OK" || x === "INVENTORY_INSUFFICIENT")).toBe(true);
    expect(p2.slice(40).every((x) => x === "OK")).toBe(true);
    reservedExpiries = (await f.t.pool.query("select expires_at from digital_codes where variant_id = $1 and status = 'RESERVED'", [v])).rows.map((r) => r.expires_at);
    expect(reservedExpiries).toHaveLength(40 + ok2);
    // nothing reserved after +11 may expire before its hold ends (+26): only "never expires" codes qualify
    const late = (await f.t.pool.query("select expires_at from digital_codes where variant_id = $1 and status = 'RESERVED' and reserved_until > $2", [v, at(20)])).rows;
    expect(late).toHaveLength(ok2);
    expect(late.every((r) => r.expires_at === null)).toBe(true);
    await expireDueCodes(f.app.db, f.clock, { batchSize: 1000 });
    const st = Object.fromEntries((await f.t.pool.query("select status, count(*)::int n from digital_codes where variant_id = $1 group by status", [v])).rows.map((r) => [r.status, r.n]));
    expect(st.EXPIRED).toBe(30); // exactly the +10 codes
    expect((st.RESERVED ?? 0)).toBe(40 + ok2);
    expect((st.RESERVED ?? 0) + (st.AVAILABLE ?? 0)).toBe(60);
    await healthy();
    f.clock.set(at(0));
  }, 120_000);
});

describe("C-2 — the protected change against concurrent checkout", () => {
  it("a reservation being created holds the variant: the unpublish + method change wait for it, then see it and refuse", async () => {
    const v = await sellableVariant(f, "MANUAL");
    await adjustStock(invCtx(f), v, 5, "opening manual stock");
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let reserved!: () => void;
    const reservedP = new Promise<void>((r) => { reserved = r; });
    const holder = withTransaction(f.app.db, async (tx) => {
      const rk = key();
      await reserve(tx, f.clock, { reservationKey: rk, orderRef: `o-${rk}`, lines: [{ variantId: v, quantity: 1 }] });
      reserved();
      await gate; // the checkout transaction stays open (variant locked FOR SHARE)
    });
    await reservedP;
    let settled = false;
    const change = (async () => {
      await setVariantStatus(adminCtx(f), v, "DRAFT", "rework the offer now");
      return changeFulfillmentMethod(ctx(), v, { to: "SUPPLIER_API", reason: "switching while checkout runs" });
    })().then(() => "CHANGED", (e: { code?: string }) => e.code ?? "ERR").finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 700));
    expect(settled).toBe(false); // blocked behind the open reservation, it cannot slip in
    release();
    await holder;
    expect(await change).toBe("CATALOG_VARIANT_IN_USE");
    expect((await f.t.pool.query("select fulfillment_method m from product_variants where id = $1", [v])).rows[0].m).toBe("MANUAL");
    await healthy();
  }, 60_000);

  it("20 concurrent protected changes of one variant: exactly one is recorded, the rest see the new state and are refused", async () => {
    const p = await createProduct(adminCtx(f), { type: "DIGITAL_SERVICE", brandId: f.base.brand, categoryId: f.base.category, slug: uniq("race"), name: "Race" });
    const v = await createVariant(adminCtx(f), p.id, { sku: uniq("R"), name: "R", fulfillmentMethod: "MANUAL", price: 1_000_000 });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => outcome(changeFulfillmentMethod({ ...ctx(), actor: { type: "ADMIN", id: `admin-${i}` } }, v.id, { to: "SUPPLIER_API", reason: `concurrent change number ${i}` }))));
    expect(results.filter((r) => r === "OK")).toHaveLength(1);
    expect(results.filter((r) => r === "CATALOG_INVALID")).toHaveLength(19);
    expect((await f.t.pool.query("select count(*)::int n from variant_fulfillment_changes where variant_id = $1", [v.id])).rows[0].n).toBe(1);
    expect((await f.t.pool.query("select count(*)::int n from audit_logs where action = 'catalog.variant.fulfillment_changed' and entity_id = $1", [v.id])).rows[0].n).toBe(1);
  }, 60_000);
});
