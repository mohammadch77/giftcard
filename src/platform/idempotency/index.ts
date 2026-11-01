import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { DomainError } from "../errors";
import type { Tx } from "../db/client";

/**
 * Idempotent operations (decision: platform primitive, 2b-1a).
 *
 * `withIdempotency` MUST be called inside the DB transaction that performs the operation's side
 * effects. It inserts the (scope,key) row first; a concurrent caller with the same key blocks on the
 * unique index until the first transaction commits (then replays the stored result) or rolls back
 * (then it runs). Because the key row, the side effects and the stored response commit atomically,
 * exactly-once holds for everything done in that transaction. If `fn` throws, the whole transaction
 * rolls back and the key is NOT consumed (a retry re-executes).
 *
 * Do not use this for multi-phase flows that call external systems between phases (payment
 * verification, supplier submission): those use their own state machines.
 * Rows are never deleted (P-7).
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/** Stable JSON: object keys sorted, no whitespace; rejects undefined/NaN/Infinity/bigint/functions. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new DomainError("INVALID_ARGUMENT", "non-finite number in request");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    default:
      throw new DomainError("INVALID_ARGUMENT", `unsupported type in request: ${typeof value}`);
  }
}

export function hashRequest(request: unknown): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

const SCOPE_RE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

export interface IdempotencyOptions {
  /** e.g. 'checkout.create' — one namespace per operation. */
  scope: string;
  /** Client-supplied or derived key, 8–128 chars [A-Za-z0-9_.:-]. */
  key: string;
  /** Anything that identifies the request payload; same key + different hash => conflict. */
  request: unknown;
}

export interface IdempotencyResult<T> {
  replayed: boolean;
  result: T;
}

export async function withIdempotency<T extends JsonValue>(
  tx: Tx,
  options: IdempotencyOptions,
  fn: () => Promise<T>,
): Promise<IdempotencyResult<T>> {
  if (!SCOPE_RE.test(options.scope) || !KEY_RE.test(options.key)) {
    throw new DomainError("IDEMPOTENCY_KEY_INVALID", "invalid idempotency scope or key");
  }
  const requestHash = hashRequest(options.request);

  const inserted = await tx.execute(
    sql`insert into idempotency_keys (scope, key, request_hash)
        values (${options.scope}, ${options.key}, ${requestHash})
        on conflict (scope, key) do nothing
        returning id`,
  );

  if (inserted.rows.length === 1) {
    const id = (inserted.rows[0] as { id: string | number }).id;
    const result = await fn();
    const body = JSON.stringify(result ?? null);
    await tx.execute(sql`update idempotency_keys set response = ${body}::jsonb where id = ${id}`);
    return { replayed: false, result };
  }

  const existing = await tx.execute(
    sql`select request_hash, response from idempotency_keys where scope = ${options.scope} and key = ${options.key}`,
  );
  const row = existing.rows[0] as { request_hash: string; response: T } | undefined;
  if (!row) {
    // Cannot happen under READ COMMITTED (the conflicting row was committed); fail closed.
    throw new DomainError("IDEMPOTENCY_CONFLICT", "idempotency state unavailable");
  }
  if (row.request_hash !== requestHash) {
    throw new DomainError("IDEMPOTENCY_CONFLICT", "idempotency key was used with a different request");
  }
  return { replayed: true, result: row.response };
}
