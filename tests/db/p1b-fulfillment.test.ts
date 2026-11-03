import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FULFILLMENT_COMPATIBILITY, PRODUCT_TYPES, changeFulfillmentMethod, createProduct, createVariant, listIncompatibleVariants, setProductStatus, setVariantStatus, updateVariant,
} from "@/modules/catalog";
import type { AdminContext, FulfillmentMethod, ProductType } from "@/modules/catalog";
import { createTasks, fulfillmentVariantUsage } from "@/modules/fulfillment";
import { adjustStock, importCodes, inventoryVariantUsage, reserve, setCodeStatus } from "@/modules/inventory";
import { cancelOrder, orderVariantUsage } from "@/modules/orders";
import { deactivateRoute, getRoutes, supplierVariantUsage } from "@/modules/suppliers";
import { withTransaction } from "@/platform/db";
import { pgCode } from "../helpers/db";
import { adminCtx, uniq } from "../helpers/catalog";
import { invCtx, makeCodes, sellableVariant } from "../helpers/inventory";
import { gatewayCheckout, orderFixture, ordersDeps, userId } from "../helpers/orders";
import type { OrderFixture } from "../helpers/orders";
import { readySupplier, routedVariant, seedPaidOrder, supCtx } from "../helpers/suppliers";

let f: OrderFixture;
beforeAll(async () => { f = await orderFixture(); });
afterAll(async () => { await f?.app.close(); await f?.t.drop(); });

const PROBES = [inventoryVariantUsage, fulfillmentVariantUsage, supplierVariantUsage, orderVariantUsage];
const ctx = (allowed: "all" | string[] = "all", usage: AdminContext["usage"] = PROBES, actorId = "admin-1"): AdminContext => ({ ...adminCtx(f, allowed, actorId), usage });
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return { code: (e as { code?: string }).code ?? "OTHER", message: (e as Error).message }; } return { code: "NO_ERROR", message: "" }; };
const sqlCode = (q: string, p: unknown[] = []) => f.t.pool.query(q, p).then(() => "ok", (e: unknown) => pgCode(e));
const appSqlCode = (q: string, p: unknown[] = []) => f.app.pool.query(q, p).then(() => "ok", (e: unknown) => pgCode(e));
const methodOf = async (id: string) => (await f.t.pool.query("select fulfillment_method m from product_variants where id = $1", [id])).rows[0].m as string;

/** The approved C-2 matrix, written out independently of the code under test. */
const APPROVED: Record<ProductType, FulfillmentMethod[]> = {
  GIFT_CARD: ["AUTO_CODE"],
  GAME_ACCOUNT: ["MANUAL"],
  GAME_SUBSCRIPTION: ["MANUAL", "SUPPLIER_API"],
  STREAMING_SUBSCRIPTION: ["MANUAL", "SUPPLIER_API"],
  DIGITAL_SERVICE: ["MANUAL", "SUPPLIER_API"],
  OTHER: ["AUTO_CODE", "MANUAL", "SUPPLIER_API"],
};
const METHODS: FulfillmentMethod[] = ["AUTO_CODE", "MANUAL", "SUPPLIER_API"];

/** Run raw SQL as the database owner inside a transaction that carries an acting administrator (the transition engine demands one), then roll back. */
async function rawInsert(q: string, p: unknown[]): Promise<string> {
  const c = await f.t.pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.actor_id', 'raw-admin', true), set_config('app.reason', 'raw insert check', true)");
    return await c.query(q, p).then(() => "ok", (e: unknown) => pgCode(e) ?? "ERR");
  } finally {
    await c.query("rollback");
    c.release();
  }
}

async function draftVariant(type: ProductType, method: FulfillmentMethod): Promise<{ product: string; variant: string }> {
  const c = ctx();
  const p = await createProduct(c, { type, brandId: f.base.brand, categoryId: f.base.category, slug: uniq("p"), name: "P" });
  const v = await createVariant(c, p.id, { sku: uniq("V"), name: "V", fulfillmentMethod: method, price: 1_000_000 });
  return { product: p.id, variant: v.id };
}

