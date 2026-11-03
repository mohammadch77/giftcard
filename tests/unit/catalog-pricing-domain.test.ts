import { describe, expect, it } from "vitest";
import { CATALOG_PERMISSIONS, FULFILLMENT_COMPATIBILITY, FULFILLMENT_METHODS, PRODUCT_TYPES, PUBLICATION_TRANSITIONS } from "@/modules/catalog";
import { PermissionCatalog } from "@/modules/identity";
import { assertCompatible, attrsSchema, parse, parsePrice, productInput, variantInput } from "@/modules/catalog/domain/rules";
import { effectiveUnitPrice, saleActive } from "@/modules/pricing";

const d = (s: string) => new Date(s);

describe("price validation (shared Rial primitives)", () => {
  it("accepts integer Rial multiples of 10 up to 10^13", () => {
    expect(parsePrice({ price: 10 }).price).toBe(10);
    expect(parsePrice({ price: 10_000_000_000_000 }).price).toBe(10_000_000_000_000);
    expect(parsePrice({ price: 0 }).price).toBe(0);
  });
  it.each([5, 1_005, -10, 1.5, NaN, Infinity, 10_000_000_000_010, Number.MAX_SAFE_INTEGER + 1, 0.1 + 0.2])("rejects price %s", (p) => {
    expect(() => parsePrice({ price: p })).toThrow();
  });
  it("sale price must be > 0, < price, a multiple of 10; window needs a sale price and must be ordered", () => {
    expect(parsePrice({ price: 1000, salePrice: 990 }).salePrice).toBe(990);
    for (const s of [0, 1000, 1010, 995]) expect(() => parsePrice({ price: 1000, salePrice: s })).toThrow();
    expect(() => parsePrice({ price: 1000, saleStartsAt: d("2026-01-01") })).toThrow(expect.objectContaining({ code: "CATALOG_INVALID" }));
    expect(() => parsePrice({ price: 1000, salePrice: 500, saleStartsAt: d("2026-02-01"), saleEndsAt: d("2026-02-01") })).toThrow();
    expect(parsePrice({ price: 1000, salePrice: 500, saleStartsAt: d("2026-02-01"), saleEndsAt: d("2026-02-02") }).saleEndsAt).toEqual(d("2026-02-02"));
  });
});

describe("effective price (sale window is [start, end))", () => {
  const f = { price: 1000, salePrice: 700, saleStartsAt: d("2026-06-01T00:00:00Z"), saleEndsAt: d("2026-06-02T00:00:00Z") };
  it("boundaries", () => {
    expect(saleActive(f, d("2026-05-31T23:59:59.999Z"))).toBe(false);
    expect(saleActive(f, d("2026-06-01T00:00:00Z"))).toBe(true);
    expect(saleActive(f, d("2026-06-01T23:59:59.999Z"))).toBe(true);
    expect(saleActive(f, d("2026-06-02T00:00:00Z"))).toBe(false);
    expect(effectiveUnitPrice(f, d("2026-06-01T12:00:00Z"))).toEqual({ unit: 700, onSale: true });
    expect(effectiveUnitPrice(f, d("2026-06-03T00:00:00Z"))).toEqual({ unit: 1000, onSale: false });
  });
  it("open-ended windows and no sale", () => {
    expect(saleActive({ ...f, saleStartsAt: null, saleEndsAt: null }, d("2030-01-01"))).toBe(true);
    expect(saleActive({ ...f, saleEndsAt: null }, d("2099-01-01"))).toBe(true);
    expect(saleActive({ ...f, salePrice: null }, d("2026-06-01T12:00:00Z"))).toBe(false);
  });
});

describe("classification, lifecycle and input validation", () => {
  it("every product type has at least one fulfilment method and only known ones", () => {
    for (const t of PRODUCT_TYPES) {
      expect(FULFILLMENT_COMPATIBILITY[t].length).toBeGreaterThan(0);
      for (const m of FULFILLMENT_COMPATIBILITY[t]) expect(FULFILLMENT_METHODS).toContain(m);
    }
    expect(() => assertCompatible("DIGITAL_SERVICE", "AUTO_CODE")).toThrow(expect.objectContaining({ code: "CATALOG_INVALID" }));
    expect(() => assertCompatible("GAME_ACCOUNT", "SUPPLIER_API")).toThrow();
    expect(() => assertCompatible("GIFT_CARD", "SUPPLIER_API")).toThrow(); // C-2 (P1-B): gift cards are automatic only
    expect(() => assertCompatible("GIFT_CARD", "AUTO_CODE")).not.toThrow();
  });
  it("archived is terminal; nothing reaches NEW states", () => {
    expect(PUBLICATION_TRANSITIONS.ARCHIVED).toEqual([]);
    expect(PUBLICATION_TRANSITIONS.DRAFT).toEqual(["PUBLISHED", "ARCHIVED"]);
  });
  it("slugs, names, unknown fields and attrs are validated (strict objects)", () => {
    const ok = { type: "GIFT_CARD", brandId: "0192a000-0000-7000-8000-000000000001", categoryId: "0192a000-0000-7000-8000-000000000002", slug: "steam-card", name: "Steam" };
    expect(parse(productInput, ok).slug).toBe("steam-card");
    for (const bad of [{ ...ok, slug: "Steam Card" }, { ...ok, slug: "-x" }, { ...ok, name: "  " }, { ...ok, extra: 1 }, { ...ok, type: "NOPE" }]) expect(() => parse(productInput, bad)).toThrow();
    expect(() => parse(variantInput, { sku: "A1", name: "x", fulfillmentMethod: "MANUAL", price: 10, cost: 5 })).toThrow(); // no cost field exists
    expect(attrsSchema.safeParse({ edition: "standard", year: 2026, digital: true }).success).toBe(true);
    expect(attrsSchema.safeParse({ nested: { a: 1 } }).success).toBe(false);
    expect(attrsSchema.safeParse({ Bad: 1 }).success).toBe(false);
    expect(attrsSchema.safeParse(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]))).success).toBe(false);
  });
  it("catalog permissions register on the identity catalog; money-changing and publishing ones are sensitive", () => {
    const c = new PermissionCatalog();
    c.register(CATALOG_PERMISSIONS);
    expect(CATALOG_PERMISSIONS.every((p) => p.key.startsWith("catalog."))).toBe(true);
    expect(c.get("catalog.prices.manage")?.sensitive).toBe(true);
    expect(c.get("catalog.products.publish")?.sensitive).toBe(true);
    expect(c.get("catalog.products.manage")?.sensitive).toBe(false);
  });
});
