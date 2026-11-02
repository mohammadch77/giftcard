import { sql } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import type { AuditActor } from "@/modules/audit";
import type { Clock } from "@/platform/clock";
import type { Database, Tx } from "@/platform/db";
import { withTransaction } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { uuidv7 } from "@/platform/ids";
import { setTransitionContext } from "@/platform/transitions";
import {
  PUBLICATION_TRANSITIONS, assertCompatible, brandInput, categoryInput, parse, parsePrice, productInput, productUpdate, regionInput, variantInput, variantUpdate,
} from "../domain/rules";
import type { Availability, FulfillmentMethod, ProductType, PublicationStatus } from "../domain/rules";

/** Everything an admin use case needs. `authorize` is bound to the caller's Actor at the composition root (identity). */
export interface AdminContext {
  db: Database;
  clock: Clock;
  actor: AuditActor;
  authorize(permission: string): Promise<void>;
}

const MSG: Record<string, string> = {
  "23505": "already exists", "23503": "referenced record not found", "23514": "value violates a catalog rule",
  PC001: "lifecycle rule violated", PC002: "category hierarchy rule violated", PC003: "fulfilment or price rule violated", PT001: "invalid status transition",
};
function translate(e: unknown): never {
  const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
  if (code && MSG[code]) throw new DomainError(code === "23505" ? "CATALOG_CONFLICT" : "CATALOG_INVALID", MSG[code]!, { cause: e });
  throw e;
}

async function run<T>(c: AdminContext, permissions: string[], reason: string | undefined, fn: (tx: Tx, now: Date) => Promise<T>): Promise<T> {
  for (const p of permissions) await c.authorize(p);
  try {
    return await withTransaction(c.db, async (tx) => {
      await setTransitionContext(tx, { actorId: c.actor.id, ...(reason ? { reason } : {}) });
      return fn(tx, c.clock.now());
    });
  } catch (e) {
    return translate(e);
  }
}

const audit = (tx: Tx, c: AdminContext, now: Date, action: string, type: string, id: string, extra: { before?: unknown; after?: unknown; metadata?: unknown } = {}) =>
  recordAudit(tx, { actor: c.actor, action, entity: { type, id }, ...extra, occurredAt: now });
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const MANAGE = "catalog.products.manage", PUBLISH = "catalog.products.publish", PRICES = "catalog.prices.manage";
const first = <T>(r: { rows: unknown[] }): T | undefined => r.rows[0] as T | undefined;

export async function createCategory(c: AdminContext, raw: unknown): Promise<{ id: string }> {
  const i = parse(categoryInput, raw);
  return run(c, [MANAGE], undefined, async (tx, now) => {
    const id = uuidv7(c.clock);
    await tx.execute(sql`insert into categories (id, parent_id, slug, name, sort_order, created_at, updated_at) values (${id}, ${i.parentId ?? null}, ${i.slug}, ${i.name}, ${i.sortOrder ?? 0}, ${iso(now)}::timestamptz, ${iso(now)}::timestamptz)`);
    await audit(tx, c, now, "catalog.category.created", "category", id, { after: { slug: i.slug, name: i.name } });
    return { id };
  });
}

export async function createBrand(c: AdminContext, raw: unknown): Promise<{ id: string }> {
  const i = parse(brandInput, raw);
  return run(c, [MANAGE], undefined, async (tx, now) => {
    const id = uuidv7(c.clock);
    await tx.execute(sql`insert into brands (id, slug, name, created_at, updated_at) values (${id}, ${i.slug}, ${i.name}, ${iso(now)}::timestamptz, ${iso(now)}::timestamptz)`);
    await audit(tx, c, now, "catalog.brand.created", "brand", id, { after: { slug: i.slug, name: i.name } });
    return { id };
  });
}

export async function createRegion(c: AdminContext, raw: unknown): Promise<{ id: string }> {
  const i = parse(regionInput, raw);
  return run(c, [MANAGE], undefined, async (tx, now) => {
    const id = uuidv7(c.clock);
    await tx.execute(sql`insert into regions (id, code, name, created_at) values (${id}, ${i.code}, ${i.name}, ${iso(now)}::timestamptz)`);
    await audit(tx, c, now, "catalog.region.created", "region", id, { after: { code: i.code } });
    return { id };
  });
}

