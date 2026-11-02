import { sql } from "drizzle-orm";
import { bigint, boolean, check, customType, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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

// ------------------------------------------------------------------ refunds and reconciliation (2b-9)

/** Refund policy is DATA and versioned. 'temporary-0' holds the documented SAFE PLACEHOLDERS (B12: legal review pending); changing it is a migration. */
export const refundPolicyVersions = pgTable(
  "refund_policy_versions",
  {
    version: text("version").primaryKey(),
    status: text("status").notNull(),
    legalReviewRequired: boolean("legal_review_required").notNull(),
    active: boolean("active").notNull().default(false),
    description: text("description").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [check("refund_policy_versions_status", sql`${t.status} in ('TEMPORARY','FINAL')`), uniqueIndex("refund_policy_active_uq").on(t.active).where(sql`${t.active}`)],
);

export const refundPolicyRules = pgTable(
  "refund_policy_rules",
  {
    version: text("version").notNull().references(() => refundPolicyVersions.version),
    disclosureState: text("disclosure_state").notNull(),
    decision: text("decision").notNull(),
  },
  (t) => [
    uniqueIndex("refund_policy_rules_uq").on(t.version, t.disclosureState),
    check("refund_policy_rules_state", sql`${t.disclosureState} in ('NOT_DELIVERED','DELIVERED_UNREVEALED','REVEALED_BY_CUSTOMER','REVEALED_BY_ADMIN_ONLY')`),
    check("refund_policy_rules_decision", sql`${t.decision} in ('ELIGIBLE','REVIEW_REQUIRED','OVERRIDE_REQUIRED','DENIED')`),
  ],
);

export const refunds = pgTable(
  "refunds",
  {
    id: uuid("id").primaryKey(),
    orderId: uuid("order_id").notNull().references(() => orders.id),
    holdId: uuid("hold_id").references(() => orderHolds.id),
    source: text("source").notNull(),
    /** For SUSPENSE_RECEIPT refunds: the idempotency key of the parked ledger posting (`late:<payment>` / `payrecv:<payment>`). */
    suspenseKey: text("suspense_key"),
    paymentId: uuid("payment_id"),
    requestedBy: text("requested_by").notNull(),
    requesterType: text("requester_type").notNull(),
    reasonCode: text("reason_code").notNull(),
    amount: rialAmount("amount").notNull(),
    destination: text("destination").notNull(),
    status: text("status").notNull().default("REQUESTED"),
    policyVersion: text("policy_version").notNull().references(() => refundPolicyVersions.version),
    eligibilitySnapshot: jsonb("eligibility_snapshot").notNull(),
    decision: text("decision").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: ts("decided_at"),
    decisionNote: text("decision_note"),
    overrideReason: text("override_reason"),
    externalOutcome: text("external_outcome").notNull().default("NONE"),
    gatewayRefundRef: text("gateway_refund_ref"),
    attempts: integer("attempts").notNull().default(0),
    ledgerTxnId: bigint("ledger_txn_id", { mode: "number" }),
    requestHash: bytea("request_hash").notNull(),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
    completedAt: ts("completed_at"),
  },
  (t) => [
    // At most ONE live refund per order (full-order refunds only): a duplicate request cannot create a second one.
    uniqueIndex("refunds_one_per_order_uq").on(t.orderId).where(sql`${t.status} <> 'REJECTED'`),
    check("refunds_status", sql`${t.status} in ('REQUESTED','APPROVED','REJECTED','PROCESSING','COMPLETED','FAILED')`),
    check("refunds_source", sql`(${t.source} = 'ORDER_PAYMENT' and ${t.suspenseKey} is null) or (${t.source} = 'SUSPENSE_RECEIPT' and ${t.suspenseKey} is not null and ${t.holdId} is not null)`),
    check("refunds_destination", sql`${t.destination} in ('WALLET','GATEWAY')`),
    check("refunds_requester", sql`${t.requesterType} in ('CUSTOMER','ADMIN')`),
    check("refunds_decision", sql`${t.decision} in ('ELIGIBLE','REVIEW_REQUIRED','OVERRIDE_REQUIRED','DENIED')`),
    check("refunds_outcome", sql`${t.externalOutcome} in ('NONE','ACCEPTED','UNKNOWN','CONFIRMED','REJECTED')`),
    check("refunds_amount", sql`${t.amount} > 0`),
    check("refunds_gateway_needs_payment", sql`${t.destination} <> 'GATEWAY' or ${t.paymentId} is not null`),
    check("refunds_decided", sql`${t.status} in ('REQUESTED') or (${t.decidedBy} is not null and ${t.decidedAt} is not null and char_length(btrim(coalesce(${t.decisionNote}, ''))) >= 5)`),
    check("refunds_four_eyes", sql`${t.requesterType} <> 'ADMIN' or ${t.decidedBy} is null or ${t.decidedBy} <> ${t.requestedBy}`),
    check("refunds_denied_not_approved", sql`${t.decision} <> 'DENIED' or ${t.status} in ('REQUESTED','REJECTED')`),
    check("refunds_override", sql`${t.decision} <> 'OVERRIDE_REQUIRED' or ${t.status} in ('REQUESTED','REJECTED') or char_length(btrim(coalesce(${t.overrideReason}, ''))) >= 10`),
    check("refunds_completed", sql`${t.status} <> 'COMPLETED' or (${t.ledgerTxnId} is not null and ${t.completedAt} is not null and (${t.destination} <> 'GATEWAY' or ${t.externalOutcome} = 'CONFIRMED'))`),
    index("refunds_open_idx").on(t.createdAt).where(sql`${t.status} in ('REQUESTED','APPROVED','PROCESSING','FAILED')`),
  ],
);

export const refundItems = pgTable(
  "refund_items",
  {
    id: uuid("id").primaryKey(),
    refundId: uuid("refund_id").notNull().references(() => refunds.id),
    orderItemId: uuid("order_item_id").notNull().references(() => orderItems.id),
    amount: rialAmount("amount").notNull(),
    disclosureState: text("disclosure_state").notNull(),
  },
  (t) => [uniqueIndex("refund_items_uq").on(t.refundId, t.orderItemId), check("refund_items_state", sql`${t.disclosureState} in ('NOT_DELIVERED','DELIVERED_UNREVEALED','REVEALED_BY_CUSTOMER','REVEALED_BY_ADMIN_ONLY')`)],
);

export const refundStatusHistory = pgTable("refund_status_history", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  entityId: uuid("entity_id").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  actorId: text("actor_id"),
  reason: text("reason"),
  occurredAt: ts("occurred_at").notNull(),
});

export const reconciliationRuns = pgTable("reconciliation_runs", {
  id: uuid("id").primaryKey(),
  startedBy: text("started_by").notNull(),
  startedAt: ts("started_at").notNull(),
  finishedAt: ts("finished_at"),
  jobs: text("jobs").notNull(),
  findingCount: integer("finding_count").notNull().default(0),
});

export const reconciliationFindings = pgTable(
  "reconciliation_findings",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    runId: uuid("run_id").notNull().references(() => reconciliationRuns.id),
    job: text("job").notNull(),
    severity: text("severity").notNull(),
    subject: text("subject").notNull(),
    detail: text("detail").notNull(),
    foundAt: ts("found_at").notNull(),
  },
  (t) => [check("reconciliation_findings_severity", sql`${t.severity} in ('INFO','WARN','CRITICAL')`), index("reconciliation_findings_run_idx").on(t.runId, t.id)],
);
