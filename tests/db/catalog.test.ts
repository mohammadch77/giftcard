import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  archiveBrandOrCategory, changePrice, createBrand, createCategory, createProduct, createVariant, getProductAdmin, getVariantSnapshot, listPublished, setProductStatus,
  setVariantAvailability, setVariantStatus, updateProduct, updateVariant,
} from "@/modules/catalog";
import { quote } from "@/modules/pricing";
import { FULFILLMENT_COMPATIBILITY } from "@/modules/catalog";
import { pgCode } from "../helpers/db";
import { adminCtx, catalogFixture, seedBase, uniq } from "../helpers/catalog";
import type { CatalogFixture } from "../helpers/catalog";

let f: CatalogFixture;
beforeAll(async () => {
  f = await catalogFixture();
});
afterAll(async () => {
  await f?.app.close();
  await f?.t.drop();
});

const c = () => adminCtx(f);
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? "OTHER"; } return "NO_ERROR"; };
const sqlCode = (q: string, p: unknown[] = []) => f.t.pool.query(q, p).then(() => "ok", (e: unknown) => pgCode(e));
const audits = async (action: string) => (await f.t.pool.query("select * from audit_logs where action = $1 order by id", [action])).rows;

describe("authorization boundary", () => {
  it("every admin use case demands its permission and writes nothing without it", async () => {
    const base = await seedBase(c());
    const before = (await f.t.pool.query("select (select count(*) from products)::int p, (select count(*) from audit_logs)::int a")).rows[0];
    const none = adminCtx(f, []);
    const attempts: Promise<unknown>[] = [
      createBrand(none, { slug: "x-1", name: "X" }), createCategory(none, { slug: "x-2", name: "X" }),
      createProduct(none, { type: "OTHER", brandId: base.brand, categoryId: base.category, slug: "x-3", name: "X" }),
      updateProduct(none, base.product, { name: "Y" }), updateVariant(none, base.variant, { name: "Y" }),
      setProductStatus(none, base.product, "PUBLISHED", "go live"), setVariantStatus(none, base.variant, "PUBLISHED", "go live"),
      changePrice(none, base.variant, { price: 2_000_000, reason: "repricing" }), setVariantAvailability(none, base.variant, "TEMPORARILY_UNAVAILABLE", "stock check"),
      getProductAdmin(none, base.product), archiveBrandOrCategory(none, "brand", base.brand, "obsolete brand"),
      createVariant(none, base.product, { sku: "Z1", name: "Z", fulfillmentMethod: "MANUAL", price: 10 }),
    ];
    for (const a of attempts) expect(await code(a)).toBe("AUTH_FORBIDDEN");
    const after = (await f.t.pool.query("select (select count(*) from products)::int p, (select count(*) from audit_logs)::int a")).rows[0];
    expect(after).toEqual(before);
  });
  it("price changes and creation with a price need catalog.prices.manage; publishing needs catalog.products.publish", async () => {
    const seen: string[] = [];
    const only = adminCtx(f, ["catalog.products.manage"], "admin-2", seen);
    const base = await seedBase(c());
    expect(await code(createVariant(only, base.product, { sku: uniq("N"), name: "N", fulfillmentMethod: "MANUAL", price: 10 }))).toBe("AUTH_FORBIDDEN");
    expect(await code(changePrice(only, base.variant, { price: 20, reason: "no permission" }))).toBe("AUTH_FORBIDDEN");
    expect(await code(setVariantStatus(only, base.variant, "PUBLISHED", "no permission"))).toBe("AUTH_FORBIDDEN");
    const seenAll: string[] = [];
    await changePrice(adminCtx(f, "all", "a", seenAll), base.variant, { price: 20, reason: "permission ok" });
    expect(seenAll).toEqual(["catalog.prices.manage"]);
  });
});

