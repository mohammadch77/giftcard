import { sql } from "drizzle-orm";
import type { AuditActor } from "@/modules/audit";
import { getVariantSnapshot } from "@/modules/catalog";
import type { Clock } from "@/platform/clock";
import type { KeyProvider } from "@/platform/crypto";
import { encodeSealed, sealSecret } from "@/platform/crypto";
import type { Database } from "@/platform/db";
import { withTransaction } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { uuidv7 } from "@/platform/ids";
import { credentialsSchema, parse, routeInput, supplierInput, supplierUpdate } from "../domain/rules";
import { audit, credSealCtx, first, iso } from "./shared";

export interface SupplierAdminContext { db: Database; clock: Clock; keys: KeyProvider; actor: AuditActor; authorize(permission: string): Promise<void> }

const pgCode = (e: unknown) => (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
function translate(e: unknown): never {
  const c = pgCode(e);
  if (c === "23505") throw new DomainError("SUPPLIER_INVALID", "already exists", { cause: e });
  if (c === "23503" || c === "23514") throw new DomainError("SUPPLIER_INVALID", "violates a supplier rule", { cause: e });
  throw e;
}

export async function createSupplier(c: SupplierAdminContext, raw: unknown): Promise<{ id: string }> {
  await c.authorize("suppliers.manage");
  const i = parse(supplierInput, raw);
  try {
    return await withTransaction(c.db, async (tx) => {
      const id = uuidv7(c.clock);
      const now = iso(c.clock.now());
      await tx.execute(sql`insert into suppliers (id, key, name, adapter_key, status, config, created_at, updated_at) values (${id}, ${i.key}, ${i.name}, ${i.adapterKey}, 'ACTIVE', ${JSON.stringify(i.config ?? {})}::jsonb, ${now}::timestamptz, ${now}::timestamptz)`);
      await audit(tx, c.actor, c.clock.now(), "suppliers.supplier.created", { type: "supplier", id }, { key: i.key, adapterKey: i.adapterKey });
      return { id };
    });
  } catch (e) {
    return translate(e);
  }
}

export async function updateSupplier(c: SupplierAdminContext, supplierId: string, raw: unknown): Promise<void> {
  await c.authorize("suppliers.manage");
  const i = parse(supplierUpdate, raw);
  await withTransaction(c.db, async (tx) => {
    const cur = first<{ name: string; status: string; config: unknown }>(await tx.execute(sql`select name, status, config from suppliers where id = ${supplierId} for update`));
    if (!cur) throw new DomainError("SUPPLIER_NOT_FOUND", "supplier not found");
    await tx.execute(sql`update suppliers set name = ${i.name ?? cur.name}, status = ${i.status ?? cur.status}, config = ${JSON.stringify(i.config ?? cur.config)}::jsonb, updated_at = ${iso(c.clock.now())}::timestamptz where id = ${supplierId}`);
    await audit(tx, c.actor, c.clock.now(), "suppliers.supplier.updated", { type: "supplier", id: supplierId }, { fields: Object.keys(i), status: i.status ?? cur.status });
  });
}

/**
 * WRITE-ONLY credential store. The secret object is validated, sealed (AES-256-GCM envelope) BEFORE the transaction, replaces
 * the previous ACTIVE row (kept as REPLACED, never deleted), and is audited with field COUNT only. There is no read API: the only
 * consumer is `withCredentials`, which feeds an adapter call. Fails closed without a KeyProvider (production default, D8).
 */
export async function setSupplierCredentials(c: SupplierAdminContext, supplierId: string, secret: unknown): Promise<void> {
  await c.authorize("suppliers.credentials.manage");
  const parsed = credentialsSchema.safeParse(secret);
  if (!parsed.success) throw new DomainError("SUPPLIER_INVALID", "invalid credentials shape");
  const exists = await c.db.execute(sql`select 1 from suppliers where id = ${supplierId}`);
  if (!exists.rows.length) throw new DomainError("SUPPLIER_NOT_FOUND", "supplier not found");
  const id = uuidv7(c.clock);
  const plain = Buffer.from(JSON.stringify(parsed.data), "utf8");
  let sealed: Buffer;
  try {
    sealed = encodeSealed(await sealSecret(c.keys, plain, credSealCtx(id)));
  } finally {
    plain.fill(0);
  }
  await withTransaction(c.db, async (tx) => {
    const now = iso(c.clock.now());
    await tx.execute(sql`update supplier_credentials set status = 'REPLACED', replaced_at = ${now}::timestamptz where supplier_id = ${supplierId} and status = 'ACTIVE'`);
    await tx.execute(sql`insert into supplier_credentials (id, supplier_id, sealed, status, created_at) values (${id}, ${supplierId}, ${sealed}, 'ACTIVE', ${now}::timestamptz)`);
    await audit(tx, c.actor, c.clock.now(), "suppliers.credentials.set", { type: "supplier", id: supplierId }, { fields: Object.keys(parsed.data).length });
  });
}

/** Map a catalog variant to a supplier product (failover order = priority). The variant must be a SUPPLIER_API variant; the supplier must be ACTIVE. */
export async function mapVariantToSupplierProduct(c: SupplierAdminContext, raw: unknown): Promise<{ routeId: string }> {
  await c.authorize("suppliers.routes.manage");
  const i = parse(routeInput, raw);
  const v = await getVariantSnapshot(c.db, i.variantId);
  if (!v) throw new DomainError("SUPPLIER_INVALID", "variant not found");
  if (v.fulfillmentMethod !== "SUPPLIER_API") throw new DomainError("SUPPLIER_INVALID", "only SUPPLIER_API variants can be mapped to suppliers");
  try {
    return await withTransaction(c.db, async (tx) => {
      const sp = first<{ status: string }>(await tx.execute(sql`select s.status from supplier_products p join suppliers s on s.id = p.supplier_id where p.id = ${i.supplierProductId}`));
      if (!sp) throw new DomainError("SUPPLIER_NOT_FOUND", "supplier product not found");
      if (sp.status !== "ACTIVE") throw new DomainError("SUPPLIER_INVALID", "supplier is not active");
      const id = uuidv7(c.clock);
      const now = iso(c.clock.now());
      await tx.execute(sql`insert into variant_supplier_routes (id, variant_id, supplier_product_id, priority, active, created_at, updated_at) values (${id}, ${i.variantId}, ${i.supplierProductId}, ${i.priority}, true, ${now}::timestamptz, ${now}::timestamptz)`);
      await audit(tx, c.actor, c.clock.now(), "suppliers.route.created", { type: "variant_route", id }, { priority: i.priority });
      return { routeId: id };
    });
  } catch (e) {
    return translate(e);
  }
}

export async function deactivateRoute(c: SupplierAdminContext, routeId: string, reason: string): Promise<void> {
  await c.authorize("suppliers.routes.manage");
  if (reason.trim().length < 5) throw new DomainError("SUPPLIER_INVALID", "a reason is required");
  await withTransaction(c.db, async (tx) => {
    const r = await tx.execute(sql`update variant_supplier_routes set active = false, updated_at = ${iso(c.clock.now())}::timestamptz where id = ${routeId} and active returning id`);
    if (!r.rows.length) throw new DomainError("SUPPLIER_NOT_FOUND", "active route not found");
    await audit(tx, c.actor, c.clock.now(), "suppliers.route.deactivated", { type: "variant_route", id: routeId }, { reason: reason.trim() });
  });
}

export interface RouteView { routeId: string; supplierId: string; supplierKey: string; supplierProductId: string; externalSku: string; priority: number; available: boolean; cost: number }

/** Active routes for a variant in failover order, only for ACTIVE suppliers. Used by fulfillment; costs are facts, not prices. */
export async function getRoutes(db: Database, variantId: string): Promise<RouteView[]> {
  const r = await db.execute(
    sql`select r.id, s.id as supplier_id, s.key, p.id as product_id, p.external_sku, r.priority, p.available, p.cost
          from variant_supplier_routes r join supplier_products p on p.id = r.supplier_product_id join suppliers s on s.id = p.supplier_id
         where r.variant_id = ${variantId} and r.active and s.status = 'ACTIVE' order by r.priority`,
  );
  return (r.rows as { id: string; supplier_id: string; key: string; product_id: string; external_sku: string; priority: number; available: boolean; cost: string }[]).map((x) => ({
    routeId: x.id, supplierId: x.supplier_id, supplierKey: x.key, supplierProductId: x.product_id, externalSku: x.external_sku, priority: x.priority, available: x.available, cost: Number(x.cost),
  }));
}

export async function getSupplierAdmin(c: SupplierAdminContext, supplierId: string) {
  await c.authorize("suppliers.read");
  const s = first<Record<string, unknown>>(await c.db.execute(sql`select id, key, name, adapter_key, status, config, (select count(*) from supplier_credentials x where x.supplier_id = suppliers.id and x.status = 'ACTIVE')::int as has_credentials from suppliers where id = ${supplierId}`));
  if (!s) throw new DomainError("SUPPLIER_NOT_FOUND", "supplier not found");
  return s; // credentials are never part of this view (only whether they exist)
}
