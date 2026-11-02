import { bigint, check, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Fixed-window counters for abuse limits (OTP sends, verification attempts, ...). Platform-owned,
 * module-agnostic. Keys must not contain PII (callers pass hashed identifiers). Rows are never
 * deleted in this phase (retention policy unresolved, P-7); they are tiny and (bucket, window) is the PK.
 */
export const rateLimitCounters = pgTable(
  "rate_limit_counters",
  {
    bucket: text("bucket").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: bigint("count", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.bucket, t.windowStart] }),
    check("rate_limit_counters_bucket_len", sql`char_length(${t.bucket}) between 1 and 200`),
    check("rate_limit_counters_count_nonneg", sql`${t.count} >= 0`),
  ],
);
