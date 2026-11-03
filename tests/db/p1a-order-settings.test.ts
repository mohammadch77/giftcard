import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkout, confirmGatewayPayment, getOrderSettings, getOrderSettingsAdmin, setReservationTtl } from "@/modules/orders";
import type { OrderSettingsAdmin } from "@/modules/orders";
import { DomainError } from "@/platform/errors";
import { pgCode } from "../helpers/db";
import { gatewayCheckout, orderFixture, ordersDeps, stockedVariant, userId } from "../helpers/orders";
import type { OrderFixture } from "../helpers/orders";

let f: OrderFixture;
beforeAll(async () => { f = await orderFixture(); });
afterAll(async () => { await f?.app.close(); await f?.t.drop(); });

const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? "OTHER"; } return "NO_ERROR"; };
const q = async <T = Record<string, unknown>>(s: string, p: unknown[] = []) => (await f.t.pool.query(s, p)).rows as T[];
const appSql = (s: string, p: unknown[] = []) => f.app.pool.query(s, p).then(() => "ok", (e: unknown) => pgCode(e));
const ownerSql = (s: string, p: unknown[] = []) => f.t.pool.query(s, p).then(() => "ok", (e: unknown) => pgCode(e));
const versions = async () => Number((await q("select count(*)::int c from order_settings_versions"))[0]!.c);
const ctx = (actorId: string, allowed: "all" | string[] = "all"): OrderSettingsAdmin => ({
  db: f.app.db, clock: f.clock, actor: { type: "ADMIN", id: actorId },
  authorize: async (p) => { if (allowed !== "all" && !allowed.includes(p)) throw new DomainError("AUTH_FORBIDDEN", "not permitted"); },
});

