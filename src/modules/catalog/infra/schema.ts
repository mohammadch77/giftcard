import { sql } from "drizzle-orm";
import { bigint, char, check, customType, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Catalog tables — private to the catalog module. Variants are the sellable unit.
 * Money columns use the PostgreSQL domain rial_price (integer Rial, multiple of 10, <= 10^13).
 * Catalog prices are NOT ledger entries. Rows are archived, never deleted (no DELETE grants).
 */
const rialPrice = customType<{ data: number; driverData: string }>({
  dataType: () => "rial_price",
  toDriver: (v) => String(v),
  fromDriver: (v) => Number(v),
});
const ts = (name: string) => timestamp(name, { withTimezone: true });
const SLUG = sql`'^[a-z0-9]+(-[a-z0-9]+)*$'`;

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey(),
    parentId: uuid("parent_id"),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    status: text("status").notNull().default("ACTIVE"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("categories_slug_uq").on(t.slug),
    check("categories_slug_format", sql`${t.slug} ~ ${SLUG} and char_length(${t.slug}) <= 80`),
    check("categories_name_len", sql`char_length(btrim(${t.name})) between 1 and 120`),
    check("categories_status", sql`${t.status} in ('ACTIVE','ARCHIVED')`),
    check("categories_not_own_parent", sql`${t.parentId} is null or ${t.parentId} <> ${t.id}`),
    index("categories_parent_idx").on(t.parentId),
  ],
);

