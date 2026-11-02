import { sql } from "drizzle-orm";
import { withTransaction } from "../db/client";
import { withIdempotency } from "../idempotency";
import { systemClock } from "../clock";
import type { Clock } from "../clock";
import { DomainError, isDomainError } from "../errors";
import type { Database, Tx } from "../db/client";
import type { JsonValue } from "../idempotency";

/**
 * Transactional outbox (P-7: events are never deleted).
 * - `enqueueOutbox(tx, …)` inserts in the caller's transaction: the event exists only if that
 *   transaction commits.
 * - `runOutboxOnce` claims a batch under a lease, runs handlers OUTSIDE the claiming transaction,
 *   then acks/fails each event. Delivery is at-least-once: handlers must be idempotent.
 * - An event with no registered handler is failed with a long back-off and eventually becomes DEAD;
 *   it is never silently dropped.
 * - Error text stored on the event is a short classification only (never a message/payload).
 */
export interface OutboxEventInput {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: JsonValue;
  /** Do not deliver before this time (default: the injected clock's now, i.e. immediately). */
  availableAt?: Date;
  maxAttempts?: number;
}

export async function enqueueOutbox(tx: Tx, event: OutboxEventInput, clock: Clock = systemClock): Promise<number> {
  const result = await tx.execute(
    sql`insert into outbox_events (event_type, aggregate_type, aggregate_id, payload, available_at, max_attempts)
        values (${event.eventType}, ${event.aggregateType}, ${event.aggregateId}, ${JSON.stringify(event.payload)}::jsonb,
                ${(event.availableAt ?? clock.now()).toISOString()}::timestamptz, ${event.maxAttempts ?? 10})
        returning id`,
  );
  return Number((result.rows[0] as { id: string | number }).id);
}

export interface ClaimedEvent {
  id: number;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: JsonValue;
  attempt: number;
}

export type OutboxHandler = (event: ClaimedEvent) => Promise<void>;
export type OutboxRegistry = ReadonlyMap<string, OutboxHandler>;

export interface OutboxRunOptions {
  workerId: string;
  batchSize?: number;
  leaseSeconds?: number;
  /** Back-off before a failed event becomes available again. */
  retryAfterSeconds?: number;
  clock?: Clock;
}

export interface OutboxRunSummary {
  claimed: number;
  done: number;
  retried: number;
  dead: number;
  lost: number;
}

interface ClaimRow {
  id: string | number;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: JsonValue;
  attempts: number;
}

export async function claimOutbox(db: Database, o: OutboxRunOptions): Promise<ClaimedEvent[]> {
  const clock = o.clock ?? systemClock;
  const now = clock.now().toISOString();
  const result = await db.execute(
    sql`select * from outbox_claim(${o.workerId}, ${o.batchSize ?? 20}, ${`${o.leaseSeconds ?? 60} seconds`}::interval, ${now}::timestamptz)`,
  );
  // UPDATE ... RETURNING has no defined row order; the batch itself was selected in id order.
  const rows = (result.rows as unknown as ClaimRow[]).slice().sort((a, b) => Number(a.id) - Number(b.id));
  return rows.map((r) => ({
    id: Number(r.id),
    eventType: r.event_type,
    aggregateType: r.aggregate_type,
    aggregateId: r.aggregate_id,
    payload: r.payload,
    attempt: r.attempts,
  }));
}

function classify(error: unknown): string {
  if (isDomainError(error)) return `DomainError:${error.code}`;
  if (error instanceof Error) return `Error:${error.name}`.slice(0, 100);
  return "UnknownError";
}

export async function runOutboxOnce(db: Database, registry: OutboxRegistry, o: OutboxRunOptions): Promise<OutboxRunSummary> {
  const clock = o.clock ?? systemClock;
  const summary: OutboxRunSummary = { claimed: 0, done: 0, retried: 0, dead: 0, lost: 0 };
  const events = await claimOutbox(db, o);
  summary.claimed = events.length;

  for (const event of events) {
    const handler = registry.get(event.eventType);
    let failure: string | null = null;
    if (!handler) {
      failure = "NO_HANDLER";
    } else {
      try {
        await handler(event);
      } catch (error) {
        failure = classify(error);
      }
    }

    if (failure === null) {
      const acked = await db.execute(
        sql`select outbox_ack(${event.id}, ${o.workerId}, ${event.attempt}, ${clock.now().toISOString()}::timestamptz) as ok`,
      );
      if ((acked.rows[0] as { ok: boolean }).ok) summary.done += 1;
      else summary.lost += 1;
    } else {
      const retry = failure === "NO_HANDLER" ? Math.max(o.retryAfterSeconds ?? 30, 300) : (o.retryAfterSeconds ?? 30);
      const failed = await db.execute(
        sql`select outbox_fail(${event.id}, ${o.workerId}, ${event.attempt}, ${failure}, ${clock.now().toISOString()}::timestamptz, ${`${retry} seconds`}::interval) as r`,
      );
      const r = (failed.rows[0] as { r: string }).r;
      if (r === "RETRY") summary.retried += 1;
      else if (r === "DEAD") summary.dead += 1;
      else summary.lost += 1;
    }
  }
  return summary;
}


/**
 * DELIVERY SEMANTICS: the outbox is AT-LEAST-ONCE, never "exactly-once". A worker can crash after a
 * handler's side effect but before the ack (or lose its lease while still running), so the same event
 * can be handled again. Every consumer must therefore be idempotent.
 *
 * `idempotentHandler` is the standard way: the handler's database effects and an idempotency record
 * keyed by (consumer, event id) commit in ONE transaction, so a replay of the same event finds the
 * record and does nothing. This gives "effect applied once" ONLY for effects inside that transaction.
 * Effects outside the database (SMS, supplier API, e-mail) must carry their own idempotency key
 * (e.g. the event id) towards the external system — see SUPPLIER/PAYMENT designs.
 */
const CONSUMER_RE = /^[a-z][a-z0-9_.:-]{0,40}$/;

export function idempotentHandler(
  db: Database,
  consumer: string,
  effect: (tx: Tx, event: ClaimedEvent) => Promise<void>,
): OutboxHandler {
  if (!CONSUMER_RE.test(consumer)) throw new DomainError("INVALID_ARGUMENT", "invalid consumer name");
  return async (event) => {
    await withTransaction(db, (tx) =>
      withIdempotency(
        tx,
        { scope: `outbox.${consumer}`, key: `outbox-event-${event.id}`, request: { eventId: event.id, eventType: event.eventType } },
        async () => {
          await effect(tx, event);
          return { handled: true };
        },
      ),
    );
  };
}
