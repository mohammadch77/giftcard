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
  PUBLICATION_TRANSITIONS, assertCompatible, brandInput, categoryInput, fulfillmentChangeInput, gameAccountAttributesInput, gameInput, gamePlatformLinkInput,
  gamePlatformRegionLinkInput, parse, parsePrice, platformInput, productInput, productUpdate, regionInput, variantInput, variantUpdate,
} from "../domain/rules";
import type { Availability, FulfillmentMethod, ProductType, PublicationStatus } from "../domain/rules";

/** Everything an admin use case needs. `authorize` is bound to the caller's Actor at the composition root (identity). */
export interface AdminContext {
  db: Database;
  clock: Clock;
  actor: AuditActor;
  authorize(permission: string): Promise<void>;
  /**
   * C-2: read-only usage probes supplied by the modules that hold variant-bound facts (inventory, fulfillment, suppliers, orders).
   * Catalog may not import them, so the composition root injects them. Without ALL of them the protected method change refuses (fail closed).
   */
  usage?: readonly VariantUsageProbe[];
}

/** What a module reports about a variant: counts of OPEN (non-final) things that depend on its fulfilment method. All must be zero to change it. */
export interface VariantUsageReport { source: string; open: Readonly<Record<string, number>> }
export type VariantUsageProbe = (tx: Tx, variantId: string) => Promise<VariantUsageReport>;
export const REQUIRED_USAGE_SOURCES = ["inventory", "fulfillment", "suppliers", "orders"] as const;

const MSG: Record<string, string> = {
  "23505": "already exists", "23503": "referenced record not found", "23514": "value violates a catalog rule",
  PC001: "lifecycle rule violated", PC002: "category hierarchy rule violated", PC003: "fulfilment or price rule violated", PC004: "an acting administrator is required", PC005: "game / platform / region rule violated", PT001: "invalid status transition",
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
const MANAGE = "catalog.products.manage", PUBLISH = "catalog.products.publish", PRICES = "catalog.prices.manage", FULFILLMENT = "catalog.fulfillment.change";
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
      sql`insert into products (id, type, brand_id, category_id, game_id, slug, name, description, status, created_at, updated_at)
          values (${id}, ${i.type}, ${i.brandId}, ${i.categoryId}, ${i.gameId ?? null}, ${i.slug}, ${i.name}, ${i.description ?? null}, 'DRAFT', ${iso(now)}::timestamptz, ${iso(now)}::timestamptz)`,
    );
    await audit(tx, c, now, "catalog.product.created", "product", id, { after: { type: i.type, slug: i.slug, name: i.name, gameId: i.gameId ?? null } });
    return { id };
  });
}

export async function updateProduct(c: AdminContext, productId: string, raw: unknown): Promise<void> {
  const i = parse(productUpdate, raw);
  await run(c, [MANAGE], undefined, async (tx, now) => {
    const before = first<{ name: string; brand_id: string; category_id: string; game_id: string | null }>(await tx.execute(sql`select name, brand_id, category_id, game_id from products where id = ${productId} for update`));
    if (!before) throw new DomainError("CATALOG_NOT_FOUND", "product not found");
    await tx.execute(
      sql`update products set name = ${i.name ?? before.name},
            description = ${i.description === undefined ? sql`description` : i.description},
            brand_id = ${i.brandId ?? before.brand_id}, category_id = ${i.categoryId ?? before.category_id},
            game_id = ${i.gameId === undefined ? before.game_id : i.gameId}, updated_at = ${iso(now)}::timestamptz where id = ${productId}`,
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
      sql`insert into product_variants (id, product_id, sku, name, region_id, platform_id, face_value, face_currency, duration_days, fulfillment_method, price, sale_price, sale_starts_at, sale_ends_at, attrs, status, availability, created_at, updated_at)
          values (${id}, ${productId}, ${i.sku}, ${i.name}, ${i.regionId ?? null}, ${i.platformId ?? null}, ${i.faceValue ?? null}, ${i.faceCurrency ?? null}, ${i.durationDays ?? null}, ${i.fulfillmentMethod},
                  ${price.price}, ${price.salePrice}, ${iso(price.saleStartsAt)}::timestamptz, ${iso(price.saleEndsAt)}::timestamptz, ${JSON.stringify(i.attrs ?? {})}::jsonb, 'DRAFT', 'AVAILABLE', ${iso(now)}::timestamptz, ${iso(now)}::timestamptz)`,
    );
    await audit(tx, c, now, "catalog.variant.created", "variant", id, { after: { sku: i.sku, fulfillmentMethod: i.fulfillmentMethod, price: price.price, salePrice: price.salePrice } });
    return { id };
  });
}

