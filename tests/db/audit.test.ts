import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAudit, recordAudit } from "@/modules/audit";
import { withTransaction } from "@/platform/db";
import type { DatabaseHandle } from "@/platform/db";
import { createDatabaseAsRole, createTestDatabase, createTestRoles, pgCode } from "../helpers/db";
import type { TestDatabase } from "../helpers/db";

let t: TestDatabase;
let app: DatabaseHandle;
const at = new Date("2026-01-01T00:00:00Z");
beforeAll(async () => {
  t = await createTestDatabase();
  app = createDatabaseAsRole(t, (await createTestRoles(t)).appRole);
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});
const rec = (over: Record<string, unknown> = {}) =>
  withTransaction(app.db, (tx) => recordAudit(tx, { actor: { type: "ADMIN", id: "a1" }, action: "test.action", entity: { type: "thing", id: "t1" }, occurredAt: at, ...over } as never));
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? "OTHER"; } return "NO_ERROR"; };

describe("audit records", () => {
  it("are stored, filterable and read back in order", async () => {
    await rec({ entity: { type: "thing", id: "e1" }, after: { n: 1 } });
    await rec({ entity: { type: "thing", id: "e1" }, action: "test.second", after: { n: 2 } });
    await rec({ entity: { type: "thing", id: "e2" } });
    const list = await listAudit(app.db, { entityType: "thing", entityId: "e1" });
    expect(list.map((x) => x.action)).toEqual(["test.action", "test.second"]);
    expect((await listAudit(app.db, { action: "test.second" })).length).toBe(1);
    expect((await listAudit(app.db, { actorId: "a1", limit: 2 })).length).toBe(2);
  });
  it("redact secrets before storage (sensitive keys and token-like strings never reach the table)", async () => {
    await rec({ entity: { type: "thing", id: "sec" }, before: { password: "hunter2", note: "Bearer abcdef1234567890" }, after: { token: "tok-123", ok: 1, nested: { pepper: "p" } }, metadata: { apiKey: "k-9" } });
    const text = (await t.pool.query("select (before::text || after::text || metadata::text) as x from audit_logs where entity_id = 'sec'")).rows[0].x as string;
    for (const leak of ["hunter2", "abcdef1234567890", "tok-123", "k-9"]) expect(text).not.toContain(leak);
    expect(text).toContain('"ok": 1');
  });
  it("reject invalid actors, actions, entities and oversized payloads", async () => {
    expect(await code(rec({ actor: { type: "ROBOT", id: "x" } }))).toBe("AUDIT_INVALID");
    expect(await code(rec({ actor: { type: "USER", id: "" } }))).toBe("AUDIT_INVALID");
    expect(await code(rec({ action: "Bad Action" }))).toBe("AUDIT_INVALID");
    expect(await code(rec({ entity: { type: "Bad Type", id: "1" } }))).toBe("AUDIT_INVALID");
    expect(await code(rec({ after: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`field_${i}`, "value-of-moderate-length-0123456789"])) }))).toBe("AUDIT_INVALID");
  });
  it("are written in the caller's transaction: a rollback removes the audit record with the change", async () => {
    await expect(withTransaction(app.db, async (tx) => { await recordAudit(tx, { actor: { type: "SYSTEM", id: "s" }, action: "test.rolled", entity: { type: "thing", id: "rb" }, occurredAt: at }); throw new Error("x"); })).rejects.toThrow();
    expect((await listAudit(app.db, { entityId: "rb" })).length).toBe(0);
  });
  it("can not be changed or removed — not by the application role, and not by the owner", async () => {
    await expect(app.pool.query("update audit_logs set action = 'x.y'")).rejects.toSatisfy((e) => pgCode(e) === "42501");
    await expect(app.pool.query("delete from audit_logs")).rejects.toSatisfy((e) => pgCode(e) === "42501");
    await expect(t.pool.query("update audit_logs set action = 'x.y'")).rejects.toSatisfy((e) => pgCode(e) === "23001");
    await expect(t.pool.query("delete from audit_logs")).rejects.toSatisfy((e) => pgCode(e) === "23001");
    await expect(t.pool.query("truncate audit_logs cascade")).rejects.toSatisfy((e) => pgCode(e) === "23001");
  });
  it("database CHECKs mirror the validation", async () => {
    await expect(t.pool.query("insert into audit_logs (occurred_at, actor_type, actor_id, action, entity_type, entity_id) values (now(),'ROBOT','x','a.b','t','1')")).rejects.toSatisfy((e) => pgCode(e) === "23514");
    await expect(t.pool.query("insert into audit_logs (occurred_at, actor_type, actor_id, action, entity_type, entity_id) values (now(),'USER','x','Bad','t','1')")).rejects.toSatisfy((e) => pgCode(e) === "23514");
  });
});
