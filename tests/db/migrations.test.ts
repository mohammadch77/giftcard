import { sql } from "drizzle-orm";
import { pgTable, integer, text } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbMeta } from "@/platform/db/schema";
import { runMigrations } from "@/platform/db/migrate";
import { withTransaction } from "@/platform/db/client";
import { createTestDatabase } from "../helpers/db";
import type { TestDatabase } from "../helpers/db";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.drop();
});

describe("migrations", () => {
  it("apply to a clean database and create the expected objects", async () => {
    const tables = await t.pool.query("select tablename from pg_tables where schemaname='public'");
    expect(tables.rows.map((r: { tablename: string }) => r.tablename)).toContain("db_meta");
    const fn = await t.pool.query("select 1 from pg_proc where proname='platform_reject_mutation'");
    expect(fn.rowCount).toBe(1);
    const ext = await t.pool.query("select 1 from pg_extension where extname='citext'");
    expect(ext.rowCount).toBe(1);
  });

  it("are idempotent: re-running applies nothing new and does not fail", async () => {
    const before = await t.pool.query("select count(*)::int as n from drizzle.__drizzle_migrations");
    await runMigrations(t.url);
    const after = await t.pool.query("select count(*)::int as n from drizzle.__drizzle_migrations");
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(after.rows[0].n).toBe(2);
  });

  it("CHECK constraint from the Drizzle schema is enforced by PostgreSQL", async () => {
    await t.db.insert(dbMeta).values({ key: "ok.key_1", value: "v" });
    await expect(t.db.insert(dbMeta).values({ key: "Bad Key", value: "v" })).rejects.toThrow();
    const rows = await t.db.select().from(dbMeta);
    expect(rows.map((r) => r.key)).toEqual(["ok.key_1"]);
  });
});

describe("custom SQL migration: append-only guard", () => {
  it("platform_reject_mutation blocks UPDATE, DELETE and TRUNCATE on a guarded table", async () => {
    await t.pool.query(`
      create table guarded_probe (id int primary key, v text);
      create trigger probe_rw before update or delete on guarded_probe
        for each row execute function platform_reject_mutation();
      create trigger probe_trunc before truncate on guarded_probe
        for each statement execute function platform_reject_mutation();
      insert into guarded_probe values (1,'a');`);
    await expect(t.pool.query("update guarded_probe set v='b'")).rejects.toThrow(/append-only/);
    await expect(t.pool.query("delete from guarded_probe")).rejects.toThrow(/append-only/);
    await expect(t.pool.query("truncate guarded_probe")).rejects.toThrow(/append-only/);
    const r = await t.pool.query("select v from guarded_probe");
    expect(r.rows[0].v).toBe("a");
  });
});

describe("transaction helper", () => {
  it("commits on success and rolls everything back on error", async () => {
    await withTransaction(t.db, async (tx) => {
      await tx.insert(dbMeta).values({ key: "tx.committed", value: "1" });
    });
    await expect(
      withTransaction(t.db, async (tx) => {
        await tx.insert(dbMeta).values({ key: "tx.rolled_back", value: "1" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const keys = (await t.db.select().from(dbMeta)).map((r) => r.key);
    expect(keys).toContain("tx.committed");
    expect(keys).not.toContain("tx.rolled_back");
  });
});

describe("Drizzle + SKIP LOCKED (verification of decision D2 requirement)", () => {
  const probe = pgTable("skip_probe", { id: integer("id").primaryKey(), label: text("label") });

  it("the query builder emits FOR UPDATE SKIP LOCKED", () => {
    const q = t.db.select().from(probe).where(sql`${probe.label} is null`).limit(1).for("update", { skipLocked: true });
    expect(q.toSQL().sql.toLowerCase()).toContain("for update skip locked");
  });

  it("a second transaction skips a row locked by the first instead of waiting", async () => {
    await t.pool.query("create table skip_probe (id int primary key, label text); insert into skip_probe values (1,null),(2,null)");
    let secondResult: number[] = [];
    await withTransaction(t.db, async (tx1) => {
      const first = await tx1.select().from(probe).orderBy(probe.id).limit(1).for("update", { skipLocked: true });
      expect(first.map((r) => r.id)).toEqual([1]);
      // while tx1 still holds the lock on row 1:
      await withTransaction(t.db, async (tx2) => {
        const second = await tx2.select().from(probe).orderBy(probe.id).limit(1).for("update", { skipLocked: true });
        secondResult = second.map((r) => r.id);
      });
    });
    expect(secondResult).toEqual([2]);
  });
});