export async function updateVariant(c: AdminContext, variantId: string, raw: unknown): Promise<void> {
  const i = parse(variantUpdate, raw);
  await run(c, [MANAGE], undefined, async (tx, now) => {
    const v = first<Record<string, unknown>>(
      await tx.execute(sql`select name, region_id, platform_id, face_value, face_currency, duration_days, attrs from product_variants where id = ${variantId} for update`),
    );
    if (!v) throw new DomainError("CATALOG_NOT_FOUND", "variant not found");
    const pick = <K extends keyof typeof i>(k: K, cur: unknown) => (i[k] === undefined ? cur : i[k]);
    const face = pick("faceValue", v.face_value), cur = pick("faceCurrency", v.face_currency);
    if ((face == null) !== (cur == null)) throw new DomainError("CATALOG_INVALID", "face value and currency go together");
    // The fulfilment method is NOT touched here: it changes only through changeFulfillmentMethod (permission, reason, usage checks, audit).
    await tx.execute(
      sql`update product_variants set name = ${pick("name", v.name)}, region_id = ${pick("regionId", v.region_id)}, platform_id = ${pick("platformId", v.platform_id)}, face_value = ${face}, face_currency = ${cur},
            duration_days = ${pick("durationDays", v.duration_days)}, attrs = ${JSON.stringify(i.attrs ?? v.attrs)}::jsonb, updated_at = ${iso(now)}::timestamptz where id = ${variantId}`,
    );
    await audit(tx, c, now, "catalog.variant.updated", "variant", variantId, { metadata: { fields: Object.keys(i) } });
  });
}

/**
 * C-2: the ONLY way to change a variant's fulfilment method. Needs `catalog.fulfillment.change` (sensitive, step-up) and a reason; the variant must be
 * unpublished (DRAFT) and NOT IN USE: no open reservation or stock, no open fulfilment task, no supplier route, no open order (every module reports through
 * the injected probes; a missing probe refuses). The change row is written first, in the same transaction — the database trigger rejects a method
 * change without it. Historical orders keep their own snapshot and are never touched.
 */
export async function changeFulfillmentMethod(c: AdminContext, variantId: string, raw: unknown): Promise<void> {
  const i = parse(fulfillmentChangeInput, raw);
  await run(c, [MANAGE, FULFILLMENT], i.reason, async (tx, now) => {
    const v = first<{ fulfillment_method: FulfillmentMethod; status: PublicationStatus; product_type: ProductType }>(
      await tx.execute(sql`select v.fulfillment_method, v.status, p.type as product_type from product_variants v join products p on p.id = v.product_id where v.id = ${variantId} for update of v`),
    );
    if (!v) throw new DomainError("CATALOG_NOT_FOUND", "variant not found");
    if (v.status !== "DRAFT") throw new DomainError("CATALOG_INVALID", "unpublish the variant (DRAFT) before changing its fulfilment method");
    if (v.fulfillment_method === i.to) throw new DomainError("CATALOG_INVALID", "the variant already uses this fulfilment method");
    assertCompatible(v.product_type, i.to);
    const reports: VariantUsageReport[] = [];
    for (const probe of c.usage ?? []) reports.push(await probe(tx, variantId));
    const missing = REQUIRED_USAGE_SOURCES.filter((s) => !reports.some((r) => r.source === s));
    if (missing.length) throw new DomainError("CATALOG_USAGE_UNKNOWN", `cannot verify the variant is unused (no report from: ${missing.join(", ")})`);
    const open = reports.flatMap((r) => Object.entries(r.open).filter(([, n]) => n > 0).map(([k, n]) => `${r.source}.${k}=${n}`));
    if (open.length) throw new DomainError("CATALOG_VARIANT_IN_USE", `the variant is in use (${open.join(", ")})`);
    const usage = Object.fromEntries(reports.map((r) => [r.source, r.open]));
    await tx.execute(
      sql`insert into variant_fulfillment_changes (variant_id, from_method, to_method, reason, actor_id, usage, changed_at)
          values (${variantId}, ${v.fulfillment_method}, ${i.to}, ${i.reason}, ${c.actor.id}, ${JSON.stringify(usage)}::jsonb, ${iso(now)}::timestamptz)`,
    );
    await tx.execute(sql`update product_variants set fulfillment_method = ${i.to}, updated_at = ${iso(now)}::timestamptz where id = ${variantId}`);
    await audit(tx, c, now, "catalog.variant.fulfillment_changed", "variant", variantId, { before: { fulfillmentMethod: v.fulfillment_method }, after: { fulfillmentMethod: i.to }, metadata: { reason: i.reason, usage } });
  });
}

