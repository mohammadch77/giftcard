import { sql } from "drizzle-orm";
import { bigint, boolean, check, customType, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Suppliers tables — private to the suppliers module. variant_id / order_item_ref are opaque ids (cross-module FKs in SQL, P-1).
 * Credentials and supplier-returned codes exist ONLY as AES-256-GCM envelopes. Nothing is ever deleted (P-7).
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
const rialAmount = customType<{ data: number; driverData: string }>({ dataType: () => "rial_amount", toDriver: (v) => String(v), fromDriver: (v) => Number(v) });
const ts = (n: string) => timestamp(n, { withTimezone: true });

export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    adapterKey: text("adapter_key").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    /** NON-secret, flat, bounded. Never hosts/URLs (those come from deployment configuration) and never secrets. */
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("suppliers_key_uq").on(t.key),
    check("suppliers_key_format", sql`${t.key} ~ '^[a-z][a-z0-9_-]{1,39}$'`),
    check("suppliers_adapter_format", sql`${t.adapterKey} ~ '^[a-z][a-z0-9_-]{0,39}$'`),
    check("suppliers_name_len", sql`char_length(btrim(${t.name})) between 1 and 120`),
    check("suppliers_status", sql`${t.status} in ('ACTIVE','DISABLED')`),
    check("suppliers_config", sql`jsonb_typeof(${t.config}) = 'object' and pg_column_size(${t.config}) <= 4096`),
  ],
);

export const supplierCredentials = pgTable(
  "supplier_credentials",
  {
    id: uuid("id").primaryKey(),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id),
    /** encodeSealed(envelope), AAD = (supplier_credentials, id, supplier_credential). */
    sealed: bytea("sealed").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    createdAt: ts("created_at").notNull(),
    replacedAt: ts("replaced_at"),
  },
  (t) => [
    check("supplier_credentials_status", sql`${t.status} in ('ACTIVE','REPLACED')`),
    uniqueIndex("supplier_credentials_active_uq").on(t.supplierId).where(sql`${t.status} = 'ACTIVE'`),
  ],
);

export const supplierProducts = pgTable(
  "supplier_products",
  {
    id: uuid("id").primaryKey(),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id),
    externalSku: text("external_sku").notNull(),
    name: text("name").notNull(),
    /** Supplier cost as a FACT in integer Rial. It never changes a catalog price (no pricing/COGS policy exists, D10). */
    cost: rialAmount("cost").notNull(),
    available: boolean("available").notNull(),
    stockHint: integer("stock_hint"),
    rawHash: bytea("raw_hash").notNull(),
    lastSyncedAt: ts("last_synced_at").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("supplier_products_sku_uq").on(t.supplierId, t.externalSku),
    check("supplier_products_sku_format", sql`${t.externalSku} ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$'`),
    check("supplier_products_stock", sql`${t.stockHint} is null or ${t.stockHint} >= 0`),
  ],
);

export const supplierSyncRuns = pgTable(
  "supplier_sync_runs",
  {
    id: uuid("id").primaryKey(),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id),
    status: text("status").notNull().default("RUNNING"),
    fetched: integer("fetched").notNull().default(0),
    created: integer("created").notNull().default(0),
    updated: integer("updated").notNull().default(0),
    rejected: integer("rejected").notNull().default(0),
    errorKind: text("error_kind"),
    startedBy: text("started_by").notNull(),
    startedAt: ts("started_at").notNull(),
    finishedAt: ts("finished_at"),
  },
  (t) => [check("supplier_sync_runs_status", sql`${t.status} in ('RUNNING','SUCCEEDED','FAILED')`), index("supplier_sync_runs_supplier_idx").on(t.supplierId, t.startedAt.desc())],
);