describe("hierarchy, classification and uniqueness", () => {
  it("category tree: parent link, no cycles, at most 4 levels; duplicate slugs conflict", async () => {
    const a = await createCategory(c(), { slug: uniq("l1"), name: "L1" });
    const b = await createCategory(c(), { slug: uniq("l2"), name: "L2", parentId: a.id });
    const cc = await createCategory(c(), { slug: uniq("l3"), name: "L3", parentId: b.id });
    const d = await createCategory(c(), { slug: uniq("l4"), name: "L4", parentId: cc.id });
    expect(await code(createCategory(c(), { slug: uniq("l5"), name: "L5", parentId: d.id }))).toBe("CATALOG_INVALID");
    expect(await sqlCode("update categories set parent_id = $1 where id = $2", [d.id, a.id])).toBe("PC002"); // cycle
    expect(await sqlCode("update categories set parent_id = id where id = $1", [a.id])).toBe("PC002");
    const slug = uniq("dup");
    await createBrand(c(), { slug, name: "A" });
    expect(await code(createBrand(c(), { slug, name: "B" }))).toBe("CATALOG_CONFLICT");
    expect(await code(createCategory(c(), { slug: uniq("orphan"), name: "O", parentId: "0192a000-0000-7000-8000-0000000000ff" }))).toBe("CATALOG_INVALID");
  });
  it("fulfilment compatibility is enforced by service AND database, and the code mirror equals the seeded table", async () => {
    const base = await seedBase(c());
    const svc = await createProduct(c(), { type: "DIGITAL_SERVICE", brandId: base.brand, categoryId: base.category, slug: uniq("svc"), name: "Service" });
    expect(await code(createVariant(c(), svc.id, { sku: "A1", name: "x", fulfillmentMethod: "AUTO_CODE", price: 100 }))).toBe("CATALOG_INVALID");
    expect(await sqlCode(`insert into product_variants (id, product_id, sku, name, fulfillment_method, price, created_at, updated_at) values (gen_random_uuid(), $1, 'RAW', 'raw', 'AUTO_CODE', 100, now(), now())`, [svc.id])).toBe("PC003");
    const rows = (await f.t.pool.query("select product_type, method from product_type_fulfillment")).rows;
    const db: Record<string, string[]> = {};
    for (const r of rows) (db[r.product_type] ??= []).push(r.method);
    for (const [t, m] of Object.entries(FULFILLMENT_COMPATIBILITY)) expect(db[t]!.slice().sort(), t).toEqual([...m].sort());
    expect(await code(updateVariant(c(), base.variant, { fulfillmentMethod: "SUPPLIER_API" }))).toBe("NO_ERROR");
    expect(await f.app.pool.query("update product_type_fulfillment set method = 'MANUAL'").then(() => "ok", (e: unknown) => pgCode(e))).toBe("42501");
  });
  it("type, slug, sku and ids are immutable; the app role cannot delete anything", async () => {
    const base = await seedBase(c());
    for (const q of ["update products set type = 'OTHER' where id = $1", "update products set slug = 'zzz' where id = $1", "delete from products", "delete from product_variants", "delete from categories", "delete from brands"]) {
      expect(await f.app.pool.query(q, q.includes("$1") ? [base.product] : []).then(() => "ok", (e: unknown) => pgCode(e)), q).toBe("42501");
    }
    expect(await sqlCode("update product_variants set sku = 'NEW' where id = $1", [base.variant])).toBe("PI001");
  });
});