export const brands = pgTable(
  "brands",
  {
    id: uuid("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("brands_slug_uq").on(t.slug),
    check("brands_slug_format", sql`${t.slug} ~ ${SLUG} and char_length(${t.slug}) <= 80`),
    check("brands_name_len", sql`char_length(btrim(${t.name})) between 1 and 120`),
    check("brands_status", sql`${t.status} in ('ACTIVE','ARCHIVED')`),
  ],
);

export const regions = pgTable(
  "regions",
  {
    id: uuid("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("regions_code_uq").on(t.code),
    check("regions_code_format", sql`${t.code} ~ '^[A-Z]{2,8}$'`),
    check("regions_name_len", sql`char_length(btrim(${t.name})) between 1 and 80`),
  ],
);

/** Which fulfilment methods a product type may use (PROPOSAL pending B1/B2; data, not code). */
export const productTypeFulfillment = pgTable(
  "product_type_fulfillment",
  { productType: text("product_type").notNull(), method: text("method").notNull() },
  (t) => [uniqueIndex("product_type_fulfillment_uq").on(t.productType, t.method)],
);

/** P1-B (B1): games and platforms are first-class, admin-managed entities. Archived, never deleted. */
export const games = pgTable(
  "games",
  {
    id: uuid("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("games_slug_uq").on(t.slug),
    check("games_slug_format", sql`${t.slug} ~ ${SLUG} and char_length(${t.slug}) <= 80`),
    check("games_name_len", sql`char_length(btrim(${t.name})) between 1 and 160`),
    check("games_status", sql`${t.status} in ('ACTIVE','ARCHIVED')`),
  ],
);

export const platforms = pgTable(
  "platforms",
  {
    id: uuid("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("platforms_slug_uq").on(t.slug),
    check("platforms_slug_format", sql`${t.slug} ~ ${SLUG} and char_length(${t.slug}) <= 80`),
    check("platforms_name_len", sql`char_length(btrim(${t.name})) between 1 and 120`),
    check("platforms_status", sql`${t.status} in ('ACTIVE','ARCHIVED')`),
  ],
);

/** Which platforms a game exists on. */
export const gamePlatforms = pgTable(
  "game_platforms",
  {
    gameId: uuid("game_id").notNull().references(() => games.id),
    platformId: uuid("platform_id").notNull().references(() => platforms.id),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [primaryKey({ name: "game_platforms_pk", columns: [t.gameId, t.platformId] })],
);

/** Which regions a game is offered in on a given platform (the triple a variant may reference). */
export const gamePlatformRegions = pgTable(
  "game_platform_regions",
  {
    gameId: uuid("game_id").notNull(),
    platformId: uuid("platform_id").notNull(),
    regionId: uuid("region_id").notNull().references(() => regions.id),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "game_platform_regions_pk", columns: [t.gameId, t.platformId, t.regionId] }),
    foreignKey({ name: "game_platform_regions_gp_fk", columns: [t.gameId, t.platformId], foreignColumns: [gamePlatforms.gameId, gamePlatforms.platformId] }),
  ],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey(),
    type: text("type").notNull(),
    /** P1-B: optional first-class game reference (required for GAME_ACCOUNT before publication). */
    gameId: uuid("game_id").references(() => games.id),
    brandId: uuid("brand_id").notNull().references(() => brands.id),
    categoryId: uuid("category_id").notNull().references(() => categories.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("DRAFT"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("products_slug_uq").on(t.slug),
    check("products_type", sql`${t.type} in ('GIFT_CARD','GAME_ACCOUNT','GAME_SUBSCRIPTION','STREAMING_SUBSCRIPTION','DIGITAL_SERVICE','OTHER')`),
    check("products_slug_format", sql`${t.slug} ~ ${SLUG} and char_length(${t.slug}) <= 120`),
    check("products_name_len", sql`char_length(btrim(${t.name})) between 1 and 200`),
    check("products_description_len", sql`${t.description} is null or char_length(${t.description}) <= 5000`),
    check("products_status", sql`${t.status} in ('DRAFT','PUBLISHED','ARCHIVED')`),
    index("products_listing_idx").on(t.brandId, t.categoryId).where(sql`${t.status} = 'PUBLISHED'`),
    index("products_category_idx").on(t.categoryId),
  ],
);

export const productVariants = pgTable(
  "product_variants",
  {
    id: uuid("id").primaryKey(),
    productId: uuid("product_id").notNull().references(() => products.id),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    regionId: uuid("region_id").references(() => regions.id),
    /** P1-B: optional first-class platform reference (required for GAME_ACCOUNT before publication). */
    platformId: uuid("platform_id").references(() => platforms.id),
    /** Face value of the foreign-currency product (descriptive only; never used in Rial arithmetic). */
    faceValue: bigint("face_value", { mode: "number" }),
    faceCurrency: char("face_currency", { length: 3 }),
    durationDays: integer("duration_days"),
    fulfillmentMethod: text("fulfillment_method").notNull(),
    price: rialPrice("price").notNull(),
    salePrice: rialPrice("sale_price"),
    saleStartsAt: ts("sale_starts_at"),
    saleEndsAt: ts("sale_ends_at"),
    attrs: jsonb("attrs").notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("DRAFT"),
    availability: text("availability").notNull().default("AVAILABLE"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("product_variants_sku_uq").on(t.productId, t.sku),
    check("variants_sku_format", sql`${t.sku} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'`),
    check("variants_name_len", sql`char_length(btrim(${t.name})) between 1 and 200`),
    check("variants_fulfillment", sql`${t.fulfillmentMethod} in ('AUTO_CODE','MANUAL','SUPPLIER_API')`),
    check("variants_status", sql`${t.status} in ('DRAFT','PUBLISHED','ARCHIVED')`),
    check("variants_availability", sql`${t.availability} in ('AVAILABLE','TEMPORARILY_UNAVAILABLE')`),
    check("variants_face_pair", sql`(${t.faceValue} is null) = (${t.faceCurrency} is null)`),
    check("variants_face_positive", sql`${t.faceValue} is null or ${t.faceValue} > 0`),
    check("variants_duration", sql`${t.durationDays} is null or ${t.durationDays} between 1 and 3660`),
    check("variants_sale_lower", sql`${t.salePrice} is null or (${t.salePrice} > 0 and ${t.salePrice} < ${t.price})`),
    check("variants_sale_window", sql`${t.saleEndsAt} is null or ${t.saleStartsAt} is null or ${t.saleEndsAt} > ${t.saleStartsAt}`),
    check("variants_sale_window_needs_price", sql`${t.salePrice} is not null or (${t.saleStartsAt} is null and ${t.saleEndsAt} is null)`),
    check("variants_attrs_object", sql`jsonb_typeof(${t.attrs}) = 'object' and pg_column_size(${t.attrs}) <= 8192`),
    index("product_variants_published_idx").on(t.productId).where(sql`${t.status} = 'PUBLISHED'`),
  ],
);

/**
 * P1-B (B2): typed, PUBLIC descriptive attributes of a game-account variant. There is deliberately no column that can hold a
 * credential: login data lives only in inventory (sealed) or in the manual-fulfilment secret path.
 */
export const gameAccountAttributes = pgTable(
  "game_account_attributes",
  {
    variantId: uuid("variant_id").primaryKey().references(() => productVariants.id),
    accountType: text("account_type").notNull(),
    level: integer("level"),
    includedItems: jsonb("included_items").notNull().default(sql`'[]'::jsonb`),
    features: jsonb("features").notNull().default(sql`'[]'::jsonb`),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    check("game_account_attributes_type", sql`${t.accountType} ~ '^[A-Z][A-Z0-9_]{1,29}$'`),
    check("game_account_attributes_level", sql`${t.level} is null or ${t.level} between 0 and 100000`),
    check("game_account_attributes_lists", sql`jsonb_typeof(${t.includedItems}) = 'array' and jsonb_typeof(${t.features}) = 'array' and jsonb_array_length(${t.includedItems}) <= 50 and jsonb_array_length(${t.features}) <= 30 and pg_column_size(${t.includedItems}) <= 8192 and pg_column_size(${t.features}) <= 4096`),
  ],
);

/**
 * P1-B (C-2): every change of a variant's fulfilment method is recorded here BEFORE the variant row changes (same transaction).
 * The variants trigger refuses a method change that has no matching row of this transaction, so no code path can bypass it.
 */
export const variantFulfillmentChanges = pgTable(
  "variant_fulfillment_changes",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    variantId: uuid("variant_id").notNull().references(() => productVariants.id),
    fromMethod: text("from_method").notNull(),
    toMethod: text("to_method").notNull(),
    reason: text("reason").notNull(),
    actorId: text("actor_id").notNull(),
    /** Usage facts read under the variant lock when the change was approved. */
    usage: jsonb("usage").notNull(),
    txid: bigint("txid", { mode: "number" }).notNull().default(sql`txid_current()`),
    changedAt: ts("changed_at").notNull(),
  },
  (t) => [
    check("variant_fulfillment_changes_methods", sql`${t.fromMethod} in ('AUTO_CODE','MANUAL','SUPPLIER_API') and ${t.toMethod} in ('AUTO_CODE','MANUAL','SUPPLIER_API') and ${t.fromMethod} <> ${t.toMethod}`),
    check("variant_fulfillment_changes_reason", sql`char_length(btrim(${t.reason})) >= 10`),
    index("variant_fulfillment_changes_variant_idx").on(t.variantId, t.id),
  ],
);

export const variantPriceHistory = pgTable(
  "variant_price_history",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    variantId: uuid("variant_id").notNull().references(() => productVariants.id),
    price: rialPrice("price").notNull(),
    salePrice: rialPrice("sale_price"),
    saleStartsAt: ts("sale_starts_at"),
    saleEndsAt: ts("sale_ends_at"),
    changedBy: text("changed_by"),
    reason: text("reason"),
    changedAt: ts("changed_at").notNull(),
  },
  (t) => [index("variant_price_history_variant_idx").on(t.variantId, t.id.desc())],
);

export const productStatusHistory = pgTable("product_status_history", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  entityId: uuid("entity_id").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  actorId: text("actor_id"),
  reason: text("reason"),
  occurredAt: ts("occurred_at").notNull(),
});

export const variantStatusHistory = pgTable("variant_status_history", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  entityId: uuid("entity_id").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  actorId: text("actor_id"),
  reason: text("reason"),
  occurredAt: ts("occurred_at").notNull(),
});

