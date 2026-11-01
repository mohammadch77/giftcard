import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTransaction } from "@/platform/db";
import { claimOutbox, enqueueOutbox, runOutboxOnce } from "@/platform/outbox";
import type { ClaimedEvent, OutboxRegistry } from "@/platform/outbox";
import { ManualClock } from "@/platform/clock/testing";
import { createTestDatabase, pgCode } from "../helpers/db";
import type { TestDatabase } from "../helpers/db";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.drop();
});

const enqueue = (
  type = "probe.happened",
  payload: Record<string, never> | { n: number } = { n: 1 },
  extra: { maxAttempts?: number; availableAt?: Date; clock?: ManualClock } = {},
) => {
  const { clock, ...rest } = extra;
  return withTransaction(t.db, (tx) =>
    enqueueOutbox(tx, { eventType: type, aggregateType: "probe", aggregateId: "p-1", payload, ...rest }, clock),
  );
};
const row = async (id: number) =>
  (await t.pool.query("select status, attempts, locked_by, available_at, last_error, processed_at from outbox_events where id=$1", [id])).rows[0] as {
    status: string; attempts: number; locked_by: string | null; available_at: Date; last_error: string | null; processed_at: Date | null;
  };
const claim = (worker: string, clock: ManualClock, batch = 10, lease = 60) => claimOutbox(t.db, { workerId: worker, batchSize: batch, leaseSeconds: lease, clock });

