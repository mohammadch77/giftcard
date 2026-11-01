import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Tiny platform key/value table. It exists in Phase 2a to prove the Drizzle -> SQL migration
 * workflow end to end (typed table + CHECK constraint). It holds no business data.
 */
export const dbMeta = pgTable(
  "db_meta",
  {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("db_meta_key_format", sql`${t.key} ~ '^[a-z][a-z0-9_.]*$'`)],
);
