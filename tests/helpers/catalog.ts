import { CATALOG_PERMISSIONS, createBrand, createCategory, createProduct, createRegion, createVariant } from "@/modules/catalog";
import type { AdminContext } from "@/modules/catalog";
import { ManualClock } from "@/platform/clock/testing";
import { DomainError } from "@/platform/errors";
import type { DatabaseHandle } from "@/platform/db";
import { createDatabaseAsRole, createTestDatabase, createTestRoles } from "./db";
import type { TestDatabase } from "./db";

export interface CatalogFixture { t: TestDatabase; app: DatabaseHandle; clock: ManualClock }

export async function catalogFixture(): Promise<CatalogFixture> {
  const t = await createTestDatabase();
  const roles = await createTestRoles(t);
  return { t, app: createDatabaseAsRole(t, roles.appRole, 20), clock: new ManualClock("2026-06-01T10:00:00Z") };
}

/** Test authoriser standing in for identity (the real binding is covered by the integration test). */
export function adminCtx(f: CatalogFixture, allowed: "all" | string[] = "all", actorId = "admin-1", seen: string[] = []): AdminContext {
  return {
    db: f.app.db, clock: f.clock, actor: { type: "ADMIN", id: actorId },
    authorize: async (p) => {
      seen.push(p);
      if (allowed !== "all" && !allowed.includes(p)) throw new DomainError("AUTH_FORBIDDEN", "not permitted");
    },
  };
}
export const ALL_PERMISSIONS = CATALOG_PERMISSIONS.map((p) => p.key);

let n = 0;
export const uniq = (p: string) => `${p}-${++n}-${Math.random().toString(36).slice(2, 6)}`;

export async function seedBase(c: AdminContext) {
  const brand = await createBrand(c, { slug: uniq("steam"), name: "Steam" });
  const category = await createCategory(c, { slug: uniq("cards"), name: "Gift cards" });
  const region = await createRegion(c, { code: Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(""), name: "Region" });
  const product = await createProduct(c, { type: "GIFT_CARD", brandId: brand.id, categoryId: category.id, slug: uniq("steam-card"), name: "Steam card" });
  const variant = await createVariant(c, product.id, { sku: uniq("S20"), name: "Steam 20", fulfillmentMethod: "AUTO_CODE", price: 1_000_000, faceValue: 20, faceCurrency: "USD" });
  return { brand: brand.id, category: category.id, region: region.id, product: product.id, variant: variant.id };
}