describe("enqueue", () => {
  it("is invisible until commit and absent after rollback", async () => {
    const before = (await t.pool.query("select count(*)::int n from outbox_events")).rows[0].n as number;
    await expect(
      withTransaction(t.db, async (tx) => {
        await enqueueOutbox(tx, { eventType: "probe.rolled_back", aggregateType: "probe", aggregateId: "x", payload: {} });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await t.pool.query("select count(*)::int n from outbox_events")).rows[0].n).toBe(before);
  });
  it("format CHECKs apply (event_type)", async () => {
    await expect(enqueue("Bad Type")).rejects.toSatisfy((e) => pgCode(e) === "23514" || /check constraint/i.test(String((e as Error).cause ?? e)));
  });
});

describe("claim / ack / fail lifecycle (injected clock)", () => {
  it("claims once, hides from other workers, acks to DONE and refuses double ack", async () => {
    const clock = new ManualClock();
    const id = await enqueue("probe.happened", { n: 1 }, { clock });
    const a = await claim("w-a", clock);
    expect(a.map((e) => e.id)).toContain(id);
    expect(a.find((e) => e.id === id)?.attempt).toBe(1);
    expect((await claim("w-b", clock)).map((e) => e.id)).not.toContain(id);
    expect((await t.pool.query("select outbox_ack($1,$2,$3,$4) ok", [id, "w-a", 1, clock.now()])).rows[0].ok).toBe(true);
    expect((await row(id)).status).toBe("DONE");
    expect((await t.pool.query("select outbox_ack($1,$2,$3,$4) ok", [id, "w-a", 1, clock.now()])).rows[0].ok).toBe(false);
  });
  it("fail schedules a retry in the future and the event is claimable again only after that time", async () => {
    const clock = new ManualClock("2026-02-01T00:00:00Z");
    const id = await enqueue("probe.happened", { n: 1 }, { clock });
    await claim("w-a", clock);
    const r = await t.pool.query("select outbox_fail($1,$2,$3,$4,$5,$6::interval) r", [id, "w-a", 1, "Error:Boom", clock.now(), "30 seconds"]);
    expect(r.rows[0].r).toBe("RETRY");
    expect((await row(id)).status).toBe("PENDING");
    expect((await claim("w-a", clock)).map((e) => e.id)).not.toContain(id);
    clock.advance(31_000);
    const again = await claim("w-a", clock);
    expect(again.find((e) => e.id === id)?.attempt).toBe(2);
  });
  it("becomes DEAD (kept, never deleted) when attempts are exhausted", async () => {
    const clock = new ManualClock("2026-03-01T00:00:00Z");
    const id = await enqueue("probe.happened", { n: 9 }, { maxAttempts: 2, clock });
    await claim("w-a", clock);
    expect((await t.pool.query("select outbox_fail($1,$2,$3,$4,$5,$6::interval) r", [id, "w-a", 1, "E", clock.now(), "1 second"])).rows[0].r).toBe("RETRY");
    clock.advance(2000);
    await claim("w-a", clock);
    expect((await t.pool.query("select outbox_fail($1,$2,$3,$4,$5,$6::interval) r", [id, "w-a", 2, "E", clock.now(), "1 second"])).rows[0].r).toBe("DEAD");
    expect((await row(id)).status).toBe("DEAD");
    clock.advance(3_600_000);
    expect((await claim("w-a", clock)).map((e) => e.id)).not.toContain(id);
    await expect(t.pool.query("delete from outbox_events where id=$1", [id])).rejects.toSatisfy((e) => pgCode(e) === "23001");
  });
  it("a crashed worker's expired lease is re-claimed by another; the stale worker cannot ack", async () => {
    const clock = new ManualClock("2026-04-01T00:00:00Z");
    const id = await enqueue("probe.happened", { n: 1 }, { clock });
    await claim("w-crashed", clock, 10, 60);
    clock.advance(61_000);
    const reclaimed = await claim("w-b", clock, 10, 60);
    expect(reclaimed.find((e) => e.id === id)?.attempt).toBe(2);
    expect((await t.pool.query("select outbox_ack($1,$2,$3,$4) ok", [id, "w-crashed", 1, clock.now()])).rows[0].ok).toBe(false);
    expect((await t.pool.query("select outbox_ack($1,$2,$3,$4) ok", [id, "w-b", 2, clock.now()])).rows[0].ok).toBe(true);
  });
  it("an expired lease with attempts exhausted is dead-lettered by the next claim", async () => {
    const clock = new ManualClock("2026-05-01T00:00:00Z");
    const id = await enqueue("probe.happened", { n: 5 }, { maxAttempts: 1, clock });
    await claim("w-crashed", clock, 10, 60);
    clock.advance(61_000);
    await claim("w-b", clock);
    expect((await row(id)).status).toBe("DEAD");
  });
  it("respects available_at and claims in id order", async () => {
    const clock = new ManualClock("2026-06-01T00:00:00Z");
    const future = await enqueue("probe.happened", { n: 1 }, { availableAt: new Date("2026-06-01T01:00:00Z"), clock });
    const first = await enqueue("probe.happened", { n: 1 }, { clock });
    const second = await enqueue("probe.happened", { n: 1 }, { clock });
    const got = (await claim("w-a", clock, 100)).map((e) => e.id);
    expect(got).not.toContain(future);
    expect(got.indexOf(first)).toBeLessThan(got.indexOf(second));
  });
});

describe("events are immutable and status changes are validated", () => {
  it("content cannot change; DONE cannot go back to PENDING (PT001)", async () => {
    const clock = new ManualClock("2026-07-01T00:00:00Z");
    const id = await enqueue("probe.happened", { n: 1 }, { clock });
    await claim("w", clock);
    await expect(t.pool.query("update outbox_events set payload='{}'::jsonb where id=$1", [id])).rejects.toSatisfy((e) => pgCode(e) === "23001");
    await t.pool.query("select outbox_ack($1,'w',1,$2)", [id, clock.now()]);
    await expect(
      t.pool.query("update outbox_events set status='PENDING', locked_by=null, locked_until=null, processed_at=null where id=$1", [id]),
    ).rejects.toSatisfy((e) => pgCode(e) === "PT001");
    await expect(t.pool.query("truncate outbox_events")).rejects.toSatisfy((e) => pgCode(e) === "23001");
  });
});

describe("runOutboxOnce", () => {
  it("runs handlers outside the claim, acks successes, and records only a classification on failure", async () => {
    const clock = new ManualClock("2026-08-01T00:00:00Z");
    const ok = await enqueue("probe.ok", { n: 1 }, { clock });
    const bad = await enqueue("probe.bad", { n: 1 }, { clock });
    const seen: number[] = [];
    const registry: OutboxRegistry = new Map([
      ["probe.ok", async (e: ClaimedEvent) => void seen.push(e.id)],
      ["probe.bad", async () => { throw new Error("CANARY-secret-code-ABC123"); }],
    ]);
    const summary = await runOutboxOnce(t.db, registry, { workerId: "w-run", batchSize: 100, clock });
    expect(seen).toContain(ok);
    expect(summary.done).toBeGreaterThanOrEqual(1);
    expect((await row(ok)).status).toBe("DONE");
    const failed = await row(bad);
    expect(failed.status).toBe("PENDING");
    expect(failed.last_error).toBe("Error:Error");
    expect(failed.last_error).not.toContain("CANARY");
  });
  it("an event type without a handler is never dropped: it is failed with a long back-off", async () => {
    const clock = new ManualClock("2026-09-01T00:00:00Z");
    const id = await enqueue("probe.unhandled", { n: 1 }, { clock });
    await runOutboxOnce(t.db, new Map(), { workerId: "w-run", batchSize: 100, clock });
    const r = await row(id);
    expect(r.status).toBe("PENDING");
    expect(r.last_error).toBe("NO_HANDLER");
    expect(r.available_at.getTime() - clock.now().getTime()).toBeGreaterThanOrEqual(300_000);
  });
  it("a handler that exceeds its lease loses the ack (at-least-once, no double completion)", async () => {
    const clock = new ManualClock("2026-10-01T00:00:00Z");
    const id = await enqueue("probe.slow", { n: 1 }, { clock });
    const registry: OutboxRegistry = new Map([
      ["probe.slow", async () => {
        clock.advance(120_000); // lease (60s) expires while the handler runs
        await claim("w-other", clock); // another worker re-claims it
      }],
    ]);
    const summary = await runOutboxOnce(t.db, registry, { workerId: "w-slow", batchSize: 100, leaseSeconds: 60, clock });
    expect(summary.lost).toBeGreaterThanOrEqual(1);
    expect((await row(id)).locked_by).toBe("w-other");
  });
});