/** Variants whose current method the matrix no longer allows (grandfathered by the P1-B tightening). They keep working but cannot be published again. */
export async function listIncompatibleVariants(c: AdminContext): Promise<{ variantId: string; sku: string; productType: string; fulfillmentMethod: string; status: string }[]> {
  await c.authorize("catalog.products.read");
  const r = await c.db.execute(
    sql`select v.id, v.sku, p.type, v.fulfillment_method, v.status from product_variants v join products p on p.id = v.product_id
         where not exists (select 1 from product_type_fulfillment f where f.product_type = p.type and f.method = v.fulfillment_method) order by v.id`,
  );
  return (r.rows as { id: string; sku: string; type: string; fulfillment_method: string; status: string }[]).map((x) => ({ variantId: x.id, sku: x.sku, productType: x.type, fulfillmentMethod: x.fulfillment_method, status: x.status }));
}

export async function createGame(c: AdminContext, raw: unknown): Promise<{ id: string }> {
  const i = parse(gameInput, raw);
  return run(c, [MANAGE], undefined, async (tx, now) => {
    const id = uuidv7(c.clock);
    await tx.execute(sql`insert into games (id, slug, name, created_at, updated_at) values (${id}, ${i.slug}, ${i.name}, ${iso(now)}::timestamptz, ${iso(now)}::timestamptz)`);
    await audit(tx, c, now, "catalog.game.created", "game", id, { after: { slug: i.slug, name: i.name } });
    return { id };
  });
}

export async function createPlatform(c: AdminContext, raw: unknown): Promise<{ id: string }> {
  const i = parse(platformInput, raw);
  return run(c, [MANAGE], undefined, async (tx, now) => {
    const id = uuidv7(c.clock);
    await tx.execute(sql`insert into platforms (id, slug, name, created_at, updated_at) values (${id}, ${i.slug}, ${i.name}, ${iso(now)}::timestamptz, ${iso(now)}::timestamptz)`);
    await audit(tx, c, now, "catalog.platform.created", "platform", id, { after: { slug: i.slug, name: i.name } });
    return { id };
  });
}

/** Archive a game or platform (never deleted). Refused while a PUBLISHED product/variant still uses it. */
export async function archiveGameOrPlatform(c: AdminContext, kind: "game" | "platform", id: string, reason: string): Promise<void> {
  if (reason.trim().length < 5) throw new DomainError("CATALOG_INVALID", "a reason is required");
  await run(c, [PUBLISH], reason.trim(), async (tx, now) => {
    const used =
      kind === "game"
        ? await tx.execute(sql`select 1 from products where game_id = ${id} and status = 'PUBLISHED' limit 1`)
        : await tx.execute(sql`select 1 from product_variants where platform_id = ${id} and status = 'PUBLISHED' limit 1`);
    if (used.rows.length) throw new DomainError("CATALOG_INVALID", `${kind} is still used by published catalog data`);
    const table = kind === "game" ? sql`games` : sql`platforms`;
    const r = await tx.execute(sql`update ${table} set status = 'ARCHIVED', updated_at = ${iso(now)}::timestamptz where id = ${id} and status = 'ACTIVE' returning id`);
    if (!r.rows.length) throw new DomainError("CATALOG_NOT_FOUND", `${kind} not found or already archived`);
    await audit(tx, c, now, `catalog.${kind}.archived`, kind, id, { metadata: { reason: reason.trim() } });
  });
}