describe("lifecycle and availability", () => {
  it("a variant publishes only under a published product and with a price above zero; archived is terminal", async () => {
    const base = await seedBase(c());
    expect(await code(setVariantStatus(c(), base.variant, "PUBLISHED", "before the product"))).toBe("CATALOG_INVALID");
    await setProductStatus(c(), base.product, "PUBLISHED", "launch product");
    const free = await createVariant(c(), base.product, { sku: uniq("F"), name: "Free", fulfillmentMethod: "MANUAL", price: 0 });
    expect(await code(setVariantStatus(c(), free.id, "PUBLISHED", "zero price"))).toBe("CATALOG_INVALID");
    await setVariantStatus(c(), base.variant, "PUBLISHED", "launch variant");
    expect(await code(changePrice(c(), base.variant, { price: 0, reason: "free by mistake" }))).toBe("CATALOG_INVALID"); // published variant cannot drop to zero
    await setVariantStatus(c(), base.variant, "ARCHIVED", "retired");
    expect(await code(setVariantStatus(c(), base.variant, "PUBLISHED", "revive"))).toBe("CATALOG_INVALID");
    expect(await sqlCode("update product_variants set status = 'DRAFT' where id = $1", [base.variant])).toBe("PT001");
  });
  it("unpublishing/archiving a product moves its published variants in the same transaction; raw SQL cannot bypass", async () => {
    const base = await seedBase(c());
    await setProductStatus(c(), base.product, "PUBLISHED", "launch product");
    await setVariantStatus(c(), base.variant, "PUBLISHED", "launch variant");
    expect(await sqlCode("update products set status = 'DRAFT' where id = $1", [base.product])).toBe("PC001");
    await setProductStatus(c(), base.product, "DRAFT", "pull for rework");
    expect((await f.t.pool.query("select status from product_variants where id = $1", [base.variant])).rows[0].status).toBe("DRAFT");
    await setProductStatus(c(), base.product, "ARCHIVED", "discontinued");
    expect((await f.t.pool.query("select status from product_variants where id = $1", [base.variant])).rows[0].status).toBe("ARCHIVED");
    expect(await code(setProductStatus(c(), base.product, "PUBLISHED", "revive attempt"))).toBe("CATALOG_INVALID");
    const hist = (await f.t.pool.query("select to_status, actor_id, reason from product_status_history where entity_id = $1 order by id", [base.product])).rows;
    expect(hist.map((h) => h.to_status)).toEqual(["DRAFT", "PUBLISHED", "DRAFT", "ARCHIVED"]);
    expect(hist.slice(1).every((h) => h.actor_id === "admin-1" && h.reason)).toBe(true);
  });
  it("brands/categories with published products cannot be archived; an archived brand blocks publishing", async () => {
    const base = await seedBase(c());
    await setProductStatus(c(), base.product, "PUBLISHED", "launch product");
    expect(await code(archiveBrandOrCategory(c(), "brand", base.brand, "should fail now"))).toBe("CATALOG_INVALID");
    const other = await seedBase(c());
    await archiveBrandOrCategory(c(), "brand", other.brand, "brand retired");
    expect(await code(setProductStatus(c(), other.product, "PUBLISHED", "uses archived brand"))).toBe("CATALOG_INVALID");
  });
  it("availability toggles sellability without changing publication state; fulfilment method freezes after DRAFT", async () => {
    const base = await seedBase(c());
    await setProductStatus(c(), base.product, "PUBLISHED", "launch product");
    await setVariantStatus(c(), base.variant, "PUBLISHED", "launch variant");
    expect((await getVariantSnapshot(f.app.db, base.variant))?.sellable).toBe(true);
    await setVariantAvailability(c(), base.variant, "TEMPORARILY_UNAVAILABLE", "supplier maintenance");
    const s = await getVariantSnapshot(f.app.db, base.variant);
    expect(s).toMatchObject({ sellable: false, availability: "TEMPORARILY_UNAVAILABLE" });
    expect(await code(updateVariant(c(), base.variant, { fulfillmentMethod: "MANUAL" }))).toBe("CATALOG_INVALID");
  });
});

describe("price integrity", () => {
  it("rejects non-integer, non-multiple-of-10, oversize and inverted sale prices in the service and in the database", async () => {
    const base = await seedBase(c());
    for (const price of [1005, 1.5, -10, 10_000_000_000_010]) expect(await code(changePrice(c(), base.variant, { price, reason: "bad price test" })), String(price)).not.toBe("NO_ERROR");
    expect(await code(changePrice(c(), base.variant, { price: 1000, salePrice: 1000, reason: "bad sale test" }))).toBe("CATALOG_INVALID");
    const set = (sets: string) => sqlCode(`select set_config('app.actor_id','t',false); update product_variants set ${sets} where id = '${base.variant}'`);
    expect(await set("price = 1005")).toBe("23514");
    expect(await set("sale_price = price")).toBe("23514");
    expect(await set("sale_price = 0")).toBe("23514");
    expect(await set("sale_starts_at = now()")).toBe("23514"); // window without sale price
    expect(await set("attrs = '[]'::jsonb")).toBe("23514");
  });
  it("every price change appends immutable history with actor and reason; the app role cannot write history; no actor, no change", async () => {
    const base = await seedBase(c());
    await changePrice(adminCtx(f, "all", "finance-9"), base.variant, { price: 1_200_000, salePrice: 1_000_000, saleStartsAt: new Date("2026-06-02T00:00:00Z"), saleEndsAt: new Date("2026-06-03T00:00:00Z"), reason: "weekend sale" });
    const h = (await f.t.pool.query("select price, sale_price, changed_by, reason from variant_price_history where variant_id = $1 order by id", [base.variant])).rows;
    expect(h.map((x) => [Number(x.price), x.sale_price === null ? null : Number(x.sale_price)])).toEqual([[1_000_000, null], [1_200_000, 1_000_000]]);
    expect(h[1]).toMatchObject({ changed_by: "finance-9", reason: "weekend sale" });
    expect(await f.app.pool.query("insert into variant_price_history (variant_id, price, changed_at) values ($1, 10, now())", [base.variant]).then(() => "ok", (e: unknown) => pgCode(e))).toBe("42501");
    expect(await sqlCode("update variant_price_history set price = 10")).not.toBe("ok");
    const noActor = await f.t.pool.connect();
    try {
      await noActor.query("select set_config('app.actor_id','',false)");
      expect(await noActor.query("update product_variants set price = 3000000 where id = $1", [base.variant]).then(() => "ok", (e: unknown) => pgCode(e))).toBe("PC004");
    } finally { noActor.release(); }
    const a = (await audits("catalog.variant.price_changed")).at(-1)!;
    expect(a).toMatchObject({ actor_type: "ADMIN", actor_id: "finance-9", entity_id: base.variant });
    expect(a.before.price).toBe(1_000_000);
    expect(a.after).toMatchObject({ price: 1_200_000, salePrice: 1_000_000 });
  });
  it("a failed price change leaves price, history and audit untouched (atomic)", async () => {
    const base = await seedBase(c());
    const cnt = async () => (await f.t.pool.query("select (select count(*) from variant_price_history)::int h, (select count(*) from audit_logs)::int a, (select price from product_variants where id = $1) p", [base.variant])).rows[0];
    const before = await cnt();
    await code(changePrice(c(), base.variant, { price: 1005, reason: "invalid multiple" }));
    expect(await cnt()).toEqual(before);
  });
});

