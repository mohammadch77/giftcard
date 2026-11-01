import { sql } from "drizzle-orm";
import { bigint, check, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

/**
 * Idempotency ledger. A row is inserted at the start of an idempotent operation INSIDE the
 * operation's own DB transaction and completed (response set) before commit, so every committed
 * row is complete (deferred trigger in migration 0005). Rows are never deleted (P-7).
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    unique("idempotency_keys_scope_key").on(t.scope, t.key),
    check("idempotency_keys_scope_format", sql`${t.scope} ~ '^[a-z][a-z0-9_.:-]{0,63}$'`),
    check("idempotency_keys_key_format", sql`${t.key} ~ '^[A-Za-z0-9_.:-]{8,128}$'`),
    check("idempotency_keys_hash_format", sql`${t.requestHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