/** Declare that a game exists on a platform. Idempotent; the relationship is never removed (variants may rely on it). */
export async function linkGamePlatform(c: AdminContext, raw: unknown): Promise<{ created: boolean }> {
  const i = parse(gamePlatformLinkInput, raw);
  return run(c, [MANAGE], undefined, async (tx, now) => {
    const ok = await tx.execute(sql`select (select count(*) from games where id = ${i.gameId} and status = 'ACTIVE') + (select count(*) from platforms where id = ${i.platformId} and status = 'ACTIVE') as n`);
    if (Number((ok.rows[0] as { n: string }).n) !== 2) throw new DomainError("CATALOG_INVALID", "game and platform must exist and be active");
    const r = await tx.execute(sql`insert into game_platforms (game_id, platform_id, created_at) values (${i.gameId}, ${i.platformId}, ${iso(now)}::timestamptz) on conflict do nothing returning game_id`);
    if (r.rows.length) await audit(tx, c, now, "catalog.game_platform.linked", "game", i.gameId, { after: { platformId: i.platformId } });
    return { created: r.rows.length === 1 };
  });
}

/** Declare that a game on a platform is offered in a region (the game/platform link must exist). Idempotent; never removed. */
export async function linkGamePlatformRegion(c: AdminContext, raw: unknown): Promise<{ created: boolean }> {
  const i = parse(gamePlatformRegionLinkInput, raw);
  return run(c, [MANAGE], undefined, async (tx, now) => {
    const r = await tx.execute(sql`insert into game_platform_regions (game_id, platform_id, region_id, created_at) values (${i.gameId}, ${i.platformId}, ${i.regionId}, ${iso(now)}::timestamptz) on conflict do nothing returning game_id`);
    if (r.rows.length) await audit(tx, c, now, "catalog.game_platform_region.linked", "game", i.gameId, { after: { platformId: i.platformId, regionId: i.regionId } });
    return { created: r.rows.length === 1 };
  });
}

/**
 * B2: set the typed PUBLIC attributes of a GAME_ACCOUNT variant (DRAFT only). Credentials are not representable here — they stay sealed in
 * inventory (pre-loaded accounts) or in the manual-fulfilment secret path. The attributes are snapshotted into every new order.
 */
export async function setGameAccountAttributes(c: AdminContext, variantId: string, raw: unknown): Promise<void> {
  const i = parse(gameAccountAttributesInput, raw);
  await run(c, [MANAGE], undefined, async (tx, now) => {
    const found = await tx.execute(sql`select 1 from product_variants where id = ${variantId} for update`);
    if (!found.rows.length) throw new DomainError("CATALOG_NOT_FOUND", "variant not found");
    await tx.execute(
      sql`insert into game_account_attributes (variant_id, account_type, level, included_items, features, created_at, updated_at)
          values (${variantId}, ${i.accountType}, ${i.level ?? null}, ${JSON.stringify(i.includedItems ?? [])}::jsonb, ${JSON.stringify(i.features ?? [])}::jsonb, ${iso(now)}::timestamptz, ${iso(now)}::timestamptz)
          on conflict (variant_id) do update set account_type = excluded.account_type, level = excluded.level, included_items = excluded.included_items, features = excluded.features, updated_at = excluded.updated_at`,
    );
    await audit(tx, c, now, "catalog.variant.account_attributes_set", "variant", variantId, { after: { accountType: i.accountType, level: i.level ?? null, includedItems: i.includedItems?.length ?? 0, features: i.features?.length ?? 0 } });
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
  const p = first<Record<string, unknown>>(await c.db.execute(sql`select id, type, brand_id, category_id, game_id, slug, name, description, status from products where id = ${productId}`));
  if (!p) throw new DomainError("CATALOG_NOT_FOUND", "product not found");
  const variants = (await c.db.execute(sql`select id, sku, name, platform_id, region_id, fulfillment_method, price, sale_price, status, availability from product_variants where product_id = ${productId} order by id`)).rows;
  return { product: p, variants };
}
