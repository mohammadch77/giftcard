import { sql } from "drizzle-orm";
import { bigint, check, customType, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Orders tables — private to the orders module. All money is integer Rial (PG domain rial_amount). Order items are IMMUTABLE
 * snapshots (no UPDATE grant, forbid-change trigger). Cross-module FKs (reservation, payment, ledger transaction) are created in SQL (P-1).
 * The fulfilment/delivery payment gate (triggers on fulfillment_tasks / deliveries) lives in migration 0021.
 */
const rialAmount = customType<{ data: number; driverData: string }>({ dataType: () => "rial_amount", toDriver: (v) => String(v), fromDriver: (v) => Number(v) });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
const ts = (n: string) => timestamp(n, { withTimezone: true });

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey(),
    number: text("number").notNull(),
    userRef: text("user_ref").notNull(),
    status: text("status").notNull().default("PENDING_PAYMENT"),
    paymentStatus: text("payment_status").notNull().default("PENDING"),
    paymentMethod: text("payment_method").notNull(),
    currency: text("currency").notNull().default("IRR"),
    total: rialAmount("total").notNull(),
    pricingVersion: text("pricing_version").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: bytea("request_hash").notNull(),
    reservationId: uuid("reservation_id"),
    paymentId: uuid("payment_id"),
    settlementLedgerTxnId: bigint("settlement_ledger_txn_id", { mode: "number" }),
    expiresAt: ts("expires_at").notNull(),
    paidAt: ts("paid_at"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("orders_number_uq").on(t.number),
    uniqueIndex("orders_idempotency_uq").on(t.userRef, t.idempotencyKey),
    check("orders_status", sql`${t.status} in ('PENDING_PAYMENT','PAID','FULFILLING','PARTIALLY_COMPLETED','COMPLETED','ON_HOLD','CANCELLED','EXPIRED')`),
    check("orders_payment_status", sql`${t.paymentStatus} in ('PENDING','SUCCEEDED','FAILED')`),
    check("orders_payment_method", sql`${t.paymentMethod} in ('WALLET','GATEWAY')`),
    check("orders_currency", sql`${t.currency} = 'IRR'`),
    check("orders_total_positive", sql`${t.total} > 0`),
    // D6: no split payment. A gateway order has a payment row; a wallet order never does.
    check("orders_method_payment", sql`(${t.paymentMethod} = 'GATEWAY') or ${t.paymentId} is null`),
    // An order that is paid / being fulfilled / done has verified payment and a payment time.
    check("orders_paid_consistent", sql`${t.status} not in ('PAID','FULFILLING','PARTIALLY_COMPLETED','COMPLETED') or (${t.paymentStatus} = 'SUCCEEDED' and ${t.paidAt} is not null)`),
    check("orders_pending_unpaid", sql`${t.status} <> 'PENDING_PAYMENT' or ${t.paymentStatus} = 'PENDING'`),
    index("orders_user_idx").on(t.userRef, t.createdAt.desc()),
    index("orders_expiry_idx").on(t.expiresAt).where(sql`${t.status} = 'PENDING_PAYMENT'`),
    index("orders_payment_idx").on(t.paymentId).where(sql`${t.paymentId} is not null`),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey(),
    orderId: uuid("order_id").notNull().references(() => orders.id),
    lineNo: integer("line_no").notNull(),
    variantId: uuid("variant_id").notNull(),
    quantity: integer("quantity").notNull(),
    unitPrice: rialAmount("unit_price").notNull(),
    lineTotal: rialAmount("line_total").notNull(),
    /** Everything the customer saw (names, brand, sku, attrs, fulfilment method). Never rewritten. */
    snapshot: jsonb("snapshot").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("order_items_line_uq").on(t.orderId, t.lineNo),
    uniqueIndex("order_items_variant_uq").on(t.orderId, t.variantId),
    check("order_items_qty", sql`${t.quantity} between 1 and 100`),
    check("order_items_line_total", sql`${t.lineTotal} = ${t.unitPrice} * ${t.quantity}`),
    index("order_items_order_idx").on(t.orderId),
  ],
);

export const orderStatusHistory = pgTable("order_status_history", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  entityId: uuid("entity_id").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  actorId: text("actor_id"),
  reason: text("reason"),
  occurredAt: ts("occurred_at").notNull(),
});

export const orderHolds = pgTable(
  "order_holds",
  {
    id: uuid("id").primaryKey(),
    orderId: uuid("order_id").notNull().references(() => orders.id),
    reason: text("reason").notNull(),
    openedAt: ts("opened_at").notNull(),
    openedBy: text("opened_by").notNull(),
    resolvedAt: ts("resolved_at"),
    resolvedBy: text("resolved_by"),
    resolution: text("resolution"),
    note: text("note"),
  },
  (t) => [
    check("order_holds_reason", sql`${t.reason} in ('LATE_PAYMENT_NO_RESERVATION','PAYMENT_NEEDS_REVIEW','FRAUD_REVIEW','FULFILLMENT_FAILED','SUPPLIER_UNKNOWN')`),
    check("order_holds_resolution", sql`${t.resolution} is null or ${t.resolution} in ('RE_RESERVED','RESUMED','REFUND_WALLET','REFUND_GATEWAY','SUBSTITUTED','CANCELLED')`),
    check("order_holds_resolved_complete", sql`(${t.resolvedAt} is null) = (${t.resolution} is null) and (${t.resolvedAt} is null) = (${t.resolvedBy} is null)`),
    check("order_holds_note", sql`${t.resolvedAt} is null or char_length(btrim(coalesce(${t.note}, ''))) >= 10`),
    uniqueIndex("order_holds_open_uq").on(t.orderId, t.reason).where(sql`${t.resolvedAt} is null`),
    index("order_holds_open_idx").on(t.openedAt).where(sql`${t.resolvedAt} is null`),
  ],
);
