import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTransaction } from "@/platform/db";
import { conditionalTransition } from "@/platform/transitions";
import { createTestDatabase, pgCode, pgMessage } from "../helpers/db";
import type { TestDatabase } from "../helpers/db";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query(`
    insert into state_transition_rules (machine, from_status, to_status) values
      ('race', null, 'PENDING'), ('race', 'PENDING', 'PAID'), ('race', 'PENDING', 'CANCELLED'), ('race', 'PAID', 'SHIPPED');
    create table race_probe (id int primary key generated always as identity, status text not null);
    create table race_probe_history (id bigint generated always as identity primary key, entity_id int not null,
      from_status text, to_status text not null, actor_id text, reason text, occurred_at timestamptz not null);
    select platform_attach_transition_guard('race_probe', 'race', 'race_probe_history');`);
});
afterAll(async () => {
  await t?.drop();
});

describe("competing transitions on the same row", () => {
  it("for 40 rows, 6 racers each (PAID vs CANCELLED): exactly one wins per row and history has exactly one transition", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 40; i++) ids.push((await t.pool.query("insert into race_probe (status) values ('PENDING') returning id")).rows[0].id as number);

    const attempts = ids.flatMap((id) =>
      ["PAID", "CANCELLED", "PAID", "CANCELLED", "PAID", "CANCELLED"].map((to) =>
        withTransaction(t.db, (tx) => conditionalTransition(tx, { table: "race_probe", id, from: "PENDING", to, context: { actorId: `racer:${to}` } })).then(
          (won) => ({ id, to, won }),
        ),
      ),
    );
    const results = await Promise.all(attempts);

    for (const id of ids) {
      const mine = results.filter((r) => r.id === id);
      expect(mine.filter((r) => r.won).length).toBe(1);
      const winner = mine.find((r) => r.won) as { to: string };
      const finalStatus = (await t.pool.query("select status from race_probe where id=$1", [id])).rows[0].status;
      expect(finalStatus).toBe(winner.to);
      const hist = (await t.pool.query("select to_status, actor_id from race_probe_history where entity_id=$1 and from_status='PENDING'", [id])).rows;
      expect(hist).toEqual([{ to_status: winner.to, actor_id: `racer:${winner.to}` }]);
    }
  });

  it("300 parallel random UPDATEs (valid and invalid targets): the final data never violates the rule table", async () => {
    const id = (await t.pool.query("insert into race_probe (status) values ('PENDING') returning id")).rows[0].id as number;
    const targets = ["PENDING", "PAID", "CANCELLED", "SHIPPED", "GHOST"];
    let seed = 42;
    const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 300 }, () => t.pool.query("update race_probe set status = $2 where id = $1", [id, targets[rnd() % targets.length]])),
    );
    for (const o of outcomes) {
      if (o.status === "rejected") expect(pgCode(o.reason) === "PT001" || /invalid state transition/.test(pgMessage(o.reason))).toBe(true);
    }
    // every recorded transition is a registered rule
    const illegal = await t.pool.query(`
      select h.from_status, h.to_status from race_probe_history h
       where h.entity_id = $1
         and not exists (select 1 from state_transition_rules r where r.machine = 'race'
                         and r.from_status is not distinct from h.from_status and r.to_status = h.to_status)`, [id]);
    expect(illegal.rows).toEqual([]);
    // history chain is contiguous: each row starts where the previous ended
    const chain = (await t.pool.query("select from_status, to_status from race_probe_history where entity_id=$1 order by id", [id])).rows as { from_status: string | null; to_status: string }[];
    for (let i = 1; i < chain.length; i++) expect(chain[i]?.from_status).toBe(chain[i - 1]?.to_status);
    const finalStatus = (await t.pool.query("select status from race_probe where id=$1", [id])).rows[0].status;
    expect(chain[chain.length - 1]?.to_status).toBe(finalStatus);
  });
});
