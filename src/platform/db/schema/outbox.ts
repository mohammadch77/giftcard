import { sql } from "drizzle-orm";
import { bigint, check, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Transactional outbox. Events are inserted in the same transaction as the state change, so they
 * become visible only after commit. Delivery is at-least-once; consumers must be idempotent.
 * Status changes are validated by the transition engine (machine `outbox_event`).
 * Rows are never deleted (P-7); exhausted events stay as DEAD for operators.
 */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    eventType: text("event_type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(10),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lockedBy: text("locked_by"),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("outbox_events_status", sql`${t.status} IN ('PENDING','PROCESSING','DONE','DEAD')`),
    check("outbox_events_attempts", sql`${t.attempts} >= 0 AND ${t.maxAttempts} >= 1`),
    check("outbox_events_type_format", sql`${t.eventType} ~ '^[a-z][a-z0-9_.]*$' AND ${t.aggregateType} ~ '^[a-z][a-z0-9_]*$'`),
    check(
      "outbox_events_lease_consistent",
      sql`(${t.status} = 'PROCESSING') = (${t.lockedBy} IS NOT NULL AND ${t.lockedUntil} IS NOT NULL)`,
    ),
    check("outbox_events_done_has_time", sql`(${t.status} = 'DONE') = (${t.processedAt} IS NOT NULL)`),
    index("outbox_events_claim_pending").on(t.availableAt, t.id).where(sql`${t.status} = 'PENDING'`),
    index("outbox_events_claim_expired").on(t.lockedUntil).where(sql`${t.status} = 'PROCESSING'`),
    index("outbox_events_aggregate").on(t.aggregateType, t.aggregateId),
  ],
);
