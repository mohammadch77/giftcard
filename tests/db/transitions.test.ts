import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { conditionalTransition, setTransitionContext } from "@/platform/transitions";
import { withTransaction } from "@/platform/db";
import { createTestDatabase, pgCode, pgMessage } from "../helpers/db";
import type { TestDatabase } from "../helpers/db";

let t: TestDatabase;

const histTable = (name: string, idType: string) => `
  create table ${name}_history (
    id bigint generated always as identity primary key,
    entity_id ${idType} not null, from_status text, to_status text not null,
    actor_id text, reason text, occurred_at timestamptz not null)`;

beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query(`
    insert into state_transition_rules (machine, from_status, to_status) values
      ('probe_order', null, 'PENDING'),
      ('probe_order', 'PENDING', 'PAID'),
      ('probe_order', 'PENDING', 'CANCELLED'),
      ('probe_order', 'PAID', 'SHIPPED'),
      ('probe_strict', null, 'OPEN'),
      ('probe_strict', 'OPEN', 'CLOSED'),
      ('probe_numeric', null, 'A'),
      ('probe_numeric', 'A', 'B');
    create table order_probe (id uuid primary key default gen_random_uuid(), status text not null);
    ${histTable("order_probe", "uuid")};
    select platform_attach_transition_guard('order_probe', 'probe_order', 'order_probe_history');

    create table strict_probe (id uuid primary key default gen_random_uuid(), status text not null);
    ${histTable("strict_probe", "uuid")};
    select platform_attach_transition_guard('strict_probe', 'probe_strict', 'strict_probe_history', 'id', 'status', true);

    create table numeric_probe (id bigint primary key generated always as identity, state text not null);
    ${histTable("numeric_probe", "bigint")};
    select platform_attach_transition_guard('numeric_probe', 'probe_numeric', 'numeric_probe_history', 'id', 'state');

    create table nohist_probe (id int primary key generated always as identity, status text not null);
    select platform_attach_transition_guard('nohist_probe', 'probe_order');
  `);
});
afterAll(async () => {
  await t?.drop();
});

const newOrder = async (status = "PENDING") =>
  ((await t.pool.query("insert into order_probe (status) values ($1) returning id", [status])).rows[0] as { id: string }).id;
const history = async (table: string, id: string | number) =>
  (await t.pool.query(`select from_status, to_status, actor_id, reason from ${table}_history where entity_id = $1 order by id`, [id])).rows as {
    from_status: string | null; to_status: string; actor_id: string | null; reason: string | null;
  }[];

describe("transition validation (C8)", () => {
  it("accepts only registered initial states on INSERT", async () => {
    await expect(newOrder("PAID")).rejects.toSatisfy((e) => pgCode(e) === "PT001");
    await expect(newOrder("NONSENSE")).rejects.toSatisfy((e) => pgCode(e) === "PT001");
    expect(await newOrder("PENDING")).toBeTruthy();
  });
  it("accepts a valid chain and rejects every transition not in the rule table, even via raw SQL", async () => {
    const id = await newOrder();
    await t.pool.query("update order_probe set status='PAID' where id=$1", [id]);
    await t.pool.query("update order_probe set status='SHIPPED' where id=$1", [id]);
    for (const bad of ["PENDING", "PAID", "CANCELLED", "GHOST"]) {
      await expect(t.pool.query("update order_probe set status=$2 where id=$1", [id, bad])).rejects.toSatisfy((e) => pgCode(e) === "PT001");
    }
    const row = (await t.pool.query("select status from order_probe where id=$1", [id])).rows[0] as { status: string };
    expect(row.status).toBe("SHIPPED");
  });
  it("skipping a step is rejected (PENDING -> SHIPPED)", async () => {
    const id = await newOrder();
    await expect(t.pool.query("update order_probe set status='SHIPPED' where id=$1", [id])).rejects.toSatisfy((e) => pgCode(e) === "PT001");
  });
  it("a machine with no rules rejects everything (fail closed)", async () => {
    await t.pool.query("insert into state_transition_rules (machine, from_status, to_status) values ('probe_empty', null, 'X')");
    await t.pool.query("delete from state_transition_rules where machine='probe_empty'");
    await t.pool.query("create table empty_probe (id int primary key generated always as identity, status text not null)");
    await t.pool.query("select platform_attach_transition_guard('empty_probe', 'probe_empty')");
    await expect(t.pool.query("insert into empty_probe (status) values ('X')")).rejects.toSatisfy((e) => pgCode(e) === "PT001");
  });
  it("rule table: duplicates (including NULL-from duplicates) and self-loops are rejected", async () => {
    await expect(t.pool.query("insert into state_transition_rules (machine, from_status, to_status) values ('probe_order','PENDING','PAID')")).rejects.toSatisfy((e) => pgCode(e) === "23505");
    await expect(t.pool.query("insert into state_transition_rules (machine, from_status, to_status) values ('probe_order',null,'PENDING')")).rejects.toSatisfy((e) => pgCode(e) === "23505");
    await expect(t.pool.query("insert into state_transition_rules (machine, from_status, to_status) values ('probe_order','PAID','PAID')")).rejects.toSatisfy((e) => pgCode(e) === "23514");
    await expect(t.pool.query("insert into state_transition_rules (machine, from_status, to_status) values ('Bad Name','A','B')")).rejects.toSatisfy((e) => pgCode(e) === "23514");
  });
  it("machines are isolated from each other", async () => {
    await expect(t.pool.query("insert into strict_probe (status) values ('PENDING')")).rejects.toSatisfy((e) => pgCode(e) === "PT001");
  });
});

