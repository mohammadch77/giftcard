import { createSupplier, mapVariantToSupplierProduct, setSupplierCredentials, syncSupplierProducts } from "@/modules/suppliers";
import type { SupplierAdminContext, SupplierDeps } from "@/modules/suppliers";
import { DomainError } from "@/platform/errors";
import { TestSupplier } from "@/platform/supplier-adapter/testing/test-supplier";
import { inventoryFixture, sellableVariant } from "./inventory";
import type { InventoryFixture } from "./inventory";
import { uniq } from "./catalog";

export const CANARY = "SUPPLIER-SECRET-CANARY-7f3a91c2";

export interface SupplierFixture extends InventoryFixture { supplier: TestSupplier; deps: SupplierDeps }

export async function supplierFixture(): Promise<SupplierFixture> {
  const f = await inventoryFixture();
  const supplier = new TestSupplier();
  return { ...f, supplier, deps: { adapters: new Map([["test", supplier]]), keys: f.keys, clock: f.clock } };
}

export function supCtx(f: SupplierFixture, allowed: "all" | string[] = "all", actorId = "admin-1"): SupplierAdminContext {
  return {
    db: f.app.db, clock: f.clock, keys: f.keys, actor: { type: "ADMIN", id: actorId },
    authorize: async (p) => {
      if (allowed !== "all" && !allowed.includes(p)) throw new DomainError("AUTH_FORBIDDEN", "not permitted");
    },
  };
}

/** Supplier with credentials (containing a canary), one synced product per sku, ready to route. */
export async function readySupplier(f: SupplierFixture, skus: string[], opts: { cost?: number } = {}) {
  const c = supCtx(f);
  const { id } = await createSupplier(c, { key: uniq("sup").slice(0, 38), name: "Test supplier", adapterKey: "test", config: { region: "eu" } });
  await setSupplierCredentials(c, id, { apiKey: CANARY, account: "acc-1" });
  f.supplier.catalog = skus.map((externalSku) => ({ externalSku, name: `Product ${externalSku}`, cost: opts.cost ?? 500_000, currency: "IRR", available: true }));
  const run = await syncSupplierProducts(f.app.db, f.deps, c.actor, id);
  const prods = (await f.t.pool.query("select id, external_sku from supplier_products where supplier_id = $1", [id])).rows as { id: string; external_sku: string }[];
  return { supplierId: id, run, products: Object.fromEntries(prods.map((p) => [p.external_sku, p.id])) as Record<string, string> };
}

/** A SUPPLIER_API variant mapped to the given supplier products (priority 1..n). */
export async function routedVariant(f: SupplierFixture, supplierProductIds: string[]): Promise<string> {
  const variantId = await sellableVariant(f, "SUPPLIER_API");
  let p = 0;
  for (const spId of supplierProductIds) await mapVariantToSupplierProduct(supCtx(f), { variantId, supplierProductId: spId, priority: ++p });
  return variantId;
}