describe("C-2: the approved matrix", () => {
  it("the code mirror, the database table and the approved matrix are identical", async () => {
    expect(PRODUCT_TYPES.length).toBe(Object.keys(APPROVED).length);
    for (const t of PRODUCT_TYPES) expect([...FULFILLMENT_COMPATIBILITY[t]].sort(), t).toEqual([...APPROVED[t]].sort());
    const db: Record<string, string[]> = {};
    for (const r of (await f.t.pool.query("select product_type, method from product_type_fulfillment")).rows) (db[r.product_type] ??= []).push(r.method);
    for (const t of PRODUCT_TYPES) expect(db[t]!.slice().sort(), t).toEqual([...APPROVED[t]].sort());
    expect(Object.keys(db).sort()).toEqual([...PRODUCT_TYPES].sort());
  });

  it("every one of the 18 type × method combinations: allowed ones work, forbidden ones are refused by the service AND by the database", async () => {
    for (const type of PRODUCT_TYPES) {
      const p = await createProduct(ctx(), { type, brandId: f.base.brand, categoryId: f.base.category, slug: uniq("m"), name: "M" });
      for (const method of METHODS) {
        const allowed = APPROVED[type].includes(method);
        const viaService = await err(createVariant(ctx(), p.id, { sku: uniq("X"), name: "x", fulfillmentMethod: method, price: 1000 }));
        expect(viaService.code, `${type}/${method} via service`).toBe(allowed ? "NO_ERROR" : "CATALOG_INVALID");
        const raw = await rawInsert(`insert into product_variants (id, product_id, sku, name, fulfillment_method, price, created_at, updated_at) values (gen_random_uuid(), $1, $2, 'raw', $3, 100, now(), now())`, [p.id, uniq("R"), method]);
        expect(raw, `${type}/${method} via SQL`).toBe(allowed ? "ok" : "PC003");
      }
    }
  });

  it("the app role cannot change the matrix; the stated direction holds (gift cards auto, game accounts manual, subscriptions manual or supplier, nothing else sneaks in)", async () => {
    expect(await appSqlCode("insert into product_type_fulfillment (product_type, method) values ('GIFT_CARD', 'MANUAL')")).toBe("42501");
    expect(await appSqlCode("delete from product_type_fulfillment")).toBe("42501");
    expect(APPROVED.GIFT_CARD).toEqual(["AUTO_CODE"]);
    expect(APPROVED.GAME_ACCOUNT).toEqual(["MANUAL"]);
    for (const t of ["GAME_SUBSCRIPTION", "STREAMING_SUBSCRIPTION"] as const) expect(APPROVED[t]).toEqual(["MANUAL", "SUPPLIER_API"]);
  });
});