export async function archiveBrandOrCategory(c: AdminContext, kind: "brand" | "category", id: string, reason: string): Promise<void> {
  if (reason.trim().length < 5) throw new DomainError("CATALOG_INVALID", "a reason is required");
  await run(c, [PUBLISH], reason.trim(), async (tx, now) => {
    const table = kind === "brand" ? sql`brands` : sql`categories`;
    const col = kind === "brand" ? sql`brand_id` : sql`category_id`;
    const used = await tx.execute(sql`select 1 from products where ${col} = ${id} and status = 'PUBLISHED' limit 1`);
    if (used.rows.length) throw new DomainError("CATALOG_INVALID", `${kind} still has published products`);
    const r = await tx.execute(sql`update ${table} set status = 'ARCHIVED', updated_at = ${iso(now)}::timestamptz where id = ${id} and status = 'ACTIVE' returning id`);
    if (!r.rows.length) throw new DomainError("CATALOG_NOT_FOUND", `${kind} not found or already archived`);
    await audit(tx, c, now, `catalog.${kind}.archived`, kind, id, { metadata: { reason: reason.trim() } });
  });
}

export async function createProduct(c: AdminContext, raw: unknown): Promise<{ id: string }> {
  const i = parse(productInput, raw);
  return run(c, [MANAGE], undefined, async (tx, now) => {
    const id = uuidv7(c.clock);
    await tx.execute(
      sql`insert into products (id, type, brand_id, category_id, slug, name, description, status, created_at, updated_at)
          values (${id}, ${i.type}, ${i.brandId}, ${i.categoryId}, ${i.slug}, ${i.name}, ${i.description ?? null}, 'DRAFT', ${iso(now)}::timestamptz, ${iso(now)}::timestamptz)`,
    );
    await audit(tx, c, now, "catalog.product.created", "product", id, { after: { type: i.type, slug: i.slug, name: i.name } });
    return { id };
  });
}

export async function updateProduct(c: AdminContext, productId: string, raw: unknown): Promise<void> {
  const i = parse(productUpdate, raw);
  await run(c, [MANAGE], undefined, async (tx, now) => {
    const before = first<{ name: string; brand_id: string; category_id: string }>(await tx.execute(sql`select name, brand_id, category_id from products where id = ${productId} for update`));
    if (!before) throw new DomainError("CATALOG_NOT_FOUND", "product not found");
    await tx.execute(
      sql`update products set name = ${i.name ?? before.name},
            description = ${i.description === undefined ? sql`description` : i.description},
            brand_id = ${i.brandId ?? before.brand_id}, category_id = ${i.categoryId ?? before.category_id}, updated_at = ${iso(now)}::timestamptz where id = ${productId}`,
    );
    await audit(tx, c, now, "catalog.product.updated", "product", productId, { before: { name: before.name }, after: { name: i.name ?? before.name, fields: Object.keys(i) } });
  });
}

/** Lifecycle of a product. Leaving PUBLISHED first moves its published variants (same transaction). */
export async function setProductStatus(c: AdminContext, productId: string, to: PublicationStatus, reason: string): Promise<void> {
  if (reason.trim().length < 5) throw new DomainError("CATALOG_INVALID", "a reason is required");
  await run(c, [PUBLISH], reason.trim(), async (tx, now) => {
    const p = first<{ status: PublicationStatus }>(await tx.execute(sql`select status from products where id = ${productId} for update`));
    if (!p) throw new DomainError("CATALOG_NOT_FOUND", "product not found");
    if (!PUBLICATION_TRANSITIONS[p.status].includes(to)) throw new DomainError("CATALOG_INVALID", `cannot move a product from ${p.status} to ${to}`);
    if (p.status === "PUBLISHED") {
      await tx.execute(sql`update product_variants set status = ${to === "ARCHIVED" ? "ARCHIVED" : "DRAFT"}, updated_at = ${iso(now)}::timestamptz where product_id = ${productId} and status = 'PUBLISHED'`);
    }
    if (to === "ARCHIVED") await tx.execute(sql`update product_variants set status = 'ARCHIVED', updated_at = ${iso(now)}::timestamptz where product_id = ${productId} and status = 'DRAFT'`);
    await tx.execute(sql`update products set status = ${to}, updated_at = ${iso(now)}::timestamptz where id = ${productId}`);
    await audit(tx, c, now, "catalog.product.status_changed", "product", productId, { before: { status: p.status }, after: { status: to }, metadata: { reason: reason.trim() } });
  });
}