describe("audit and reads", () => {
  it("each administrative mutation is audited with the acting admin", async () => {
    const base = await seedBase(c());
    await updateProduct(c(), base.product, { name: "Renamed" });
    await updateVariant(c(), base.variant, { name: "Renamed variant", attrs: { edition: "x" } });
    await setProductStatus(c(), base.product, "PUBLISHED", "launch product");
    await setVariantAvailability(c(), base.variant, "TEMPORARILY_UNAVAILABLE", "short pause");
    const actions = new Set((await f.t.pool.query("select distinct action from audit_logs where actor_id = 'admin-1'")).rows.map((r) => r.action));
    for (const a of ["catalog.brand.created", "catalog.category.created", "catalog.product.created", "catalog.variant.created", "catalog.product.updated", "catalog.variant.updated", "catalog.product.status_changed", "catalog.variant.availability_changed"]) expect(actions.has(a), a).toBe(true);
    expect((await getProductAdmin(c(), base.product)).variants).toHaveLength(1);
  });
  it("public reads: only published + available variants, keyset pagination, filters, and no internal fields leak", async () => {
    const g = await catalogFixture();
    try {
      const ctx = adminCtx(g);
      const brand = await createBrand(ctx, { slug: "psn", name: "PlayStation" });
      const other = await createBrand(ctx, { slug: "xbox", name: "Xbox" });
      const cat = await createCategory(ctx, { slug: "cards", name: "Cards" });
      const mk = async (b: { id: string }, slug: string, n: number) => {
        const p = await createProduct(ctx, { type: "GIFT_CARD", brandId: b.id, categoryId: cat.id, slug, name: slug });
        await setProductStatus(ctx, p.id, "PUBLISHED", "launch product");
        const ids: string[] = [];
        for (let i = 0; i < n; i++) {
          const v = await createVariant(ctx, p.id, { sku: `V${i}`, name: `${slug} ${i}`, fulfillmentMethod: "AUTO_CODE", price: 1000 * (i + 1), attrs: { edition: "std" } });
          await setVariantStatus(ctx, v.id, "PUBLISHED", "launch variant");
          ids.push(v.id);
        }
        return ids;
      };
      const psn = await mk(brand, "psn-card", 5);
      await mk(other, "xbox-card", 2);
      const draft = await createProduct(ctx, { type: "OTHER", brandId: brand.id, categoryId: cat.id, slug: "hidden", name: "hidden" });
      await createVariant(ctx, draft.id, { sku: "H", name: "h", fulfillmentMethod: "MANUAL", price: 10 });
      await setVariantAvailability(ctx, psn[0]!, "TEMPORARILY_UNAVAILABLE", "paused for a while");
      const all = await listPublished(g.app.db, { limit: 100 });
      expect(all.items).toHaveLength(6); // 4 psn + 2 xbox; draft and unavailable are hidden
      const p1 = await listPublished(g.app.db, { brandSlug: "psn", limit: 3 });
      expect(p1.items).toHaveLength(3);
      const p2 = await listPublished(g.app.db, { brandSlug: "psn", limit: 3, after: p1.next! });
      expect(p2.items).toHaveLength(1);
      expect(p2.next).toBeNull();
      expect(new Set([...p1.items, ...p2.items].map((x) => x.variantId)).size).toBe(4);
      expect((await listPublished(g.app.db, { categorySlug: "cards", type: "GIFT_CARD" })).items).toHaveLength(6);
      expect(JSON.stringify(all)).not.toMatch(/cost|supplier|secret|internal|password/i);
      expect(Object.keys(all.items[0]!).sort()).toEqual(["attrs", "availability", "brand", "durationDays", "faceCurrency", "faceValue", "fulfillmentMethod", "name", "productId", "productName", "productSlug", "productType", "regionCode", "sellable", "sku", "variantId"]);
      expect(await getVariantSnapshot(g.app.db, "not-a-uuid")).toBeNull();
      await expect(listPublished(g.app.db, { after: "x" })).rejects.toMatchObject({ code: "CATALOG_INVALID" });
    } finally {
      await g.app.close();
      await g.t.drop();
    }
  });
});