describe("C-2: the protected fulfilment-method change", () => {
  it("ordinary variant updates cannot touch the method (not a field), and neither can raw SQL by anyone without the recorded change", async () => {
    const { variant } = await draftVariant("DIGITAL_SERVICE", "MANUAL");
    expect((await err(updateVariant(ctx(), variant, { fulfillmentMethod: "SUPPLIER_API" }))).code).toBe("CATALOG_INVALID");
    expect(await methodOf(variant)).toBe("MANUAL");
    expect(await appSqlCode("update product_variants set fulfillment_method = 'SUPPLIER_API' where id = $1", [variant])).toBe("PC003");
    expect(await sqlCode("update product_variants set fulfillment_method = 'SUPPLIER_API' where id = $1", [variant])).toBe("PC003"); // even the owner
    // a change row committed by ANOTHER transaction does not authorise this one
    const c = await f.t.pool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.actor_id', 'forger', true)");
      await c.query("insert into variant_fulfillment_changes (variant_id, from_method, to_method, reason, actor_id, usage, changed_at) values ($1, 'MANUAL', 'SUPPLIER_API', 'forged earlier row', 'forger', '{}'::jsonb, now())", [variant]);
      await c.query("commit");
    } finally {
      c.release();
    }
    expect(await sqlCode("update product_variants set fulfillment_method = 'SUPPLIER_API' where id = $1", [variant])).toBe("PC003");
    expect(await methodOf(variant)).toBe("MANUAL");
    // the log needs an acting administrator and is append-only
    expect(await sqlCode("insert into variant_fulfillment_changes (variant_id, from_method, to_method, reason, actor_id, usage, changed_at) values ($1, 'MANUAL', 'SUPPLIER_API', 'no actor in context', 'x', '{}'::jsonb, now())", [variant])).toBe("PC004");
    expect(await sqlCode("update variant_fulfillment_changes set reason = 'rewritten history' where variant_id = $1", [variant])).not.toBe("ok");
    expect(await appSqlCode("delete from variant_fulfillment_changes")).toBe("42501");
  });

  it("succeeds for an unpublished, unused variant: permission + reason, recorded with the actor and the usage facts, audited, variant updated", async () => {
    const { variant } = await draftVariant("DIGITAL_SERVICE", "MANUAL");
    await changeFulfillmentMethod(ctx("all", PROBES, "admin-7"), variant, { to: "SUPPLIER_API", reason: "supplier now fulfils this product" });
    expect(await methodOf(variant)).toBe("SUPPLIER_API");
    const row = (await f.t.pool.query("select * from variant_fulfillment_changes where variant_id = $1", [variant])).rows;
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ from_method: "MANUAL", to_method: "SUPPLIER_API", actor_id: "admin-7", reason: "supplier now fulfils this product" });
    expect(Object.keys(row[0].usage).sort()).toEqual(["fulfillment", "inventory", "orders", "suppliers"]);
    const audit = (await f.t.pool.query("select actor_id, before, after, metadata from audit_logs where action = 'catalog.variant.fulfillment_changed' and entity_id = $1", [variant])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_id).toBe("admin-7");
    expect(audit[0].before).toMatchObject({ fulfillmentMethod: "MANUAL" });
    expect(audit[0].after).toMatchObject({ fulfillmentMethod: "SUPPLIER_API" });
  });

  it("needs BOTH permissions, a real reason, a different compatible method, and a DRAFT variant; every refusal writes nothing", async () => {
    const { variant } = await draftVariant("DIGITAL_SERVICE", "MANUAL");
    const pub = await sellableVariant(f, "MANUAL");
    const before = (await f.t.pool.query("select (select count(*) from variant_fulfillment_changes)::int c, (select count(*) from audit_logs)::int a")).rows[0];
    expect((await err(changeFulfillmentMethod(ctx(["catalog.products.manage"]), variant, { to: "SUPPLIER_API", reason: "no change permission" }))).code).toBe("AUTH_FORBIDDEN");
    expect((await err(changeFulfillmentMethod(ctx(["catalog.fulfillment.change"]), variant, { to: "SUPPLIER_API", reason: "no manage permission" }))).code).toBe("AUTH_FORBIDDEN");
    expect((await err(changeFulfillmentMethod(ctx(), variant, { to: "SUPPLIER_API", reason: "short" }))).code).toBe("CATALOG_INVALID");
    expect((await err(changeFulfillmentMethod(ctx(), variant, { to: "MANUAL", reason: "already manual, no-op" }))).code).toBe("CATALOG_INVALID");
    expect((await err(changeFulfillmentMethod(ctx(), variant, { to: "AUTO_CODE", reason: "not allowed for a service" }))).code).toBe("CATALOG_INVALID");
    expect((await err(changeFulfillmentMethod(ctx(), variant, { to: "SUPPLIER_API", reason: "x".repeat(501) }))).code).toBe("CATALOG_INVALID");
    expect((await err(changeFulfillmentMethod(ctx(), variant, { to: "SUPPLIER_API", reason: "extra field", extra: 1 } as never))).code).toBe("CATALOG_INVALID");
    expect((await err(changeFulfillmentMethod(ctx(), "0192a000-0000-7000-8000-0000000000ff", { to: "MANUAL", reason: "unknown variant id" }))).code).toBe("CATALOG_NOT_FOUND");
    // published (and archived) variants must first leave circulation
    expect((await err(changeFulfillmentMethod(ctx(), pub, { to: "SUPPLIER_API", reason: "published variant" }))).code).toBe("CATALOG_INVALID");
    expect(await methodOf(pub)).toBe("MANUAL");
    const after = (await f.t.pool.query("select (select count(*) from variant_fulfillment_changes)::int c, (select count(*) from audit_logs)::int a")).rows[0];
    expect(after).toEqual(before);
    expect(await methodOf(variant)).toBe("MANUAL");
  });

  it("fails CLOSED when the usage cannot be verified (any probe missing)", async () => {
    const { variant } = await draftVariant("DIGITAL_SERVICE", "MANUAL");
    const noProbes: AdminContext = adminCtx(f); // no `usage` at all
    expect((await err(changeFulfillmentMethod(noProbes, variant, { to: "SUPPLIER_API", reason: "probes are missing" }))).code).toBe("CATALOG_USAGE_UNKNOWN");
    for (const usage of [[], PROBES.slice(0, 3), PROBES.slice(1), [PROBES[0]!, PROBES[0]!, PROBES[0]!, PROBES[0]!]]) {
      const r = await err(changeFulfillmentMethod(ctx("all", usage), variant, { to: "SUPPLIER_API", reason: "probes are missing" }));
      expect(r.code, `${usage.length}`).toBe("CATALOG_USAGE_UNKNOWN");
    }
    expect(await methodOf(variant)).toBe("MANUAL");
  });

  it("inventory blocks it: counted stock, an open reservation, and itemised stock — and it opens again once the stock is gone", async () => {
    // counted stock
    const m = await sellableVariant(f, "MANUAL");
    await setVariantStatus(ctx(), m, "DRAFT", "back to draft for rework");
    await adjustStock(invCtx(f), m, 5, "opening manual stock");
    const r1 = await err(changeFulfillmentMethod(ctx(), m, { to: "SUPPLIER_API", reason: "stock still exists" }));
    expect(r1.code).toBe("CATALOG_VARIANT_IN_USE");
    expect(r1.message).toContain("inventory.countedStock=5");
    await adjustStock(invCtx(f), m, -5, "stock written off");
    await changeFulfillmentMethod(ctx(), m, { to: "SUPPLIER_API", reason: "stock cleared, switching" });
    expect(await methodOf(m)).toBe("SUPPLIER_API");

    // an open reservation on a published variant that was then unpublished
    const r = await sellableVariant(f, "MANUAL");
    await adjustStock(invCtx(f), r, 2, "opening manual stock");
    await withTransaction(f.app.db, (tx) => reserve(tx, f.clock, { reservationKey: uniq("rk"), orderRef: uniq("o"), lines: [{ variantId: r, quantity: 1 }] }));
    await setVariantStatus(ctx(), r, "DRAFT", "back to draft for rework");
    const r2 = await err(changeFulfillmentMethod(ctx(), r, { to: "SUPPLIER_API", reason: "reservation still open" }));
    expect(r2.code).toBe("CATALOG_VARIANT_IN_USE");
    expect(r2.message).toContain("inventory.openReservations=1");

    // itemised stock (OTHER allows AUTO_CODE <-> MANUAL): blocked until every unsold code is voided
    const o = await createProduct(ctx(), { type: "OTHER", brandId: f.base.brand, categoryId: f.base.category, slug: uniq("o"), name: "O" });
    const ov = await createVariant(ctx(), o.id, { sku: uniq("O"), name: "O", fulfillmentMethod: "AUTO_CODE", price: 1_000_000 });
    await importCodes(invCtx(f), ov.id, { payloadKind: "CODE", codes: makeCodes(3) });
    const r3 = await err(changeFulfillmentMethod(ctx(), ov.id, { to: "MANUAL", reason: "codes still in stock" }));
    expect(r3.code).toBe("CATALOG_VARIANT_IN_USE");
    expect(r3.message).toContain("inventory.unsoldCodes=3");
    for (const row of (await f.t.pool.query("select id from digital_codes where variant_id = $1", [ov.id])).rows) await setCodeStatus(invCtx(f), row.id, "VOID", "withdrawn from sale");
    await changeFulfillmentMethod(ctx(), ov.id, { to: "MANUAL", reason: "all codes voided, switching" });
    expect(await methodOf(ov.id)).toBe("MANUAL");
  });

  it("an open fulfilment task blocks it", async () => {
    const v = await sellableVariant(f, "MANUAL");
    const so = await seedPaidOrder(f, "u-task", [{ variantId: v }]);
    await withTransaction(f.app.db, (tx) => createTasks(tx, f.clock, { orderRef: so.orderId, userRef: "u-task", paymentRef: "pay-1", items: [{ orderItemRef: so.refs[0]!, variantId: v }] }));
    await setVariantStatus(ctx(), v, "DRAFT", "back to draft for rework");
    const r = await err(changeFulfillmentMethod(ctx(), v, { to: "SUPPLIER_API", reason: "a task is still open" }));
    expect(r.code).toBe("CATALOG_VARIANT_IN_USE");
    expect(r.message).toContain("fulfillment.openTasks=1");
  });

  it("an active supplier route blocks it; deactivating the route opens it", async () => {
    const s = await readySupplier(f, ["RT1"]);
    const v = await routedVariant(f, [s.products.RT1!]);
    await setVariantStatus(ctx(), v, "DRAFT", "back to draft for rework");
    const r = await err(changeFulfillmentMethod(ctx(), v, { to: "MANUAL", reason: "route still active" }));
    expect(r.code).toBe("CATALOG_VARIANT_IN_USE");
    expect(r.message).toContain("suppliers.activeRoutes=1");
    for (const route of await getRoutes(f.app.db, v)) await deactivateRoute(supCtx(f), route.routeId, "route no longer used");
    await changeFulfillmentMethod(ctx(), v, { to: "MANUAL", reason: "route deactivated, switching" });
    expect(await methodOf(v)).toBe("MANUAL");
  });

  it("an open order blocks it; a finished order does not, and the historical order keeps what it was sold under", async () => {
    const v = await sellableVariant(f, "MANUAL");
    await adjustStock(invCtx(f), v, 3, "opening manual stock");
    const user = userId();
    const o = await gatewayCheckout(f, user, [{ variantId: v, quantity: 1 }]);
    await setVariantStatus(ctx(), v, "DRAFT", "back to draft for rework");
    const blocked = await err(changeFulfillmentMethod(ctx(), v, { to: "SUPPLIER_API", reason: "an order is open" }));
    expect(blocked.code).toBe("CATALOG_VARIANT_IN_USE");
    expect(blocked.message).toContain("orders.openOrders=1");

    const itemBefore = (await f.t.pool.query("select snapshot from order_items where order_id = $1", [o.orderId])).rows[0].snapshot;
    const orderBefore = (await f.t.pool.query("select refund_policy_version, policy_snapshot from orders where id = $1", [o.orderId])).rows[0];
    await cancelOrder(ordersDeps(f), { orderId: o.orderId, by: { type: "CUSTOMER", userId: user }, reason: "customer changed their mind" });
    await adjustStock(invCtx(f), v, -3, "stock written off");
    await changeFulfillmentMethod(ctx(), v, { to: "SUPPLIER_API", reason: "order closed, stock cleared" });
    expect(await methodOf(v)).toBe("SUPPLIER_API");
    // the order and its snapshots are untouched
    expect((await f.t.pool.query("select snapshot from order_items where order_id = $1", [o.orderId])).rows[0].snapshot).toEqual(itemBefore);
    expect(itemBefore.fulfillmentMethod).toBe("MANUAL");
    expect((await f.t.pool.query("select refund_policy_version, policy_snapshot from orders where id = $1", [o.orderId])).rows[0]).toEqual(orderBefore);
  });

  it("a variant that is back in DRAFT with a method change can be published again only if the new method is compatible (re-publication is checked)", async () => {
    const m = await sellableVariant(f, "MANUAL");
    await setVariantStatus(ctx(), m, "DRAFT", "back to draft for rework");
    await changeFulfillmentMethod(ctx(), m, { to: "SUPPLIER_API", reason: "switching to the supplier" });
    await setVariantStatus(ctx(), m, "PUBLISHED", "published again");
    expect(await methodOf(m)).toBe("SUPPLIER_API");
  });
});

