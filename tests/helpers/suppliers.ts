import type { Pool } from "pg";
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

/**
 * Insert a PAID order (as the database owner) so fulfilment rows can pass the payment gate (migration 0021).
 * Returns the order id and one unit reference (`<item id>#<n>`) per unit of every requested item.
 */
export async function seedPaidOrder(f: { t: { pool: Pool } }, userId: string, items: { variantId: string; qty?: number }[]) {
  const orderId = crypto.randomUUID();
  const total = items.reduce((s, i) => s + 1000 * (i.qty ?? 1), 0);
  const c = await f.t.pool.connect();
  const refs: string[] = [];
  try {
    await c.query("select set_config('app.actor_id','test-seed',false)");
    await c.query("begin");
    await c.query(
      `insert into orders (id, number, user_ref, status, payment_status, payment_method, currency, total, pricing_version, refund_policy_version, policy_snapshot, idempotency_key, request_hash, expires_at, paid_at, created_at, updated_at)
       values ($1, $2, $3, 'PENDING_PAYMENT', 'PENDING', 'WALLET', 'IRR', $4, 'test', 'temporary-0', '{"refundPolicyVersion":"temporary-0"}'::jsonb, $5, decode(repeat('ab',32),'hex'), now() + interval '1 hour', null, now(), now())`,
      [orderId, `T${Math.random().toString(36).slice(2, 8).toUpperCase()}`, userId, total, `seed-${orderId}`],
    );
    let line = 0;
    for (const it of items) {
      const itemId = crypto.randomUUID();
      const qty = it.qty ?? 1;
      await c.query(`insert into order_items (id, order_id, line_no, variant_id, quantity, unit_price, line_total, snapshot, created_at) values ($1,$2,$3,$4,$5,1000,$6,'{}'::jsonb,now())`, [itemId, orderId, ++line, it.variantId, qty, 1000 * qty]);
      for (let k = 1; k <= qty; k++) refs.push(`${itemId}#${k}`);
    }
    await c.query("update orders set status = 'PAID', payment_status = 'SUCCEEDED', paid_at = now() where id = $1", [orderId]);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  return { orderId, refs };
}
