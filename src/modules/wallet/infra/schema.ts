import { sql } from "drizzle-orm";
import { bigint, check, integer, customType, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Wallet tables — private to the wallet module. The BALANCE is never stored here: it is the ledger's
 * CUSTOMER_WALLET account (the ledger is the only financial truth). payment_id / ledger_txn_id FKs are created in SQL (P-1).
 */
const rialAmount = customType<{ data: number; driverData: string }>({
  dataType: () => "rial_amount",
  toDriver: (v) => String(v),
  fromDriver: (v) => Number(v),
});
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
const ts = (n: string) => timestamp(n, { withTimezone: true });

export const walletTopups = pgTable(
  "wallet_topups",
  {
    id: uuid("id").primaryKey(),
    userRef: text("user_ref").notNull(),
    amount: rialAmount("amount").notNull(),
    status: text("status").notNull().default("REQUESTED"),
    paymentId: uuid("payment_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: bytea("request_hash").notNull(),
    ledgerTxnId: bigint("ledger_txn_id", { mode: "number" }),
    /** P1-A: the wallet_limit_versions.approved_seq this top-up was validated against (NULL only for top-ups that predate P1-A). Immutable. */
    limitsVersion: integer("limits_version"),
    createdAt: ts("created_at").notNull(),
    completedAt: ts("completed_at"),
  },
  (t) => [
    check("wallet_topups_status", sql`${t.status} in ('REQUESTED','COMPLETED','FAILED')`),
    check("wallet_topups_amount", sql`${t.amount} > 0 and ${t.amount} % 10 = 0`),
    check("wallet_topups_completed", sql`${t.status} <> 'COMPLETED' or (${t.ledgerTxnId} is not null and ${t.completedAt} is not null and ${t.paymentId} is not null)`),
    uniqueIndex("wallet_topups_idempotency_uq").on(t.idempotencyKey),
    uniqueIndex("wallet_topups_payment_uq").on(t.paymentId).where(sql`${t.paymentId} is not null`),
    index("wallet_topups_user_idx").on(t.userRef, t.createdAt.desc()),
  ],
);

/** Administrative wallet adjustments ALWAYS need two different admins (B10 thresholds are open, so no exemption exists). */
export const walletAdjustments = pgTable(
  "wallet_adjustments",
  {
    id: uuid("id").primaryKey(),
    userRef: text("user_ref").notNull(),
    direction: text("direction").notNull(),
    amount: rialAmount("amount").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("REQUESTED"),
    requestedBy: text("requested_by").notNull(),
    decidedBy: text("decided_by"),
    decisionReason: text("decision_reason"),
    ledgerTxnId: bigint("ledger_txn_id", { mode: "number" }),
    createdAt: ts("created_at").notNull(),
    decidedAt: ts("decided_at"),
  },
  (t) => [
    check("wallet_adjustments_direction", sql`${t.direction} in ('CREDIT','DEBIT')`),
    check("wallet_adjustments_status", sql`${t.status} in ('REQUESTED','COMPLETED','REJECTED')`),
    check("wallet_adjustments_amount", sql`${t.amount} > 0`),
    check("wallet_adjustments_reason", sql`char_length(btrim(${t.reason})) >= 10`),
    check("wallet_adjustments_four_eyes", sql`${t.decidedBy} is null or ${t.decidedBy} <> ${t.requestedBy}`),
    check("wallet_adjustments_decided", sql`${t.status} = 'REQUESTED' or (${t.decidedBy} is not null and ${t.decidedAt} is not null and char_length(btrim(coalesce(${t.decisionReason}, ''))) >= 5)`),
    check("wallet_adjustments_completed", sql`${t.status} <> 'COMPLETED' or ${t.ledgerTxnId} is not null`),
    index("wallet_adjustments_user_idx").on(t.userRef, t.createdAt.desc()),
    index("wallet_adjustments_open_idx").on(t.createdAt).where(sql`${t.status} = 'REQUESTED'`),
  ],
);

// ------------------------------------------------------------------ settings (ADM-1 / B5, P1-A)

/**
 * Top-up limits (B5), module-owned and versioned. FINANCIAL setting => TWO-PERSON: a change is REQUESTED by one administrator and
 * APPROVED/REJECTED by a different one (CHECK, cannot be configured away). The active limits are the APPROVED row with the highest
 * approved_seq; REQUESTED rows have no effect. Values are integer Rial (never floats). min <= max per top-up <= daily maximum.
 * Version 1 is the owner-approved initial value (1,000,000 / 100,000,000 / 300,000,000 IRR). The daily window is the Asia/Tehran
 * calendar day (decision of 2026-11-02) and is NOT a setting.
 */
export const walletLimitVersions = pgTable(
  "wallet_limit_versions",
  {
    id: uuid("id").primaryKey(),
    minRial: rialAmount("min_rial").notNull(),
    maxRial: rialAmount("max_rial").notNull(),
    dailyMaxRial: rialAmount("daily_max_rial").notNull(),
    source: text("source").notNull(),
    status: text("status").notNull(),
    /** approved_seq of the active version when this change was requested (NULL for the seed). A stale request cannot be approved. */
    baseSeq: integer("base_seq"),
    approvedSeq: integer("approved_seq"),
    requestedBy: text("requested_by").notNull(),
    reason: text("reason").notNull(),
    decidedBy: text("decided_by"),
    decisionReason: text("decision_reason"),
    createdAt: ts("created_at").notNull(),
    decidedAt: ts("decided_at"),
  },
  (t) => [
    uniqueIndex("wallet_limit_approved_seq_uq").on(t.approvedSeq).where(sql`${t.approvedSeq} is not null`),
    check("wallet_limit_status", sql`${t.status} in ('REQUESTED','APPROVED','REJECTED')`),
    check("wallet_limit_source", sql`${t.source} in ('SEED','ADMIN')`),
    check("wallet_limit_bounds", sql`${t.minRial} >= 10 and ${t.minRial} % 10 = 0 and ${t.maxRial} % 10 = 0 and ${t.dailyMaxRial} % 10 = 0 and ${t.maxRial} <= 1000000000000 and ${t.dailyMaxRial} <= 10000000000000`),
    check("wallet_limit_order", sql`${t.minRial} <= ${t.maxRial} and ${t.maxRial} <= ${t.dailyMaxRial}`),
    check("wallet_limit_reason", sql`char_length(btrim(${t.reason})) >= 10`),
    // Two-person invariant: whoever decides is never the requester, and a decided row is fully described.
    check(
      "wallet_limit_decision",
      sql`(${t.status} = 'REQUESTED' and ${t.decidedBy} is null and ${t.decidedAt} is null and ${t.approvedSeq} is null)
        or (${t.status} = 'APPROVED' and ${t.decidedBy} is not null and ${t.decidedAt} is not null and ${t.approvedSeq} is not null and ${t.decidedBy} <> ${t.requestedBy} and char_length(btrim(coalesce(${t.decisionReason}, ''))) >= 5)
        or (${t.status} = 'REJECTED' and ${t.decidedBy} is not null and ${t.decidedAt} is not null and ${t.approvedSeq} is null and ${t.decidedBy} <> ${t.requestedBy} and char_length(btrim(coalesce(${t.decisionReason}, ''))) >= 5)`,
    ),
    index("wallet_limit_open_idx").on(t.createdAt).where(sql`${t.status} = 'REQUESTED'`),
  ],
);
