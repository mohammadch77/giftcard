import { sql } from "drizzle-orm";
import { bigint, check, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Append-only audit trail. Private to the audit module. UPDATE/DELETE/TRUNCATE are rejected by
 * triggers (migration 0008) and the application role has INSERT/SELECT only. Payloads are redacted
 * by the application before insert (platform/logging redact) — secrets must not be passed at all.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    requestId: text("request_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    metadata: jsonb("metadata"),
  },
  (t) => [
    check("audit_logs_actor_type", sql`${t.actorType} IN ('USER','ADMIN','SYSTEM','WORKER')`),
    check("audit_logs_action_format", sql`${t.action} ~ '^[a-z][a-z0-9_.]{1,79}$'`),
    check("audit_logs_entity_type_format", sql`${t.entityType} ~ '^[a-z][a-z0-9_]{1,63}$'`),
    check("audit_logs_ids_nonempty", sql`length(${t.actorId}) BETWEEN 1 AND 200 AND length(${t.entityId}) BETWEEN 1 AND 200`),
    index("audit_logs_entity").on(t.entityType, t.entityId, t.id),
    index("audit_logs_actor").on(t.actorType, t.actorId, t.id),
    index("audit_logs_action").on(t.action, t.id),
  ],
);