describe("B3 reservation TTL — module-owned, versioned, audited setting (ADM-1)", () => {
  it("version 1 is the owner-approved 900 s, written by the migration as data", async () => {
    expect(await getOrderSettings(f.app.db)).toEqual({ version: 1, values: { reservationTtlSeconds: 900 }, source: "SEED" });
    const rows = await q("select * from order_settings_versions order by version");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 1, reservation_ttl_seconds: 900, source: "SEED", previous_version: null });
  });

  it("requires the permission: without it nothing is written (reading needs its own permission)", async () => {
    const before = await versions();
    expect(await code(setReservationTtl(ctx("a", []), { reservationTtlSeconds: 600, reason: "should not be written" }))).toBe("AUTH_FORBIDDEN");
    expect(await code(setReservationTtl(ctx("a", ["orders.settings.read"]), { reservationTtlSeconds: 600, reason: "should not be written" }))).toBe("AUTH_FORBIDDEN");
    expect(await code(getOrderSettingsAdmin({ db: f.app.db, authorize: ctx("a", []).authorize }))).toBe("AUTH_FORBIDDEN");
    expect((await getOrderSettingsAdmin({ db: f.app.db, authorize: ctx("a", ["orders.settings.read"]).authorize })).version).toBe(1);
    expect(await versions()).toBe(before);
  });

  it("validates type, bounds, reason and no-ops on the server — and writes nothing on failure", async () => {
    const before = await versions();
    const reason = "valid reason text";
    for (const bad of [0, 59, 3601, -900, 90.5, Number.NaN, Number.POSITIVE_INFINITY, "900" as unknown as number, null as unknown as number]) {
      expect(await code(setReservationTtl(ctx("a"), { reservationTtlSeconds: bad, reason })), String(bad)).toBe("SETTINGS_INVALID");
    }
    for (const bad of ["", "short", "   x   ", "x".repeat(501), undefined as unknown as string]) {
      expect(await code(setReservationTtl(ctx("a"), { reservationTtlSeconds: 600, reason: bad })), String(bad).slice(0, 12)).toBe("SETTINGS_INVALID");
    }
    expect(await code(setReservationTtl(ctx("a"), { reservationTtlSeconds: 900, reason }))).toBe("SETTINGS_INVALID"); // unchanged value
    expect(await versions()).toBe(before);
  });

  it("a change creates the next version with actor, reason and previous version, and audits old → new in the same transaction", async () => {
    const r = await setReservationTtl(ctx("admin-ttl-1"), { reservationTtlSeconds: 1200, reason: "  longer hold for the launch window  " });
    expect(r).toEqual({ version: 2, previousVersion: 1 });
    expect(await getOrderSettings(f.app.db)).toMatchObject({ version: 2, values: { reservationTtlSeconds: 1200 }, source: "ADMIN" });
    const row = (await q("select * from order_settings_versions where version = 2"))[0]!;
    expect(row).toMatchObject({ reservation_ttl_seconds: 1200, previous_version: 1, changed_by: "admin-ttl-1", reason: "longer hold for the launch window", source: "ADMIN" });
    const audit = (await q("select * from audit_logs where action = 'orders.settings.reservation_ttl_changed' order by id desc limit 1"))[0]!;
    expect(audit).toMatchObject({ actor_id: "admin-ttl-1", actor_type: "ADMIN", entity_type: "order_settings", entity_id: row.id });
    expect(audit.before).toEqual({ version: 1, reservationTtlSeconds: 900 });
    expect(audit.after).toEqual({ version: 2, reservationTtlSeconds: 1200 });
    expect(audit.metadata).toEqual({ reason: "longer hold for the launch window" });
  });

  it("the audit record and the setting commit or fail TOGETHER (a failing audit rolls the version back)", async () => {
    const before = await versions();
    const auditBefore = Number((await q("select count(*)::int c from audit_logs"))[0]!.c);
    const bad = ctx("admin-x");
    // An actor id longer than the audit table allows makes recordAudit fail AFTER the version row was inserted in the same transaction.
    bad.actor = { type: "ADMIN", id: "x".repeat(300) };
    expect(await code(setReservationTtl(bad, { reservationTtlSeconds: 1500, reason: "audit failure must roll back" }))).not.toBe("NO_ERROR");
    expect(await versions()).toBe(before);
    expect(Number((await q("select count(*)::int c from audit_logs"))[0]!.c)).toBe(auditBefore);
    expect((await getOrderSettings(f.app.db)).version).toBe(2);
  });

  it("the table is append-only for everyone and its bounds hold in the database too", async () => {
    expect(await appSql("update order_settings_versions set reservation_ttl_seconds = 61")).toBe("42501");
    expect(await appSql("delete from order_settings_versions")).toBe("42501");
    expect(await appSql("truncate order_settings_versions")).toBe("42501");
    expect(await ownerSql("update order_settings_versions set reservation_ttl_seconds = 61")).not.toBe("ok"); // trigger rejects even the owner
    expect(await ownerSql("delete from order_settings_versions where version = 1")).not.toBe("ok");
    const ins = (ttl: number, version: number, prev: number | null) =>
      ownerSql(`insert into order_settings_versions (id, version, reservation_ttl_seconds, source, previous_version, changed_by, reason, created_at) values (gen_random_uuid(), $1, $2, 'ADMIN', $3, 'x', 'direct insert test', now())`, [version, ttl, prev]);
    expect(await ins(59, 3, 2)).toBe("23514");
    expect(await ins(3601, 3, 2)).toBe("23514");
    expect(await ins(600, 5, 4)).toBe("23503"); // no gaps: the previous version must exist
    expect(await ins(600, 3, 1)).toBe("23514");
    expect(await ownerSql(`insert into order_settings_versions (id, version, reservation_ttl_seconds, source, previous_version, changed_by, reason, created_at) values (gen_random_uuid(), 3, 600, 'ADMIN', 2, 'x', 'short', now())`)).toBe("23514"); // reason too short
  });

  it("fails closed when no valid version can be read (checkout would be refused)", async () => {
    const c = await f.t.pool.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica"); // lets the owner bypass the append-only trigger inside a transaction that is rolled back
      await c.query("delete from order_settings_versions");
      expect(await code(getOrderSettings(drizzle(c) as never))).toBe("ORDER_RESERVATION_TTL_NOT_CONFIGURED");
    } finally {
      await c.query("rollback");
      c.release();
    }
    expect((await getOrderSettings(f.app.db)).version).toBe(2);
  });
});

