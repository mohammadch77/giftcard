import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTransaction } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { withIdempotency } from "@/platform/idempotency";
import type { JsonValue } from "@/platform/idempotency";
import { createTestDatabase, pgCode } from "../helpers/db";
import type { TestDatabase } from "../helpers/db";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.drop();
});

const run = <T extends JsonValue>(
  scope: string, key: string, request: unknown, fn: () => Promise<T>,
) => withTransaction(t.db, (tx) => withIdempotency(tx, { scope, key, request }, fn));

describe("withIdempotency", () => {
  it("executes once and replays the stored result without running fn again", async () => {
    let calls = 0;
    const fn = async () => ({ orderId: "o-1", nested: { list: [1, 2, 3] }, ok: true, none: null });
    const a = await run("checkout.create", "key-aaaaaaaa-1", { x: 1 }, async () => (calls++, fn()));
    const b = await run("checkout.create", "key-aaaaaaaa-1", { x: 1 }, async () => (calls++, fn()));
    expect(calls).toBe(1);
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(b.result).toEqual(a.result);
  });
  it("the same key with a different request is a conflict (never silently reused)", async () => {
    await run("checkout.create", "key-bbbbbbbb-2", { amount: 100 }, async () => ({ ok: true }));
    await expect(run("checkout.create", "key-bbbbbbbb-2", { amount: 200 }, async () => ({ ok: true }))).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  });
  it("request key order does not matter", async () => {
    await run("s.one", "key-cccccccc-3", { a: 1, b: 2 }, async () => ({ n: 1 }));
    const again = await run("s.one", "key-cccccccc-3", { b: 2, a: 1 }, async () => ({ n: 2 }));
    expect(again.replayed).toBe(true);
  });
  it("scopes are independent namespaces", async () => {
    const a = await run("scope.a", "key-dddddddd-4", {}, async () => ({ v: "a" }));
    const b = await run("scope.b", "key-dddddddd-4", {}, async () => ({ v: "b" }));
    expect([a.replayed, b.replayed]).toEqual([false, false]);
  });
  it("a failing operation rolls back everything including the key, so a retry re-executes", async () => {
    await t.pool.query("create table idem_effect (n int)");
    await expect(
      withTransaction(t.db, (tx) =>
        withIdempotency(tx, { scope: "effect", key: "key-eeeeeeee-5", request: {} }, async () => {
          await tx.execute(sql`insert into idem_effect values (1)`);
          throw new Error("boom");
        }),
      ),
    ).rejects.toThrow("boom");
    expect((await t.pool.query("select count(*)::int n from idem_effect")).rows[0].n).toBe(0);
    const retry = await run("effect", "key-eeeeeeee-5", {}, async () => ({ ok: true }));
    expect(retry.replayed).toBe(false);
  });
  it("rejects malformed scopes and keys", async () => {
    for (const [scope, key] of [["Bad Scope", "key-ffffffff-6"], ["ok.scope", "short"], ["ok.scope", "has space in key"], ["ok.scope", "x".repeat(129)], ["", "key-ffffffff-6"]]) {
      await expect(run(scope as string, key as string, {}, async () => ({}))).rejects.toSatisfy(
        (e) => e instanceof DomainError && e.code === "IDEMPOTENCY_KEY_INVALID",
      );
    }
  });
});

describe("idempotency_keys table guarantees", () => {
  it("a transaction that inserts a key but never completes it cannot commit", async () => {
    const c = await t.pool.connect();
    try {
      await c.query("begin");
      await c.query("insert into idempotency_keys (scope, key, request_hash) values ('raw.test', 'key-gggggggg-7', $1)", ["0".repeat(64)]);
      await expect(c.query("commit")).rejects.toSatisfy((e) => pgCode(e) === "23000");
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
    expect((await t.pool.query("select count(*)::int n from idempotency_keys where key='key-gggggggg-7'")).rows[0].n).toBe(0);
  });
  it("completed rows are write-once: no update, no delete, no truncate", async () => {
    await run("immut.test", "key-hhhhhhhh-8", { a: 1 }, async () => ({ done: true }));
    await expect(t.pool.query("update idempotency_keys set response='{}'::jsonb where key='key-hhhhhhhh-8'")).rejects.toSatisfy((e) => pgCode(e) === "23001");
    await expect(t.pool.query("update idempotency_keys set request_hash=$1 where key='key-hhhhhhhh-8'", ["f".repeat(64)])).rejects.toSatisfy((e) => pgCode(e) === "23001");
    await expect(t.pool.query("delete from idempotency_keys where key='key-hhhhhhhh-8'")).rejects.toSatisfy((e) => pgCode(e) === "23001");
    await expect(t.pool.query("truncate idempotency_keys")).rejects.toSatisfy((e) => pgCode(e) === "23001");
  });
  it("format CHECKs hold at the database level too", async () => {
    await expect(t.pool.query("insert into idempotency_keys (scope, key, request_hash, response) values ('Bad','key-iiiiiiii-9',$1,'{}')", ["0".repeat(64)])).rejects.toSatisfy((e) => pgCode(e) === "23514");
    await expect(t.pool.query("insert into idempotency_keys (scope, key, request_hash, response) values ('ok','short',$1,'{}')", ["0".repeat(64)])).rejects.toSatisfy((e) => pgCode(e) === "23514");
    await expect(t.pool.query("insert into idempotency_keys (scope, key, request_hash, response) values ('ok','key-iiiiiiii-9','nothex','{}')")).rejects.toSatisfy((e) => pgCode(e) === "23514");
  });
});
