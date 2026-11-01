import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Allowed state transitions per state machine (P-3). `from_status IS NULL` = initial state
 * (allowed on INSERT). Seeded by migrations from docs/STATE_MACHINES.md; the application role
 * has SELECT only. Enforcement lives in the trigger functions of migration 0004.
 */
export const stateTransitionRules = pgTable(
  "state_transition_rules",
  {
    machine: text("machine").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("state_transition_rules_machine_format", sql`${t.machine} ~ '^[a-z][a-z0-9_]*$'`),
    check("state_transition_rules_distinct", sql`${t.fromStatus} IS DISTINCT FROM ${t.toStatus}`),
    uniqueIndex("state_transition_rules_unique").on(t.machine, sql`coalesce(${t.fromStatus}, '')`, t.toStatus),
    index("state_transition_rules_lookup").on(t.machine, t.fromStatus),
  ],
);
