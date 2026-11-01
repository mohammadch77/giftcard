import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, createTestRoles, pgCode } from "../helpers/db";
import type { TestDatabase, TestRoles } from "../helpers/db";

let t: TestDatabase;
let roles: TestRoles;
beforeAll(async () => {
  t = await createTestDatabase();
  roles = await createTestRoles(t);
});
afterAll(async () => {
  await t?.drop();
});

const asApp = <T>(fn: Parameters<typeof asRole<T>>[2]) => asRole(t, roles.appRole, fn);
const asRo = <T>(fn: Parameters<typeof asRole<T>>[2]) => asRole(t, roles.readonlyRole, fn);
const denied = (e: unknown) => pgCode(e) === "42501";

describe("grant registry", () => {
  it("every table in the public schema is registered with a grant mode (a new unregistered table fails this test)", async () => {
    const unregistered = await t.pool.query(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','p')
         and 'public.' || c.relname not in (select table_name from platform_grant_registry)
         and c.relname not in (select table_name from platform_grant_registry)`);
    expect(unregistered.rows).toEqual([]);
  });
  it("platform_apply_grants is idempotent and restores revoked privileges", async () => {
    const n1 = (await t.pool.query("select platform_apply_grants() n")).rows[0].n as number;
    const n2 = (await t.pool.query("select platform_apply_grants() n")).rows[0].n as number;
    expect(n1).toBe(n2);
    expect(n1).toBeGreaterThanOrEqual(6);
    await t.pool.query(`revoke all on db_meta from "${roles.appRole}"`);
    await expect(asApp((c) => c.query("select * from db_meta"))).rejects.toSatisfy(denied);
    await t.pool.query("select platform_apply_grants()");
    await asApp((c) => c.query("select * from db_meta"));
  });
});

describe("application role (giftcard_app) — least privilege", () => {
  it("can enqueue/claim outbox events and use idempotency keys (identity columns need no sequence grant)", async () => {
    await asApp(async (c) => {
      await c.query("insert into outbox_events (event_type, aggregate_type, aggregate_id, payload) values ('probe.x','probe','1','{}')");
      const r = await c.query("select * from outbox_claim('w', 5, interval '60 seconds', now() + interval '1 second')");
      expect(r.rows.length).toBe(1);
      await c.query("begin");
      await c.query("insert into idempotency_keys (scope, key, request_hash) values ('probe.s','key-12345678',$1)", ["a".repeat(64)]);
      await c.query("update idempotency_keys set response = '{}'::jsonb where key = 'key-12345678'");
      await c.query("commit");
    });
  });
  it("cannot UPDATE columns it was not granted, DELETE, or TRUNCATE evidence tables", async () => {
    await asApp(async (c) => {
      await expect(c.query("update idempotency_keys set request_hash = $1", ["b".repeat(64)])).rejects.toSatisfy(denied);
      await expect(c.query("update outbox_events set payload = '{}'::jsonb")).rejects.toSatisfy(denied);
      await expect(c.query("delete from outbox_events")).rejects.toSatisfy(denied);
      await expect(c.query("delete from idempotency_keys")).rejects.toSatisfy(denied);
      await expect(c.query("truncate outbox_events")).rejects.toSatisfy(denied);
      await expect(c.query("truncate idempotency_keys")).rejects.toSatisfy(denied);
    });
  });
  it("cannot change rules, roles or the grant registry (read-only reference data)", async () => {
    await asApp(async (c) => {
      await c.query("select count(*) from state_transition_rules");
      await expect(c.query("insert into state_transition_rules (machine, from_status, to_status) values ('evil', null, 'X')")).rejects.toSatisfy(denied);
      await expect(c.query("delete from state_transition_rules")).rejects.toSatisfy(denied);
      await expect(c.query("update platform_roles set app_role = 'x'")).rejects.toSatisfy(denied);
      await expect(c.query("insert into platform_grant_registry values ('x','read_write_delete',null)")).rejects.toSatisfy(denied);
    });
  });
  it("cannot run administrative functions, create objects, or read the migration journal", async () => {
    await asApp(async (c) => {
      await expect(c.query("select platform_apply_grants()")).rejects.toSatisfy(denied);
      await expect(c.query("select platform_register_grants('db_meta','read_write_delete')")).rejects.toSatisfy(denied);
      await expect(c.query("select platform_attach_transition_guard('db_meta','m')")).rejects.toSatisfy(denied);
      await expect(c.query("create table hacked (id int)")).rejects.toSatisfy(denied);
      await expect(c.query("select * from drizzle.__drizzle_migrations")).rejects.toSatisfy(denied);
    });
  });
  it("is neither superuser nor able to bypass triggers", async () => {
    await asApp(async (c) => {
      const r = await c.query("select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls from pg_roles where rolname = current_user");
      expect(r.rows[0]).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false });
      await expect(c.query("set session_replication_role = replica")).rejects.toSatisfy(denied);
    });
  });
});

describe("read-only role", () => {
  it("can read everything registered, and write nothing", async () => {
    await asRo(async (c) => {
      await c.query("select * from outbox_events");
      await c.query("select * from idempotency_keys");
      await expect(c.query("insert into db_meta (key, value) values ('a','b')")).rejects.toSatisfy(denied);
      await expect(c.query("update outbox_events set status = 'DEAD'")).rejects.toSatisfy(denied);
      await expect(c.query("delete from db_meta")).rejects.toSatisfy(denied);
    });
  });
});

describe("registering a new table", () => {
  it("modes grant exactly what they promise; TRUNCATE is never granted", async () => {
    await t.pool.query(`
      create table m_ro (id int primary key); create table m_rw (id int primary key, v int);
      create table m_rwd (id int primary key); create table m_ao (id int primary key, a int, b int);
      select platform_register_grants('m_ro','read_only');
      select platform_register_grants('m_rw','read_write');
      select platform_register_grants('m_rwd','read_write_delete');
      select platform_register_grants('m_ao','append_only', array['a']);
      insert into m_rw values (1,1); insert into m_rwd values (1); insert into m_ao values (1,1,1);`);
    await asApp(async (c) => {
      await expect(c.query("insert into m_ro values (1)")).rejects.toSatisfy(denied);
      await c.query("update m_rw set v = 2"); await expect(c.query("delete from m_rw")).rejects.toSatisfy(denied);
      await c.query("delete from m_rwd");
      await c.query("update m_ao set a = 5"); await expect(c.query("update m_ao set b = 5")).rejects.toSatisfy(denied);
      for (const tbl of ["m_rw", "m_rwd", "m_ao"]) await expect(c.query(`truncate ${tbl}`)).rejects.toSatisfy(denied);
    });
  });
  it("rejects update columns for non-append-only modes", async () => {
    await t.pool.query("create table m_bad (id int)");
    await expect(t.pool.query("select platform_register_grants('m_bad','read_write', array['id'])")).rejects.toThrow(/only allowed for append_only/);
  });
});
