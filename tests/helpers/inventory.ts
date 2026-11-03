import { createBrand, createCategory, createProduct, createVariant, setProductStatus, setVariantStatus } from "@/modules/catalog";
import type { FulfillmentMethod, ProductType } from "@/modules/catalog";
import type { InventoryAdminContext } from "@/modules/inventory";
import { DevKeyProvider } from "@/platform/crypto/testing/dev-key-provider";
import { DomainError } from "@/platform/errors";
import { adminCtx, catalogFixture, uniq } from "./catalog";
import type { CatalogFixture } from "./catalog";

export interface InventoryFixture extends CatalogFixture { keys: DevKeyProvider; base: { brand: string; category: string } }

export async function inventoryFixture(): Promise<InventoryFixture> {
  const f = await catalogFixture();
  const c = adminCtx(f);
  const brand = await createBrand(c, { slug: uniq("b"), name: "B" });
  const category = await createCategory(c, { slug: uniq("c"), name: "C" });
  return { ...f, keys: DevKeyProvider.generate(1), base: { brand: brand.id, category: category.id } };
}

export function invCtx(f: InventoryFixture, allowed: "all" | string[] = "all", actorId = "admin-1", keys = f.keys): InventoryAdminContext {
  return {
    db: f.app.db, clock: f.clock, keys, actor: { type: "ADMIN", id: actorId },
    authorize: async (p) => {
      if (allowed !== "all" && !allowed.includes(p)) throw new DomainError("AUTH_FORBIDDEN", "not permitted");
    },
  };
}

/** A published, sellable variant with the given fulfilment method (and product type). */
export async function sellableVariant(f: InventoryFixture, method: FulfillmentMethod = "AUTO_CODE", type: ProductType = method === "AUTO_CODE" ? "GIFT_CARD" : "DIGITAL_SERVICE", publish = true): Promise<string> {
  const c = adminCtx(f);
  const p = await createProduct(c, { type, brandId: f.base.brand, categoryId: f.base.category, slug: uniq("p"), name: "P" });
  const v = await createVariant(c, p.id, { sku: uniq("V"), name: "V", fulfillmentMethod: method, price: 1_000_000 });
  if (publish) {
    await setProductStatus(c, p.id, "PUBLISHED", "launch product");
    await setVariantStatus(c, v.id, "PUBLISHED", "launch variant");
  }
  return v.id;
}

let n = 0;
export const makeCodes = (count: number, prefix = "STEAM"): string[] => Array.from({ length: count }, () => `${prefix}-${String(++n).padStart(6, "0")}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`);
