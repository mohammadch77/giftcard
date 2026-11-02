import { sql } from "drizzle-orm";
import type { Clock } from "../clock";
import { systemClock } from "../clock";
import type { Database, Tx } from "../db";
import { DomainError } from "../errors";

export interface RateLimitRule {
  /** Opaque bucket key, e.g. `otp:h:<sha256-of-phone>`. Must not contain PII or secrets. */
  bucket: string;
  /** Maximum number of allowed hits per window. */
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Hits recorded in the current window INCLUDING this one. */
  count: number;
  /** Seconds until the window resets (>= 1 when denied). */
  retryAfterSeconds: number;
}

/**
 * Atomic fixed-window limiter backed by PostgreSQL (no Redis, D7). One `INSERT .. ON CONFLICT DO UPDATE`
 * statement per hit, so concurrent callers can never both pass the last slot.
 *
 * IMPORTANT: call this on the DATABASE handle (its own committed statement), not inside a business
 * transaction that may roll back — otherwise a rolled-back attempt would also roll back its own count.
 * Denied hits are counted too (a flood cannot be "free").
 */
export async function consumeRateLimit(db: Database | Tx, rule: RateLimitRule, clock: Clock = systemClock): Promise<RateLimitResult> {
  if (!Number.isInteger(rule.limit) || rule.limit < 1 || !Number.isInteger(rule.windowSeconds) || rule.windowSeconds < 1) {
    throw new DomainError("INVALID_ARGUMENT", "invalid rate limit rule");
  }
  if (rule.bucket.length < 1 || rule.bucket.length > 200) throw new DomainError("INVALID_ARGUMENT", "invalid rate limit bucket");
  const nowMs = clock.now().getTime();
  const windowMs = rule.windowSeconds * 1000;
  const startMs = Math.floor(nowMs / windowMs) * windowMs;
  const result = await db.execute(
    sql`insert into rate_limit_counters (bucket, window_start, count)
        values (${rule.bucket}, ${new Date(startMs).toISOString()}::timestamptz, 1)
        on conflict (bucket, window_start) do update set count = rate_limit_counters.count + 1
        returning count`,
  );
  const count = Number((result.rows[0] as { count: string | number }).count);
  const allowed = count <= rule.limit;
  return { allowed, count, retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((startMs + windowMs - nowMs) / 1000)) };
}