describe("transition history", () => {
  it("is written by the trigger (code cannot forget it) with from/to", async () => {
    const id = await newOrder();
    await t.pool.query("update order_probe set status='PAID' where id=$1", [id]);
    expect(await history("order_probe", id)).toEqual([
      { from_status: null, to_status: "PENDING", actor_id: null, reason: null },
      { from_status: "PENDING", to_status: "PAID", actor_id: null, reason: null },
    ]);
  });
  it("captures actor and reason from the transaction context", async () => {
    const id = await newOrder();
    await withTransaction(t.db, async (tx) => {
      await setTransitionContext(tx, { actorId: "user:42", reason: "customer_request" });
      await tx.execute(sql`update order_probe set status='CANCELLED' where id=${id}`);
    });
    const rows = await history("order_probe", id);
    expect(rows[1]).toEqual({ from_status: "PENDING", to_status: "CANCELLED", actor_id: "user:42", reason: "customer_request" });
    // context is transaction-local: it does not leak into the next transaction
    const id2 = await newOrder();
    await t.pool.query("update order_probe set status='PAID' where id=$1", [id2]);
    expect((await history("order_probe", id2))[1]?.actor_id).toBeNull();
  });
  it("a no-op update (same status) is neither a transition nor a history row", async () => {
    const id = await newOrder();
    await t.pool.query("update order_probe set status='PENDING' where id=$1", [id]);
    expect((await history("order_probe", id)).length).toBe(1);
  });
  it("a rolled-back transition leaves no history", async () => {
    const id = await newOrder();
    const c = await t.pool.connect();
    try {
      await c.query("begin");
      await c.query("update order_probe set status='PAID' where id=$1", [id]);
      await c.query("rollback");
    } finally {
      c.release();
    }
    expect((await history("order_probe", id)).length).toBe(1);
  });
  it("can require an actor (PT002) for sensitive machines", async () => {
    await expect(t.pool.query("insert into strict_probe (status) values ('OPEN')")).rejects.toSatisfy((e) => pgCode(e) === "PT002");
    await withTransaction(t.db, async (tx) => {
      await setTransitionContext(tx, { actorId: "system" });
      await tx.execute(sql`insert into strict_probe (status) values ('OPEN')`);
    });
  });
  it("works for bigint ids and custom status column names", async () => {
    const r = await t.pool.query("insert into numeric_probe (state) values ('A') returning id");
    const id = (r.rows[0] as { id: string }).id;
    await t.pool.query("update numeric_probe set state='B' where id=$1", [id]);
    expect((await history("numeric_probe", id)).map((h) => h.to_status)).toEqual(["A", "B"]);
  });
  it("history tables are append-only (UPDATE, DELETE, TRUNCATE)", async () => {
    await expect(t.pool.query("update order_probe_history set reason='x'")).rejects.toSatisfy((e) => pgCode(e) === "23001");
    await expect(t.pool.query("delete from order_probe_history")).rejects.toSatisfy((e) => pgCode(e) === "23001");
    await expect(t.pool.query("truncate order_probe_history")).rejects.toSatisfy((e) => pgCode(e) === "23001");
  });
  it("tables attached without a history table still validate transitions", async () => {
    await t.pool.query("insert into nohist_probe (status) values ('PENDING')");
    await expect(t.pool.query("insert into nohist_probe (status) values ('SHIPPED')")).rejects.toSatisfy((e) => pgCode(e) === "PT001");
  });
});

describe("attach helper safety", () => {
  it("rejects a history table with missing columns and bad machine names", async () => {
    await t.pool.query("create table bad_h (id int)");
    await t.pool.query("create table bad_t (id int primary key, status text)");
    await expect(t.pool.query("select platform_attach_transition_guard('bad_t', 'm', 'bad_h')")).rejects.toThrow(/lacks columns/);
    await expect(t.pool.query("select platform_attach_transition_guard('bad_t', 'Bad;Name')")).rejects.toThrow(/invalid machine name/);
    await expect(t.pool.query("select platform_attach_transition_guard('bad_t', 'm', null, 'id', 'nope')")).rejects.toThrow(/no column/);
  });
});

describe("conditionalTransition (optimistic concurrency pattern)", () => {
  it("returns true exactly once for the same (id, from)", async () => {
    const id = await newOrder();
    const run = () =>
      withTransaction(t.db, (tx) => conditionalTransition(tx, { table: "order_probe", id, from: "PENDING", to: "PAID", context: { actorId: "u1", reason: "paid" } }));
    expect(await run()).toBe(true);
    expect(await run()).toBe(false);
    expect((await history("order_probe", id)).filter((h) => h.to_status === "PAID").length).toBe(1);
  });
  it("still lets the trigger reject a pair that is not in the rules", async () => {
    const id = await newOrder();
    await expect(
      withTransaction(t.db, (tx) => conditionalTransition(tx, { table: "order_probe", id, from: "PENDING", to: "SHIPPED", context: { actorId: "u1" } })),
    ).rejects.toSatisfy((e) => pgCode(e) === "PT001" || /PT001|invalid state transition/.test(pgMessage(e)));
  });
  it("rejects unsafe identifiers before building SQL", async () => {
    await expect(
      withTransaction(t.db, (tx) => conditionalTransition(tx, { table: "order_probe; drop table x", id: "1", from: "A", to: "B", context: { actorId: "u" } })),
    ).rejects.toThrow(/invalid SQL identifier/);
  });
});