export async function createVariant(c: AdminContext, productId: string, raw: unknown): Promise<{ id: string }> {
  const i = parse(variantInput, raw);
  const price = parsePrice(i);
  if ((i.faceValue === undefined) !== (i.faceCurrency === undefined)) throw new DomainError("CATALOG_INVALID", "face value and currency go together");
  return run(c, [MANAGE, PRICES], "initial price", async (tx, now) => {
    const p = first<{ type: ProductType }>(await tx.execute(sql`select type from products where id = ${productId} for share`));
    if (!p) throw new DomainError("CATALOG_NOT_FOUND", "product not found");
    assertCompatible(p.type, i.fulfillmentMethod);
    const id = uuidv7(c.clock);
    await tx.execute(
      sql`insert into product_variants (id, product_id, sku, name, region_id, face_value, face_currency, duration_days, fulfillment_method, price, sale_price, sale_starts_at, sale_ends_at, attrs, status, availability, created_at, updated_at)
          values (${id}, ${productId}, ${i.sku}, ${i.name}, ${i.regionId ?? null}, ${i.faceValue ?? null}, ${i.faceCurrency ?? null}, ${i.durationDays ?? null}, ${i.fulfillmentMethod},
                  ${price.price}, ${price.salePrice}, ${iso(price.saleStartsAt)}::timestamptz, ${iso(price.saleEndsAt)}::timestamptz, ${JSON.stringify(i.attrs ?? {})}::jsonb, 'DRAFT', 'AVAILABLE', ${iso(now)}::timestamptz, ${iso(now)}::timestamptz)`,
    );
    await audit(tx, c, now, "catalog.variant.created", "variant", id, { after: { sku: i.sku, fulfillmentMethod: i.fulfillmentMethod, price: price.price, salePrice: price.salePrice } });
    return { id };
  });
}

export async function updateVariant(c: AdminContext, variantId: string, raw: unknown): Promise<void> {
  const i = parse(variantUpdate, raw);
  await run(c, [MANAGE], undefined, async (tx, now) => {
    const v = first<Record<string, unknown> & { product_type: ProductType }>(
      await tx.execute(sql`select v.name, v.region_id, v.face_value, v.face_currency, v.duration_days, v.attrs, v.fulfillment_method, p.type as product_type from product_variants v join products p on p.id = v.product_id where v.id = ${variantId} for update of v`),
    );
    if (!v) throw new DomainError("CATALOG_NOT_FOUND", "variant not found");
    const method = (i.fulfillmentMethod ?? v.fulfillment_method) as FulfillmentMethod;
    assertCompatible(v.product_type, method);
    const pick = <K extends keyof typeof i>(k: K, cur: unknown) => (i[k] === undefined ? cur : i[k]);
    const face = pick("faceValue", v.face_value), cur = pick("faceCurrency", v.face_currency);
    if ((face == null) !== (cur == null)) throw new DomainError("CATALOG_INVALID", "face value and currency go together");
    await tx.execute(
      sql`update product_variants set name = ${pick("name", v.name)}, region_id = ${pick("regionId", v.region_id)}, face_value = ${face}, face_currency = ${cur},
            duration_days = ${pick("durationDays", v.duration_days)}, attrs = ${JSON.stringify(i.attrs ?? v.attrs)}::jsonb, fulfillment_method = ${method}, updated_at = ${iso(now)}::timestamptz where id = ${variantId}`,
    );
    await audit(tx, c, now, "catalog.variant.updated", "variant", variantId, { metadata: { fields: Object.keys(i) } });
  });
}

