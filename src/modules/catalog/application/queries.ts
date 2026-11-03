import { sql } from "drizzle-orm";
import type { Database, Tx } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { isUuid } from "@/platform/ids";
import type { Availability, FulfillmentMethod, ProductType } from "../domain/rules";

type Ts = Date | string | null;
const toDate = (v: Ts): Date | null => (v === null ? null : v instanceof Date ? v : new Date(v.replace(" ", "T").replace(/(\.\d{3})\d*/, "$1").replace(/([+-]\d{2})$/, "$1:00")));
const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

/** Price facts needed by the pricing module — nothing else leaves the catalog for pricing. */
export interface PriceableVariant {
  variantId: string;
  price: number;
  salePrice: number | null;
  saleStartsAt: Date | null;
  saleEndsAt: Date | null;
  /** Published variant under a published product AND currently available. */
  sellable: boolean;
}

const MAX_IDS = 100;
function idList(ids: readonly string[]) {
  if (ids.length === 0 || ids.length > MAX_IDS) throw new DomainError("CATALOG_INVALID", `1..${MAX_IDS} variant ids expected`);
  for (const id of ids) if (!isUuid(id)) throw new DomainError("CATALOG_INVALID", "invalid variant id");
  return sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);
}

/**
 * Price rows for pricing. With `lockShare` the rows are locked FOR SHARE until the caller's transaction ends,
 * so a concurrent price change waits and a quote can never mix two price generations.
 */
export async function getPriceableVariants(tx: Tx | Database, ids: readonly string[], opts: { lockShare?: boolean } = {}): Promise<PriceableVariant[]> {
  const r = await tx.execute(
    sql`select v.id, v.price, v.sale_price, v.sale_starts_at, v.sale_ends_at, (v.status = 'PUBLISHED' and p.status = 'PUBLISHED' and v.availability = 'AVAILABLE') as sellable
          from product_variants v join products p on p.id = v.product_id
         where v.id in (${idList(ids)}) order by v.id ${opts.lockShare ? sql`for share of v` : sql``}`,
  );
  return (r.rows as { id: string; price: string; sale_price: string | null; sale_starts_at: Ts; sale_ends_at: Ts; sellable: boolean }[]).map((x) => ({
    variantId: x.id, price: Number(x.price), salePrice: num(x.sale_price), saleStartsAt: toDate(x.sale_starts_at), saleEndsAt: toDate(x.sale_ends_at), sellable: x.sellable,
  }));
}

/** Customer-facing DTO: explicit column list; only descriptive data (no costs/suppliers exist in the catalog). */
export interface VariantSnapshot {
  variantId: string;
  productId: string;
  productSlug: string;
  productName: string;
  productType: ProductType;
  brand: { slug: string; name: string };
  sku: string;
  name: string;
  regionCode: string | null;
  faceValue: number | null;
  faceCurrency: string | null;
  durationDays: number | null;
  fulfillmentMethod: FulfillmentMethod;
  attrs: Record<string, string | number | boolean>;
  availability: Availability;
  sellable: boolean;
}

const SNAPSHOT_SELECT = sql`select v.id as variant_id, p.id as product_id, p.slug as product_slug, p.name as product_name, p.type as product_type, b.slug as brand_slug, b.name as brand_name,
  v.sku, v.name, r.code as region_code, v.face_value, v.face_currency, v.duration_days, v.fulfillment_method, v.attrs, v.availability,
  (v.status = 'PUBLISHED' and p.status = 'PUBLISHED' and v.availability = 'AVAILABLE') as sellable
  from product_variants v join products p on p.id = v.product_id join brands b on b.id = p.brand_id left join regions r on r.id = v.region_id`;

function toSnapshot(x: Record<string, unknown>): VariantSnapshot {
  return {
    variantId: x.variant_id as string, productId: x.product_id as string, productSlug: x.product_slug as string, productName: x.product_name as string,
    productType: x.product_type as ProductType, brand: { slug: x.brand_slug as string, name: x.brand_name as string }, sku: x.sku as string, name: x.name as string,
    regionCode: (x.region_code as string | null) ?? null, faceValue: num(x.face_value as string | number | null), faceCurrency: (x.face_currency as string | null) ?? null,
    durationDays: (x.duration_days as number | null) ?? null, fulfillmentMethod: x.fulfillment_method as FulfillmentMethod,
    attrs: x.attrs as VariantSnapshot["attrs"], availability: x.availability as Availability, sellable: x.sellable as boolean,
  };
}

/** What orders will snapshot at purchase. Works for any state (history must keep resolving); check `sellable`. */
export async function getVariantSnapshot(db: Database | Tx, variantId: string): Promise<VariantSnapshot | null> {
  if (!isUuid(variantId)) return null;
  const r = await db.execute(sql`${SNAPSHOT_SELECT} where v.id = ${variantId}`);
  return r.rows[0] ? toSnapshot(r.rows[0] as Record<string, unknown>) : null;
}

export interface ListFilters { brandSlug?: string; categorySlug?: string; type?: ProductType; limit?: number; after?: string }

/** Published and currently sellable variants, keyset-paginated by variant id. Uses products_listing_idx. */
export async function listPublished(db: Database | Tx, f: ListFilters = {}): Promise<{ items: VariantSnapshot[]; next: string | null }> {
  const limit = Math.min(Math.max(f.limit ?? 24, 1), 100);
  if (f.after !== undefined && !isUuid(f.after)) throw new DomainError("CATALOG_INVALID", "invalid cursor");
  const conds = [sql`v.status = 'PUBLISHED'`, sql`p.status = 'PUBLISHED'`, sql`v.availability = 'AVAILABLE'`];
  if (f.brandSlug) conds.push(sql`b.slug = ${f.brandSlug}`);
  if (f.type) conds.push(sql`p.type = ${f.type}`);
  if (f.categorySlug) conds.push(sql`p.category_id = (select id from categories where slug = ${f.categorySlug})`);
  if (f.after) conds.push(sql`v.id > ${f.after}::uuid`);
  const r = await db.execute(sql`${SNAPSHOT_SELECT} where ${sql.join(conds, sql` and `)} order by v.id limit ${limit + 1}`);
  const items = (r.rows as Record<string, unknown>[]).map(toSnapshot);
  const more = items.length > limit;
  const page = more ? items.slice(0, limit) : items;
  return { items: page, next: more ? page[page.length - 1]!.variantId : null };
}

/**
 * The fulfilment-compatibility rules (table product_type_fulfillment, C-2) in force RIGHT NOW for the given product types.
 * Orders snapshot this at checkout so a later tightening of the matrix never rewrites what an old order was sold under.
 */
export async function getFulfillmentCompatibility(db: Database | Tx, types: readonly string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  if (types.length === 0) return out;
  const r = await db.execute(sql`select product_type, method from product_type_fulfillment where product_type in (${sql.join(types.map((t) => sql`${t}`), sql`, `)}) order by product_type, method`);
  for (const row of r.rows as { product_type: string; method: string }[]) (out[row.product_type] ??= []).push(row.method);
  return out;
}