describe("a TTL change never touches existing orders or reservations (D9 preserved)", () => {
  it("existing order keeps its expiry and snapshot; new orders use the new TTL; a payment after the OLD expiry is LATE even though the new TTL would still cover it", async () => {
    await setReservationTtl(ctx("admin-ttl-2"), { reservationTtlSeconds: 900, reason: "back to the approved default" });
    const { variantId } = await stockedVariant(f, 6);
    const a = await gatewayCheckout(f, userId(), [{ variantId, quantity: 1 }]);
    const resA = (await q<{ expires_at: Date; created_at: Date }>("select r.expires_at, r.created_at from inventory_reservations r join orders o on o.reservation_id = r.id where o.id = $1", [a.orderId]))[0]!;
    expect(resA.expires_at.getTime() - resA.created_at.getTime()).toBe(900_000);

    const changed = await setReservationTtl(ctx("admin-ttl-3"), { reservationTtlSeconds: 3600, reason: "longer hold applies to future orders only" });
    const b = await gatewayCheckout(f, userId(), [{ variantId, quantity: 1 }]);

    const rowA = (await q<{ expires_at: Date; created_at: Date; policy_snapshot: Record<string, unknown> }>("select expires_at, created_at, policy_snapshot from orders where id = $1", [a.orderId]))[0]!;
    const rowB = (await q<{ expires_at: Date; created_at: Date; policy_snapshot: Record<string, unknown> }>("select expires_at, created_at, policy_snapshot from orders where id = $1", [b.orderId]))[0]!;
    expect(rowA.expires_at.getTime() - rowA.created_at.getTime()).toBe(900_000); // unchanged by the setting change
    expect(rowA.policy_snapshot).toMatchObject({ reservationTtlSeconds: 900, orderSettingsVersion: changed.version - 1 });
    expect(rowB.expires_at.getTime() - rowB.created_at.getTime()).toBe(3_600_000);
    expect(rowB.policy_snapshot).toMatchObject({ reservationTtlSeconds: 3600, orderSettingsVersion: changed.version });
    const resB = (await q<{ expires_at: Date; created_at: Date }>("select r.expires_at, r.created_at from inventory_reservations r join orders o on o.reservation_id = r.id where o.id = $1", [b.orderId]))[0]!;
    expect(resB.expires_at.getTime()).toBe(rowB.expires_at.getTime());

    f.clock.advance(901_000); // past A's 900 s, well inside B's 3600 s
    f.gateway.script(a.gatewayRef, { status: "PAID", amount: a.total });
    expect(await confirmGatewayPayment(ordersDeps(f), { gatewayRef: a.gatewayRef, eventKey: "p1a-late-a" })).toMatchObject({ outcome: "SUCCEEDED" });
    const afterA = (await q<{ status: string }>("select status from orders where id = $1", [a.orderId]))[0]!;
    expect(afterA.status).toBe("ON_HOLD");
    expect(await q("select 1 from order_holds where order_id = $1 and reason = 'LATE_PAYMENT_NO_RESERVATION' and resolved_at is null", [a.orderId])).toHaveLength(1);
    const resStatus = (await q<{ status: string }>("select r.status from inventory_reservations r join orders o on o.reservation_id = r.id where o.id = $1", [a.orderId]))[0]!;
    expect(resStatus.status).not.toBe("CONSUMED"); // an expired reservation is NEVER consumed
    expect(await q("select 1 from fulfillment_tasks where order_ref = $1", [a.orderId])).toHaveLength(0);

    f.gateway.script(b.gatewayRef, { status: "PAID", amount: b.total });
    await confirmGatewayPayment(ordersDeps(f), { gatewayRef: b.gatewayRef, eventKey: "p1a-ok-b" });
    expect((await q<{ status: string }>("select status from orders where id = $1", [b.orderId]))[0]!.status).not.toBe("ON_HOLD");
  });

  it("checkout reads the setting inside its transaction: a TTL the database would reject can never reach a reservation", async () => {
    const { variantId } = await stockedVariant(f, 1);
    const r = await checkout(ordersDeps(f), { userId: userId(), paymentMethod: "GATEWAY", idempotencyKey: `k-${Math.random()}`, lines: [{ variantId, quantity: 1 }] });
    const snap = (await q<{ policy_snapshot: { reservationTtlSeconds: number } }>("select policy_snapshot from orders where id = $1", [r.orderId]))[0]!.policy_snapshot;
    expect(snap.reservationTtlSeconds).toBe((await getOrderSettings(f.app.db)).values.reservationTtlSeconds);
  });
});