export interface PriceChange { price: number; salePrice?: number | null; saleStartsAt?: Date | null; saleEndsAt?: Date | null; reason: string }

/** The ONLY path that changes money on a variant. Sensitive (step-up), audited, history appended by the database. */
export async function changePrice(c: AdminContext, variantId: string, change: PriceChange): Promise<void> {
  if (change.reason.trim().length < 5) throw new DomainError("CATALOG_INVALID", "a reason is required");
  const p = parsePrice(change);
  await run(c, [PRICES], change.reason.trim(), async (tx, now) => {
    const before = first<{ price: string; sale_price: string | null }>(await tx.execute(sql`select price, sale_price from product_variants where id = ${variantId} for update`));
    if (!before) throw new DomainError("CATALOG_NOT_FOUND", "variant not found");
    await tx.execute(
      sql`update product_variants set price = ${p.price}, sale_price = ${p.salePrice}, sale_starts_at = ${iso(p.saleStartsAt)}::timestamptz, sale_ends_at = ${iso(p.saleEndsAt)}::timestamptz, updated_at = ${iso(now)}::timestamptz where id = ${variantId}`,
    );
    await audit(tx, c, now, "catalog.variant.price_changed", "variant", variantId, {
      before: { price: Number(before.price), salePrice: before.sale_price === null ? null : Number(before.sale_price) },
      after: { price: p.price, salePrice: p.salePrice }, metadata: { reason: change.reason.trim() },
    });
  });
}

export async function setVariantStatus(c: AdminContext, variantId: string, to: PublicationStatus, reason: string): Promise<void> {
  if (reason.trim().length < 5) throw new DomainError("CATALOG_INVALID", "a reason is required");
  await run(c, [PUBLISH], reason.trim(), async (tx, now) => {
    const v = first<{ status: PublicationStatus }>(await tx.execute(sql`select status from product_variants where id = ${variantId} for update`));
    if (!v) throw new DomainError("CATALOG_NOT_FOUND", "variant not found");
    if (!PUBLICATION_TRANSITIONS[v.status].includes(to)) throw new DomainError("CATALOG_INVALID", `cannot move a variant from ${v.status} to ${to}`);
    await tx.execute(sql`update product_variants set status = ${to}, updated_at = ${iso(now)}::timestamptz where id = ${variantId}`);
    await audit(tx, c, now, "catalog.variant.status_changed", "variant", variantId, { before: { status: v.status }, after: { status: to }, metadata: { reason: reason.trim() } });
  });
}

/** Temporary "not for sale right now" switch (does not change publication state). */
export async function setVariantAvailability(c: AdminContext, variantId: string, availability: Availability, reason: string): Promise<void> {
  if (reason.trim().length < 5) throw new DomainError("CATALOG_INVALID", "a reason is required");
  await run(c, [MANAGE], reason.trim(), async (tx, now) => {
    const r = await tx.execute(sql`update product_variants set availability = ${availability}, updated_at = ${iso(now)}::timestamptz where id = ${variantId} returning id`);
    if (!r.rows.length) throw new DomainError("CATALOG_NOT_FOUND", "variant not found");
    await audit(tx, c, now, "catalog.variant.availability_changed", "variant", variantId, { after: { availability }, metadata: { reason: reason.trim() } });
  });
}

/** Admin read including drafts. Never exposes anything not already in the catalog tables (no costs exist here). */
export async function getProductAdmin(c: AdminContext, productId: string) {
  await c.authorize("catalog.products.read");
  const p = first<Record<string, unknown>>(await c.db.execute(sql`select id, type, brand_id, category_id, slug, name, description, status from products where id = ${productId}`));
  if (!p) throw new DomainError("CATALOG_NOT_FOUND", "product not found");
  const variants = (await c.db.execute(sql`select id, sku, name, fulfillment_method, price, sale_price, status, availability from product_variants where product_id = ${productId} order by id`)).rows;
  return { product: p, variants };
}
