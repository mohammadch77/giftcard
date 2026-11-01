import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTransaction } from "@/platform/db";
import { withIdempotency } from "@/platform/idempotency";
import { createTestDatabase } from "../helpers/db";
import type { TestDatabase } from "../helpers/db";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query("create table effects (n int not null)");
  await t.pool.query("insert into effects values (0)");
});
afterAll(async () => {
  await t?.drop();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const effects = async () => (await t.pool.query("select n from effects")).rows[0].n as number;

describe("idempotency under concurrency", () => {
  it("50 parallel calls with one key execute the operation exactly once (the others wait, then replay)", async () => {
    let executions = 0;
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        withTransaction(t.db, (tx) =>
          withIdempotency(tx, { scope: "conc.same", key: "key-same-0001", request: { v: 1 } }, async () => {
            executions += 1;
            await sleep(150); // slow operation: late arrivals must block, not run again
            await tx.execute(sql`update effects set n = n + 1`);
            return { token: "result-1" };
          }),
        ),
      ),
    );
    expect(executions).toBe(1);
    expect(await effects()).toBe(1);
    expect(results.filter((r) => !r.replayed).length).toBe(1);
    expect(new Set(results.map((r) => r.result.token)).size).toBe(1);
  });

  it("parallel calls with the same key but different requests: exactly one request wins, the rest conflict", async () => {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        withTransaction(t.db, (tx) =>
          withIdempotency(tx, { scope: "conc.diff", key: "key-diff-0002", request: { variant: i % 2 } }, async () => {
            await tx.execute(sql`update effects set n = n + 1`);
            return { variant: i % 2 };
          }),
        ),
      ),
    );
    const ok = outcomes.filter((o) => o.status === "fulfilled");
    const conflicts = outcomes.filter((o) => o.status === "rejected" && (o.reason as { code?: string }).code === "IDEMPOTENCY_CONFLICT");
    expect(ok.length + conflicts.length).toBe(20);
    const winners = new Set(ok.map((o) => (o as PromiseFulfilledResult<{ result: { variant: number } }>).value.result.variant));
    expect(winners.size).toBe(1);
    expect(conflicts.length).toBe(20 - ok.length);
    expect(ok.length).toBeGreaterThan(0);
  });

  it("if the first executor fails, exactly one waiter takes over and the side effect happens once", async () => {
    const before = await effects();
    let firstFailed = false;
    let successes = 0;
    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        withTransaction(t.db, (tx) =>
          withIdempotency(tx, { scope: "conc.fail", key: "key-fail-0003", request: {} }, async () => {
            await tx.execute(sql`update effects set n = n + 1`);
            if (!firstFailed) {
              firstFailed = true;
              await sleep(100);
              throw new Error("first attempt fails");
            }
            successes += 1;
            return { ok: true };
          }),
        ),
      ),
    );
    expect(outcomes.filter((o) => o.status === "rejected").length).toBe(1);
    expect(successes).toBe(1);
    expect((await effects()) - before).toBe(1); // the failed attempt's increment was rolled back
  });
});