export const supplierProductChanges = pgTable(
  "supplier_product_changes",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    supplierProductId: uuid("supplier_product_id").notNull().references(() => supplierProducts.id),
    runId: uuid("run_id").notNull().references(() => supplierSyncRuns.id),
    oldCost: rialAmount("old_cost"),
    newCost: rialAmount("new_cost").notNull(),
    oldAvailable: boolean("old_available"),
    newAvailable: boolean("new_available").notNull(),
    changedAt: ts("changed_at").notNull(),
  },
  (t) => [index("supplier_product_changes_product_idx").on(t.supplierProductId, t.id)],
);

export const variantSupplierRoutes = pgTable(
  "variant_supplier_routes",
  {
    id: uuid("id").primaryKey(),
    variantId: uuid("variant_id").notNull(),
    supplierProductId: uuid("supplier_product_id").notNull().references(() => supplierProducts.id),
    priority: integer("priority").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    check("variant_supplier_routes_priority", sql`${t.priority} between 1 and 20`),
    uniqueIndex("variant_supplier_routes_product_uq").on(t.variantId, t.supplierProductId),
    uniqueIndex("variant_supplier_routes_priority_uq").on(t.variantId, t.priority).where(sql`${t.active}`),
    index("variant_supplier_routes_lookup_idx").on(t.variantId, t.priority).where(sql`${t.active}`),
  ],
);

export const supplierOrders = pgTable(
  "supplier_orders",
  {
    id: uuid("id").primaryKey(),
    supplierId: uuid("supplier_id").notNull().references(() => suppliers.id),
    supplierProductId: uuid("supplier_product_id").notNull().references(() => supplierProducts.id),
    /** Opaque per-unit reference of the order item being fulfilled. */
    orderItemRef: text("order_item_ref").notNull(),
    quantity: integer("quantity").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: bytea("request_hash").notNull(),
    status: text("status").notNull().default("CREATED"),
    externalRef: text("external_ref"),
    rejectReason: text("reject_reason"),
    attempts: integer("attempts").notNull().default(0),
    submittingSince: ts("submitting_since"),
    note: text("note"),
    requestRedacted: jsonb("request_redacted"),
    responseRedacted: jsonb("response_redacted"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("supplier_orders_idempotency_uq").on(t.supplierId, t.idempotencyKey),
    check("supplier_orders_status", sql`${t.status} in ('CREATED','SUBMITTING','CONFIRMED','REJECTED','UNKNOWN')`),
    check("supplier_orders_quantity", sql`${t.quantity} between 1 and 100`),
    check("supplier_orders_key_len", sql`char_length(${t.idempotencyKey}) between 1 and 200`),
    // CONFIRMED always carries the supplier's reference unless an admin resolved it manually (then a note is mandatory).
    check("supplier_orders_confirmed", sql`${t.status} <> 'CONFIRMED' or ${t.externalRef} is not null or char_length(btrim(coalesce(${t.note}, ''))) >= 5`),
    index("supplier_orders_item_idx").on(t.orderItemRef),
    index("supplier_orders_open_idx").on(t.status, t.updatedAt).where(sql`${t.status} in ('SUBMITTING','UNKNOWN')`),
  ],
);

/** Supplier-returned codes/accounts, sealed. Written atomically with CONFIRMED. */
export const supplierOrderSecrets = pgTable(
  "supplier_order_secrets",
  {
    id: uuid("id").primaryKey(),
    supplierOrderId: uuid("supplier_order_id").notNull().references(() => supplierOrders.id),
    position: integer("position").notNull(),
    sealed: bytea("sealed").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [uniqueIndex("supplier_order_secrets_pos_uq").on(t.supplierOrderId, t.position)],
);

export const supplierOrderEvents = pgTable(
  "supplier_order_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    supplierOrderId: uuid("supplier_order_id").notNull().references(() => supplierOrders.id),
    type: text("type").notNull(),
    detail: jsonb("detail"),
    actor: text("actor").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("supplier_order_events_order_idx").on(t.supplierOrderId, t.id)],
);
