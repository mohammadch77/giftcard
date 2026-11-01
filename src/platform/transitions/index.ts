import { sql } from "drizzle-orm";
import { DomainError } from "../errors";
import type { Tx } from "../db/client";

/**
 * Application side of the state-transition engine (P-3). Validation and history are enforced by
 * PostgreSQL triggers (migration 0004); these helpers only supply the actor/reason context and
 * the optimistic-concurrency UPDATE pattern.
 */
export interface TransitionContext {
  /** Who causes the change: a user id, 'system', or 'worker:<name>'. */
  actorId: string;
  /** Short, non-sensitive reason code or text. */
  reason?: string;
}

/** Sets transaction-local settings read by the history trigger. Call inside the transaction. */
export async function setTransitionContext(tx: Tx, ctx: TransitionContext): Promise<void> {
  if (!ctx.actorId) throw new DomainError("INVALID_ARGUMENT", "actorId is required");
  await tx.execute(sql`select set_config('app.actor_id', ${ctx.actorId}, true), set_config('app.reason', ${ctx.reason ?? ""}, true)`);
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export interface ConditionalTransition {
  table: string;
  idColumn?: string;
  statusColumn?: string;
  id: string | number;
  from: string;
  to: string;
  context: TransitionContext;
}

/**
 * `UPDATE t SET status = :to WHERE id = :id AND status = :from` — returns true when THIS caller
 * performed the transition, false when someone else already moved the row (treat as a conflict and
 * re-read). The trigger additionally rejects (from,to) pairs that are not in the rule table.
 * Identifiers are validated against a strict pattern; values are always bound parameters.
 */
export async function conditionalTransition(tx: Tx, t: ConditionalTransition): Promise<boolean> {
  const idColumn = t.idColumn ?? "id";
  const statusColumn = t.statusColumn ?? "status";
  for (const ident of [t.table, idColumn, statusColumn]) {
    if (!IDENT.test(ident)) throw new DomainError("INVALID_ARGUMENT", "invalid SQL identifier");
  }
  await setTransitionContext(tx, t.context);
  const result = await tx.execute(
    sql`update ${sql.identifier(t.table)} set ${sql.identifier(statusColumn)} = ${t.to}
         where ${sql.identifier(idColumn)} = ${t.id} and ${sql.identifier(statusColumn)} = ${t.from}
         returning 1`,
  );
  return result.rows.length === 1;
}
