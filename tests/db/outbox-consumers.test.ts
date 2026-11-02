import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTransaction } from "@/platform/db";
import { claimOutbox, enqueueOutbox, idempotentHandler, runOutboxOnce } from "@/platform/outbox";
import type { ClaimedEvent, OutboxHandler, OutboxRegistry } from "@/platform/outbox";
import { ManualClock } from "@/platform/clock/testing";
import { createTestDatabase } from "../helpers/db";
import type { TestDatabase } from "../helpers/db";

/**
 * The outbox is AT-LEAST-ONCE. These tests prove what that means in practice and that an idempotent
 * consumer keeps the side effect single even when the same event is handled again.
 */
let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query("create table effect_log (event_id bigint not null, consumer text not null)"); // deliberately NO unique key
});
afterAll(async () => {
  await t?.drop();
});

const enqueue = (clock: ManualClock, type = "consumer.event") =>
  withTransaction(t.db, (tx) => enqueueOutbox(tx, { eventType: type, aggregateType: "probe", aggregateId: "1", payload: { n: 1 } }, clock));
const effectCount = async (id: number, consumer: string) =>
  (await t.pool.query("select count(*)::int n from effect_log where event_id=$1 and consumer=$2", [id, consumer])).rows[0].n as number;
const status = async (id: number) => (await t.pool.query("select status, attempts from outbox_events where id=$1", [id])).rows[0] as { status: string; attempts: number };

const naive = (consumer: string): OutboxHandler => async (e) => {
  await t.pool.query("insert into effect_log values ($1,$2)", [e.id, consumer]);
};
const idempotent = (consumer: string) =>
  idempotentHandler(t.db, consumer, async (tx, e) => {
    await tx.execute(sql`insert into effect_log values (${e.id}, ${consumer})`);
  });

describe("at-least-once: worker stops after the side effect but before the ack", () => {
  it("a NAIVE consumer applies the effect twice (this is the failure mode idempotency must prevent)", async () => {
    const clock = new ManualClock("2026-01-10T00:00:00Z");
    const id = await enqueue(clock);
    const [claimed] = await claimOutbox(t.db, { workerId: "w1", leaseSeconds: 60, clock });
    await naive("naive")(claimed as ClaimedEvent); // side effect committed...
    // ...worker 1 dies here: no ack. Lease expires, another worker takes over.
    clock.advance(61_000);
    await runOutboxOnce(t.db, new Map([["consumer.event", naive("naive")]]), { workerId: "w2", clock });
    expect(await effectCount(id, "naive")).toBe(2); // duplicate side effect
    expect(await status(id)).toEqual({ status: "DONE", attempts: 2 });
  });

  it("an IDEMPOTENT consumer applies the effect once even though the event is delivered twice", async () => {
    const clock = new ManualClock("2026-01-11T00:00:00Z");
    const id = await enqueue(clock);
    const handler = idempotent("billing");
    const [claimed] = await claimOutbox(t.db, { workerId: "w1", leaseSeconds: 60, clock });
    await handler(claimed as ClaimedEvent); // side effect committed, then "crash" before ack
    clock.advance(61_000);
    const registry: OutboxRegistry = new Map([["consumer.event", handler]]);
    const summary = await runOutboxOnce(t.db, registry, { workerId: "w2", clock });
    expect(summary.done).toBeGreaterThanOrEqual(1);
    expect(await effectCount(id, "billing")).toBe(1);
    expect(await status(id)).toEqual({ status: "DONE", attempts: 2 }); // delivered twice, effect once
  });

  it("a handler that throws AFTER committing its effect is retried without a duplicate effect", async () => {
    const clock = new ManualClock("2026-01-12T00:00:00Z");
    const id = await enqueue(clock);
    let calls = 0;
    const flaky: OutboxHandler = async (e) => {
      await idempotent("flaky")(e);
      calls += 1;
      if (calls === 1) throw new Error("crash after commit, before ack");
    };
    const registry: OutboxRegistry = new Map([["consumer.event", flaky]]);
    const first = await runOutboxOnce(t.db, registry, { workerId: "w1", clock, retryAfterSeconds: 10 });
    expect(first.retried).toBeGreaterThanOrEqual(1);
    expect(await effectCount(id, "flaky")).toBe(1);
    clock.advance(11_000);
    await runOutboxOnce(t.db, registry, { workerId: "w1", clock });
    expect(await effectCount(id, "flaky")).toBe(1);
    expect(await status(id)).toEqual({ status: "DONE", attempts: 2 });
  });

  it("consumers are independent: two consumers of the same event type each apply their own effect once", async () => {
    const clock = new ManualClock("2026-01-13T00:00:00Z");
    const id = await enqueue(clock);
    const [claimed] = await claimOutbox(t.db, { workerId: "w1", leaseSeconds: 60, clock });
    const a = idempotent("consumer_a");
    const b = idempotent("consumer_b");
    await Promise.all([a(claimed as ClaimedEvent), b(claimed as ClaimedEvent), a(claimed as ClaimedEvent), b(claimed as ClaimedEvent)]);
    expect(await effectCount(id, "consumer_a")).toBe(1);
    expect(await effectCount(id, "consumer_b")).toBe(1);
  });

  it("rejects invalid consumer names", () => {
    expect(() => idempotentHandler(t.db, "Bad Name", async () => undefined)).toThrow();
  });
});
