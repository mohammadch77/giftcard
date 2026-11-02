import { sql } from "drizzle-orm";
import { bigint, check, customType, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Inventory tables — private to the inventory module. variant_id / order refs are opaque ids whose FKs to other
 * modules are not created (P-1; order refs get theirs in 2b-8). Secrets exist ONLY as AES-256-GCM envelopes
 * (`sealed`) and keyed fingerprints; nothing here is ever deleted (P-7).
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
const ts = (n: string) => timestamp(n, { withTimezone: true });

export const inventoryBatches = pgTable(
  "inventory_batches",
  {
    id: uuid("id").primaryKey(),
    variantId: uuid("variant_id").notNull(),
    codeCount: integer("code_count").notNull(),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [check("inventory_batches_counts", sql`${t.codeCount} >= 0 and ${t.duplicateCount} >= 0`), index("inventory_batches_variant_idx").on(t.variantId)],
);

export const inventoryReservations = pgTable(
  "inventory_reservations",
  {
    id: uuid("id").primaryKey(),
    /** Caller-supplied idempotency key (e.g. `checkout:<orderId>`): at most ONE reservation per key. */
    reservationKey: text("reservation_key").notNull(),
    orderRef: text("order_ref").notNull(),
    requestHash: bytea("request_hash").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    createdAt: ts("created_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
    consumedAt: ts("consumed_at"),
    closedAt: ts("closed_at"),
  },
  (t) => [
    uniqueIndex("inventory_reservations_key_uq").on(t.reservationKey),
    check("inventory_reservations_status", sql`${t.status} in ('ACTIVE','CONSUMED','RELEASED','EXPIRED')`),
    check("inventory_reservations_key_len", sql`char_length(${t.reservationKey}) between 1 and 200 and char_length(${t.orderRef}) between 1 and 200`),
    check("inventory_reservations_ttl", sql`${t.expiresAt} > ${t.createdAt}`),
    // A reservation can only be consumed strictly BEFORE it expires (D9: no extension, no late consumption).
    check("inventory_reservations_consumed_in_time", sql`${t.status} <> 'CONSUMED' or (${t.consumedAt} is not null and ${t.consumedAt} < ${t.expiresAt})`),
    check("inventory_reservations_closed", sql`(${t.status} in ('RELEASED','EXPIRED')) = (${t.closedAt} is not null)`),
    index("inventory_reservations_expiry_idx").on(t.expiresAt).where(sql`${t.status} = 'ACTIVE'`),
    index("inventory_reservations_order_idx").on(t.orderRef),
  ],
);

export const inventoryReservationLines = pgTable(
  "inventory_reservation_lines",
  {
    id: uuid("id").primaryKey(),
    reservationId: uuid("reservation_id").notNull().references(() => inventoryReservations.id),
    variantId: uuid("variant_id").notNull(),
    kind: text("kind").notNull(),
    quantity: integer("quantity").notNull(),
    soldAt: ts("sold_at"),
  },
  (t) => [
    uniqueIndex("inventory_reservation_lines_uq").on(t.reservationId, t.variantId),
    check("inventory_reservation_lines_kind", sql`${t.kind} in ('ITEMISED','COUNTED')`),
    check("inventory_reservation_lines_qty", sql`${t.quantity} between 1 and 1000`),
    index("inventory_reservation_lines_variant_idx").on(t.variantId),
  ],
);

export const digitalCodes = pgTable(
  "digital_codes",
  {
    id: uuid("id").primaryKey(),
    variantId: uuid("variant_id").notNull(),
    batchId: uuid("batch_id").notNull().references(() => inventoryBatches.id),
    /** HMAC(pepper vN, purpose|normalised code): duplicate detection without anything reversible. */
    codeFp: bytea("code_fp").notNull(),
    hmacVersion: integer("hmac_version").notNull(),
    /** encodeSealed(envelope), AAD = (digital_codes, id, kind). */
    sealed: bytea("sealed").notNull(),
    payloadKind: text("payload_kind").notNull(),
    status: text("status").notNull().default("AVAILABLE"),
    reservationId: uuid("reservation_id").references(() => inventoryReservations.id),
    reservedUntil: ts("reserved_until"),
    /** Opaque per-unit reference of the order item the code was sold to (FK added in 2b-8). */
    orderItemRef: text("order_item_ref"),
    soldAt: ts("sold_at"),
    publicAttrs: jsonb("public_attrs").notNull().default(sql`'{}'::jsonb`),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    check("digital_codes_status", sql`${t.status} in ('AVAILABLE','RESERVED','SOLD','VOID','QUARANTINED')`),
    check("digital_codes_payload_kind", sql`${t.payloadKind} in ('CODE','ACCOUNT')`),
    check("digital_codes_fp_len", sql`octet_length(${t.codeFp}) = 32`),
    check(
      "digital_codes_status_links",
      sql`(${t.status} = 'AVAILABLE' and ${t.reservationId} is null and ${t.orderItemRef} is null and ${t.reservedUntil} is null)
       or (${t.status} = 'RESERVED' and ${t.reservationId} is not null and ${t.orderItemRef} is null and ${t.reservedUntil} is not null)
       or (${t.status} = 'SOLD' and ${t.orderItemRef} is not null and ${t.soldAt} is not null)
       or (${t.status} in ('VOID','QUARANTINED'))`,
    ),
    check("digital_codes_attrs", sql`jsonb_typeof(${t.publicAttrs}) = 'object' and pg_column_size(${t.publicAttrs}) <= 2048`),
    uniqueIndex("digital_codes_fp_uq").on(t.hmacVersion, t.codeFp),
    // A code can belong to at most ONE order item, whatever the application does.
    uniqueIndex("digital_codes_order_item_uq").on(t.orderItemRef).where(sql`${t.orderItemRef} is not null`),
    index("digital_codes_available_idx").on(t.variantId, t.id).where(sql`${t.status} = 'AVAILABLE'`),
    index("digital_codes_reservation_idx").on(t.reservationId).where(sql`${t.status} = 'RESERVED'`),
    index("digital_codes_batch_idx").on(t.batchId),
  ],
);

export const stockCounters = pgTable(
  "stock_counters",
  {
    variantId: uuid("variant_id").primaryKey(),
    available: integer("available").notNull().default(0),
    reserved: integer("reserved").notNull().default(0),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [check("stock_counters_non_negative", sql`${t.available} >= 0 and ${t.reserved} >= 0`)],
);

export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    variantId: uuid("variant_id").notNull(),
    codeId: uuid("code_id"),
    reservationId: uuid("reservation_id"),
    type: text("type").notNull(),
    /** Change of the AVAILABLE quantity. */
    qtyDelta: integer("qty_delta").notNull(),
    orderItemRef: text("order_item_ref"),
    reason: text("reason"),
    actor: text("actor").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check("inventory_movements_type", sql`${t.type} in ('IMPORT','RESERVE','RELEASE','EXPIRE','SELL','VOID','QUARANTINE','UNQUARANTINE','ADJUST')`),
    index("inventory_movements_variant_idx").on(t.variantId, t.id),
    index("inventory_movements_reservation_idx").on(t.reservationId),
  ],
);

/** Every disclosure of a code's plaintext is logged BEFORE the secret is opened. */
export const codeAccessLog = pgTable(
  "code_access_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    codeId: uuid("code_id").notNull(),
    orderItemRef: text("order_item_ref").notNull(),
    requestedBy: text("requested_by").notNull(),
    purpose: text("purpose").notNull(),
    accessedAt: ts("accessed_at").notNull(),
  },
  (t) => [index("code_access_log_code_idx").on(t.codeId)],
);