describe("pricing quote", () => {
  it("computes from database rows only, honours the sale window at the injected time, and uses exact integer Rial", async () => {
    const base = await seedBase(c());
    await setProductStatus(c(), base.product, "PUBLISHED", "launch product");
    await setVariantStatus(c(), base.variant, "PUBLISHED", "launch variant");
    await changePrice(c(), base.variant, { price: 1_000_000, salePrice: 900_000, saleStartsAt: new Date("2026-06-01T12:00:00Z"), saleEndsAt: new Date("2026-06-01T13:00:00Z"), reason: "hour sale" });
    const q = (at: string, qty = 3) => quote(f.app.db, [{ variantId: base.variant, quantity: qty }], new Date(at));
    expect((await q("2026-06-01T11:59:59Z")).subtotal).toBe(3_000_000);
    const sale = await q("2026-06-01T12:00:00Z");
    expect(sale).toMatchObject({ currency: "IRR", pricingVersion: "min-0", subtotal: 2_700_000 });
    expect(sale.lines[0]).toMatchObject({ unitPrice: 900_000, lineTotal: 2_700_000, onSale: true });
    expect((await q("2026-06-01T13:00:00Z")).subtotal).toBe(3_000_000);
  });
  it("rejects unsellable, unknown, duplicate and out-of-range lines; huge totals overflow safely", async () => {
    const base = await seedBase(c());
    const now = new Date();
    expect(await code(quote(f.app.db, [{ variantId: base.variant, quantity: 1 }], now))).toBe("CATALOG_NOT_SELLABLE"); // draft
    expect(await code(quote(f.app.db, [{ variantId: "0192a000-0000-7000-8000-0000000000ee", quantity: 1 }], now))).toBe("CATALOG_NOT_FOUND");
    await setProductStatus(c(), base.product, "PUBLISHED", "launch product");
    await setVariantStatus(c(), base.variant, "PUBLISHED", "launch variant");
    for (const qty of [0, -1, 1.5, 101, Number.NaN]) expect(await code(quote(f.app.db, [{ variantId: base.variant, quantity: qty }], now)), String(qty)).toBe("CATALOG_INVALID");
    expect(await code(quote(f.app.db, [{ variantId: base.variant, quantity: 1 }, { variantId: base.variant, quantity: 1 }], now))).toBe("CATALOG_INVALID");
    expect(await code(quote(f.app.db, [], now))).toBe("CATALOG_INVALID");
    await setVariantAvailability(c(), base.variant, "TEMPORARILY_UNAVAILABLE", "paused for a while");
    expect(await code(quote(f.app.db, [{ variantId: base.variant, quantity: 1 }], now))).toBe("CATALOG_NOT_SELLABLE");
    await setVariantAvailability(c(), base.variant, "AVAILABLE", "resumed sale now");
    await changePrice(c(), base.variant, { price: 10_000_000_000_000, reason: "max price test" });
    expect((await quote(f.app.db, [{ variantId: base.variant, quantity: 100 }], now)).subtotal).toBe(1_000_000_000_000_000);
    const ids = [base.variant];
    for (let i = 0; i < 9; i++) {
      const v = await createVariant(c(), base.product, { sku: uniq("M"), name: "m", fulfillmentMethod: "MANUAL", price: 10_000_000_000_000 });
      await setVariantStatus(c(), v.id, "PUBLISHED", "launch variant");
      ids.push(v.id);
    }
    expect(await code(quote(f.app.db, ids.map((variantId) => ({ variantId, quantity: 100 })), now))).toBe("RIAL_OUT_OF_RANGE"); // 10 × 10^15 > 2^53
  });
});
