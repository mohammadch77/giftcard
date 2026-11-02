import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTransaction } from "@/platform/db";
import { claimOutbox, enqueueOutbox, idempotentHandler, runOutboxOnce } from "@/platform/outbox";
import type { ClaimedEvent } from "@/platform/outbox";
import type { OutboxRegistry } from "@/platform/outbox";
import { ManualClock } from "@/platform/clock/testing";
import { createTestDatabase } from "../helpers/db";
import type { TestDatabase } from "../helpers/db";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query("create table seen (event_id bigint primary key, worker text not null)");
});
afterAll(async () => {
  await t?.drop();
});

async function seed(n: number, clock: ManualClock): Promise<void> {
  await withTransaction(t.db, async (tx) => {
    for (let i = 0; i < n; i++) await enqueueOutbox(tx, { eventType: "load.event", aggregateType: "load", aggregateId: String(i), payload: { i } }, clock);
  });
}

const registryFor = (worker: string): OutboxRegistry =>
  new Map([
    [
      "load.event",
      async (e) => {
        // The primary key makes any duplicate processing of one event fail loudly.
        await t.pool.query("insert into seen (event_id, worker) values ($1, $2)", [e.id, worker]);
      },
    ],
  ]);

async function drain(workerId: string, clock: ManualClock): Promise<void> {
  for (let idle = 0; idle < 3; ) {
    const s = await runOutboxOnce(t.db, registryFor(workerId), { workerId, batchSize: 25, leaseSeconds: 600, clock });
    idle = s.claimed === 0 ? idle + 1 : 0;
  }
}

describe("outbox under concurrency", () => {
  it("4 workers drain 500 events: every event is processed exactly once, none lost, none duplicated", async () => {
    const clock = new ManualClock("2026-02-01T00:00:00Z");
    await seed(500, clock);
    await Promise.all(["w1", "w2", "w3", "w4"].map((w) => drain(w, clock)));

    const stats = (await t.pool.query(`select count(*)::int total,
        count(*) filter (where status = 'DONE')::int done,
        count(*) filter (where attempts = 1)::int once from outbox_events where event_type = 'load.event'`)).rows[0];
    expect(stats).toEqual({ total: 500, done: 500, once: 500 });
    expect((await t.pool.query("select count(*)::int n from seen")).rows[0].n).toBe(500);
    const spread = (await t.pool.query("select count(distinct worker)::int n from seen")).rows[0].n as number;
    expect(spread).toBeGreaterThan(1); // work really was shared
  });

  it("a crashed worker's batch is recovered after its lease expires, still exactly once", async () => {
    const clock = new ManualClock("2026-03-01T00:00:00Z");
    await t.pool.query("truncate seen");
    await seed(120, clock);
    const stolen = await claimOutbox(t.db, { workerId: "crashed", batchSize: 50, leaseSeconds: 60, clock }); // never processed/acked
    expect(stolen.length).toBe(50);

    await Promise.all(["w1", "w2", "w3"].map((w) => drain(w, clock))); // lease still valid: 70 events drain
    expect((await t.pool.query("select count(*)::int n from seen")).rows[0].n).toBe(70);

    clock.advance(61_000); // lease expires
    await Promise.all(["w1", "w2", "w3"].map((w) => drain(w, clock)));
    expect((await t.pool.query("select count(*)::int n from seen")).rows[0].n).toBe(120);
    const recovered = (await t.pool.query("select count(*)::int n from outbox_events where attempts = 2 and status = 'DONE' and aggregate_type = 'load'")).rows[0].n;
    expect(recovered).toBe(50);
    expect((await t.pool.query("select count(*)::int n from outbox_events where status <> 'DONE' and aggregate_type = 'load'")).rows[0].n).toBe(0);
  });

  it("the same event handled by 25 concurrent deliveries (lease lost while still running) applies its effect once", async () => {
    const clock = new ManualClock("2026-04-01T00:00:00Z");
    await t.pool.query("create table if not exists dup_effects (event_id bigint not null)");
    const id = await withTransaction(t.db, (tx) => enqueueOutbox(tx, { eventType: "dup.event", aggregateType: "dup", aggregateId: "1", payload: {} }, clock));
    const handler = idempotentHandler(t.db, "dup_consumer", async (tx, e) => {
      await tx.execute(sql`insert into dup_effects values (${e.id})`);
      await new Promise((r) => setTimeout(r, 50));
    });
    const event: ClaimedEvent = { id, eventType: "dup.event", aggregateType: "dup", aggregateId: "1", payload: {}, attempt: 1 };
    await Promise.all(Array.from({ length: 25 }, () => handler(event)));
    expect((await t.pool.query("select count(*)::int n from dup_effects where event_id=$1", [id])).rows[0].n).toBe(1);
  });
});
