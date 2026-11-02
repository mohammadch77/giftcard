import { sql } from "drizzle-orm";
import { bigint, boolean, char, check, customType, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Ledger tables — private to the ledger module. The LEDGER IS THE ONLY SOURCE OF FINANCIAL TRUTH.
 * Entries/transactions/accounts are append-only (triggers, migration 0009); `ledger_account_balances`
 * is a PROJECTION maintained only by trigger code and verified against the entries.
 * The FK transactions.audit_log_id -> audit_logs(id) is created in SQL (cross-module FK, P-1).
 */

/** Signed safe integer in PostgreSQL domain rial_balance (balances may be negative for contra/overdrawn accounts). */
const signedRial = customType<{ data: number; driverData: string }>({
  dataType: () => "rial_balance",
  toDriver: (v) => {
    if (!Number.isSafeInteger(v)) throw new Error("balance must be a safe integer");
    return String(v);
  },
  fromDriver: (v) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n)) throw new Error("balance outside the safe integer range");
    return n;
  },
});

const positiveRial = customType<{ data: number; driverData: string }>({
  dataType: () => "rial_amount",
  toDriver: (v) => String(v),
  fromDriver: (v) => Number(v),
});

export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    code: text("code").notNull(),
    ownerType: text("owner_type"),
    ownerId: text("owner_id"),
    type: text("type").notNull(),
    contra: boolean("contra").notNull().default(false),
    normalSide: text("normal_side").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("IRR"),
    minBalance: signedRial("min_balance"),
    chartVersion: text("chart_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("ledger_accounts_code_format", sql`${t.code} ~ '^[A-Z][A-Z0-9_]{1,63}$'`),
    check("ledger_accounts_type", sql`${t.type} IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')`),
    check("ledger_accounts_side", sql`${t.normalSide} IN ('DEBIT','CREDIT')`),
    check("ledger_accounts_currency", sql`${t.currency} = 'IRR'`),
    check("ledger_accounts_owner_pair", sql`(${t.ownerType} IS NULL) = (${t.ownerId} IS NULL)`),
    check(
      "ledger_accounts_normal_side_matches_type",
      sql`${t.normalSide} = CASE WHEN (${t.type} IN ('ASSET','EXPENSE')) <> ${t.contra} THEN 'DEBIT' ELSE 'CREDIT' END`,
    ),
    uniqueIndex("ledger_accounts_identity").on(t.code, sql`coalesce(${t.ownerType}, '')`, sql`coalesce(${t.ownerId}, '')`),
    index("ledger_accounts_owner").on(t.ownerType, t.ownerId),
  ],
);

export const ledgerTransactions = pgTable(
  "ledger_transactions",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    kind: text("kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    referenceType: text("reference_type").notNull(),
    referenceId: text("reference_id").notNull(),
    reversesId: bigint("reverses_id", { mode: "number" }),
    description: text("description"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    auditLogId: bigint("audit_log_id", { mode: "number" }).notNull(),
    pgTxid: bigint("pg_txid", { mode: "number" }).notNull().default(sql`txid_current()`),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("ledger_transactions_kind_format", sql`${t.kind} ~ '^[A-Z][A-Z0-9_]{1,63}$'`),
    check("ledger_transactions_key_format", sql`${t.idempotencyKey} ~ '^[A-Za-z0-9_.:-]{8,128}$'`),
    check("ledger_transactions_hash_format", sql`${t.requestHash} ~ '^[0-9a-f]{64}$'`),
    check("ledger_transactions_ref_format", sql`${t.referenceType} ~ '^[a-z][a-z0-9_]{1,63}$' AND length(${t.referenceId}) BETWEEN 1 AND 200`),
    check("ledger_transactions_reversal_consistent", sql`(${t.kind} = 'REVERSAL') = (${t.reversesId} IS NOT NULL)`),
    check("ledger_transactions_actor_type", sql`${t.actorType} IN ('USER','ADMIN','SYSTEM','WORKER')`),
    check("ledger_transactions_description_len", sql`${t.description} IS NULL OR length(${t.description}) <= 500`),
    uniqueIndex("ledger_transactions_idempotency_key").on(t.idempotencyKey),
    uniqueIndex("ledger_transactions_one_reversal").on(t.reversesId).where(sql`${t.reversesId} IS NOT NULL`),
    index("ledger_transactions_reference").on(t.referenceType, t.referenceId),
  ],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    transactionId: bigint("transaction_id", { mode: "number" }).notNull(),
    accountId: bigint("account_id", { mode: "number" }).notNull(),
    side: text("side").notNull(),
    amount: positiveRial("amount").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("ledger_entries_side", sql`${t.side} IN ('DEBIT','CREDIT')`),
    check("ledger_entries_amount_positive", sql`${t.amount} > 0`),
    index("ledger_entries_account").on(t.accountId, t.id),
    index("ledger_entries_transaction").on(t.transactionId),
  ],
);

export const ledgerAccountBalances = pgTable(
  "ledger_account_balances",
  {
    accountId: bigint("account_id", { mode: "number" }).primaryKey(),
    balance: signedRial("balance").notNull().default(0),
    minBalance: signedRial("min_balance"),
    entryCount: bigint("entry_count", { mode: "number" }).notNull().default(0),
    lastEntryId: bigint("last_entry_id", { mode: "number" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(0),
  },
  (t) => [check("ledger_account_balances_floor", sql`${t.minBalance} IS NULL OR ${t.balance} >= ${t.minBalance}`)],
);