describe("C-2: grandfathered variants (incompatible under the tightened matrix)", () => {
  it("are never rewritten, are listed, cannot be published again, and are corrected only through the protected change", async () => {
    // Recreate the historical situation: a GIFT_CARD/MANUAL variant created while the old matrix allowed it.
    const gp = await createProduct(ctx(), { type: "GIFT_CARD", brandId: f.base.brand, categoryId: f.base.category, slug: uniq("legacy"), name: "Legacy" });
    const legacy = { id: crypto.randomUUID() };
    const c = await f.t.pool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.actor_id', 'legacy-seed', true), set_config('app.reason', 'legacy variant', true)");
      await c.query("insert into product_type_fulfillment (product_type, method) values ('GIFT_CARD', 'MANUAL')");
      await c.query("insert into product_variants (id, product_id, sku, name, fulfillment_method, price, created_at, updated_at) values ($1, $2, $3, 'Legacy', 'MANUAL', 1000000, now(), now())", [legacy.id, gp.id, uniq("L")]);
      await c.query("delete from product_type_fulfillment where product_type = 'GIFT_CARD' and method = 'MANUAL'");
      await c.query("commit");
    } finally {
      c.release();
    }

    const listed = await listIncompatibleVariants(ctx());
    expect(listed.map((x) => x.variantId)).toContain(legacy.id);
    expect(listed.find((x) => x.variantId === legacy.id)).toMatchObject({ productType: "GIFT_CARD", fulfillmentMethod: "MANUAL" });
    expect(await methodOf(legacy.id)).toBe("MANUAL"); // never rewritten
    expect((await err(listIncompatibleVariants(ctx(["catalog.fulfillment.change"])))).code).toBe("AUTH_FORBIDDEN");

    await setProductStatus(ctx(), gp.id, "PUBLISHED", "launch product");
    expect((await err(setVariantStatus(ctx(), legacy.id, "PUBLISHED", "publish the legacy variant"))).code).toBe("CATALOG_INVALID");
    // an ordinary edit of such a variant still works (it is not blocked from being maintained) ...
    await updateVariant(ctx(), legacy.id, { name: "Legacy renamed" });
    // ... but the method can only be corrected through the protected change, to a compatible method
    expect((await err(changeFulfillmentMethod(ctx(), legacy.id, { to: "SUPPLIER_API", reason: "still not a gift-card method" }))).code).toBe("CATALOG_INVALID");
    await changeFulfillmentMethod(ctx(), legacy.id, { to: "AUTO_CODE", reason: "aligning with the approved matrix" });
    await setVariantStatus(ctx(), legacy.id, "PUBLISHED", "publish the corrected variant");
    expect((await listIncompatibleVariants(ctx())).map((x) => x.variantId)).not.toContain(legacy.id);
  });
});
