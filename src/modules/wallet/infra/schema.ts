import { sql } from "drizzle-orm";
import { bigint, check, customType, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
