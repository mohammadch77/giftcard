import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  availability, consume, expireDueCodes, importCodes, markSold, reserve, runCodeExpiry, setCodeStatus, sweepExpired, verifyInventory, withDeliverySecret,
} from "@/modules/inventory";
import { withTransaction } from "@/platform/db";
import { pgCode } from "../helpers/db";
import { inventoryFixture, invCtx, makeCodes, sellableVariant } from "../helpers/inventory";
import type { InventoryFixture } from "../helpers/inventory";

let f: InventoryFixture;
beforeAll(async () => { f = await inventoryFixture(); });
afterAll(async () => { await f?.app.close(); await f?.t.drop(); });

const BASE = new Date("2026-06-01T10:00:00Z").getTime();
const at = (minutes: number) => new Date(BASE + minutes * 60_000);
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? "OTHER"; } return "NO_ERROR"; };
const sqlCode = (q: string, p: unknown[] = []) => f.t.pool.query(q, p).then(() => "ok", (e: unknown) => pgCode(e));
const appSqlCode = (q: string, p: unknown[] = []) => f.app.pool.query(q, p).then(() => "ok", (e: unknown) => pgCode(e));
let k = 0;
const key = () => `x-${++k}-${Math.random().toString(36).slice(2, 6)}`;
const res = (variantId: string, quantity: number, ttlSeconds?: number) => {
  const reservationKey = key();
  return withTransaction(f.app.db, (tx) => reserve(tx, f.clock, { reservationKey, orderRef: `o-${reservationKey}`, lines: [{ variantId, quantity }], ...(ttlSeconds ? { ttlSeconds } : {}) }));
};
const statuses = async (v: string) => Object.fromEntries((await f.t.pool.query("select status, count(*)::int n from digital_codes where variant_id = $1 group by status", [v])).rows.map((r) => [r.status, r.n]));
const stock = async (v: string) => (await availability(f.app.db, [v], f.clock.now()))[0]!;
const healthy = async () => expect(await verifyInventory(f.app.db), "integrity findings").toEqual([]);
const movements = async (v: string, type: string) => (await f.t.pool.query("select * from inventory_movements where variant_id = $1 and type = $2 order by id", [v, type])).rows;

describe("OPS-2: expiry on import (optional everywhere)", () => {
  it("batch expiry applies to plain codes, a code's own expiry overrides it, codes without any expiry stay NULL, already-expired codes are refused and counted", async () => {
    f.clock.set(at(0));
    const v = await sellableVariant(f);
    const [a, b, c, d, e] = makeCodes(5);
    const r = await importCodes(invCtx(f), v, {
      payloadKind: "CODE", expiresAt: at(120), note: "supplier batch",
      codes: [a!, { code: b!, expiresAt: at(30) }, { code: c!, expiresAt: null }, { code: d!, expiresAt: at(-5) }, e!, "   "],
    });
    expect(r).toMatchObject({ imported: 4, expired: 1, invalid: 1, duplicates: 0 });
    const rows = (await f.t.pool.query("select expires_at from digital_codes where variant_id = $1 order by expires_at nulls last", [v])).rows.map((x) => x.expires_at && x.expires_at.toISOString());
    expect(rows).toEqual([at(30).toISOString(), at(120).toISOString(), at(120).toISOString(), at(120).toISOString()]); // null falls back to the batch expiry; the past one never entered stock
    expect((await f.t.pool.query("select expires_at, code_count from inventory_batches where id = $1", [r.batchId])).rows[0]).toMatchObject({ code_count: 4 });
    expect((await f.t.pool.query("select expires_at from inventory_batches where id = $1", [r.batchId])).rows[0].expires_at.toISOString()).toBe(at(120).toISOString());
    const audit = (await f.t.pool.query("select metadata from audit_logs where action = 'inventory.codes.imported' and entity_id = $1", [r.batchId])).rows[0].metadata;
    expect(audit).toMatchObject({ imported: 4, expired: 1, batchExpiresAt: at(120).toISOString() });
    await healthy();
  });

  it("not every supplier provides expiry: a plain import is unchanged (no expiry anywhere) and such codes are never expired", async () => {
    f.clock.set(at(0));
    const v = await sellableVariant(f);
    const r = await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: makeCodes(3) });
    expect(r).toMatchObject({ imported: 3, expired: 0 });
    expect((await f.t.pool.query("select count(*)::int n from digital_codes where variant_id = $1 and expires_at is null", [v])).rows[0].n).toBe(3);
    f.clock.set(at(60 * 24 * 365));
    expect((await expireDueCodes(f.app.db, f.clock)).byVariant[v]).toBeUndefined(); // (the sweep is global: other tests' variants are not this one's concern)
    expect(await statuses(v)).toEqual({ AVAILABLE: 3 });
    f.clock.set(at(0));
  });

  it("account-type stock carries expiry the same way; bad expiry values are rejected by validation", async () => {
    f.clock.set(at(0));
    const v = await sellableVariant(f);
    expect(await importCodes(invCtx(f), v, { payloadKind: "ACCOUNT", codes: [{ code: "user:pass-1", expiresAt: at(50) }] })).toMatchObject({ imported: 1 });
    expect(await code(importCodes(invCtx(f), v, { payloadKind: "CODE", codes: ["ZZ-1"], expiresAt: "tomorrow" as never }))).toBe("INVENTORY_INVALID");
    expect(await code(importCodes(invCtx(f), v, { payloadKind: "CODE", codes: [{ code: "ZZ-2", expiresAt: 5 as never }] }))).toBe("INVENTORY_INVALID");
  });
});

describe("OPS-2: an expired code is never reserved or sold", () => {
  it("allocation skips codes that would expire before the reservation ends; codes that outlive it (or have no expiry) are used", async () => {
    f.clock.set(at(0)); // default hold = 15 minutes
    const v = await sellableVariant(f);
    const [soon, later, never] = makeCodes(3);
    await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: [{ code: soon!, expiresAt: at(10) }, { code: later!, expiresAt: at(16) }, never!] });
    const r = await res(v, 2);
    expect(r.status).toBe("ACTIVE");
    const held = (await f.t.pool.query("select expires_at from digital_codes where variant_id = $1 and status = 'RESERVED' order by expires_at nulls last", [v])).rows.map((x) => x.expires_at && x.expires_at.toISOString());
    expect(held).toEqual([at(16).toISOString(), null]); // never the one expiring at +10 min
    expect(await code(res(v, 1))).toBe("INVENTORY_INSUFFICIENT"); // only the soon-to-expire code is left
    expect((await statuses(v))).toEqual({ AVAILABLE: 1, RESERVED: 2 });
    await healthy();
  });

  it("a code past its expiry is unavailable and unreservable even BEFORE the sweeper marks it", async () => {
    f.clock.set(at(0));
    const v = await sellableVariant(f);
    await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: [{ code: makeCodes(1)[0]!, expiresAt: at(60) }, makeCodes(1)[0]!] });
    expect((await stock(v)).itemisedAvailable).toBe(2);
    f.clock.set(at(120));
    expect((await stock(v)).itemisedAvailable).toBe(1); // counters follow the clock, not the sweeper
    expect(await code(res(v, 2))).toBe("INVENTORY_INSUFFICIENT");
    expect(await statuses(v)).toEqual({ AVAILABLE: 2 }); // still unmarked
    const run = await expireDueCodes(f.app.db, f.clock);
    expect(run.byVariant[v]).toBe(1);
    expect(await statuses(v)).toEqual({ AVAILABLE: 1, EXPIRED: 1 });
    expect((await stock(v)).itemisedAvailable).toBe(1);
    await healthy();
    f.clock.set(at(0));
  });

  it("the database refuses what the application already avoids: reserving across an expiry, importing an expired code, expiring a live one, editing the expiry", async () => {
    f.clock.set(at(0));
    const v = await sellableVariant(f);
    const [soon, held, live] = makeCodes(3);
    await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: [{ code: soon!, expiresAt: at(10) }, { code: held!, expiresAt: at(60) }, { code: live!, expiresAt: at(90) }] });
    const r = await res(v, 1);
    const soonId = (await f.t.pool.query("select id from digital_codes where variant_id = $1 and expires_at = $2", [v, at(10)])).rows[0].id as string;
    const liveId = (await f.t.pool.query("select id from digital_codes where variant_id = $1 and status = 'AVAILABLE' and expires_at > $2", [v, at(15)])).rows[0].id as string;
    // reserving the +10 min code under a reservation that ends at +15 min
    expect(await sqlCode("update digital_codes set status = 'RESERVED', reservation_id = $1, reserved_until = $2, updated_at = $3 where id = $4", [r.reservationId, r.expiresAt, at(0), soonId])).toBe("PV003");
    // importing an already-expired code
    const batch = (await f.t.pool.query("select batch_id from digital_codes where id = $1", [soonId])).rows[0].batch_id;
    expect(await sqlCode(
      `insert into digital_codes (id, variant_id, batch_id, code_fp, hmac_version, sealed, payload_kind, status, expires_at, created_at, updated_at)
       values (gen_random_uuid(), $1, $2, decode(md5(random()::text) || md5(random()::text), 'hex'), 1, decode('00', 'hex'), 'CODE', 'AVAILABLE', $3, $4, $4)`, [v, batch, at(-1), at(0)],
    )).toBe("PV003");
    // marking a still-valid code EXPIRED
    expect(await sqlCode("update digital_codes set status = 'EXPIRED', updated_at = $2 where id = $1", [liveId, at(30)])).toBe("PV003");
    // the expiry is frozen
    expect(await sqlCode("update digital_codes set expires_at = $2 where id = $1", [liveId, at(9999)])).toBe("PI001");
    expect(await appSqlCode("update digital_codes set expires_at = null where id = $1", [liveId])).toBe("42501");
    // EXPIRED needs an expiry (check constraint) and is terminal (state machine)
    f.clock.set(at(100));
    await expireDueCodes(f.app.db, f.clock);
    expect((await f.t.pool.query("select status from digital_codes where id = $1", [liveId])).rows[0].status).toBe("EXPIRED");
    expect(await sqlCode("update digital_codes set status = 'AVAILABLE', updated_at = $2 where id = $1", [liveId, at(100)])).toBe("PT001");
    expect(await sqlCode("update digital_codes set status = 'VOID', updated_at = $2 where id = $1", [liveId, at(100)])).toBe("PT001");
    expect(await code(setCodeStatus(invCtx(f), liveId, "AVAILABLE", "bring it back please"))).toBe("INVENTORY_INVALID");
    expect(await code(setCodeStatus(invCtx(f), liveId, "VOID", "void an expired code"))).toBe("INVENTORY_INVALID");
    f.clock.set(at(0));
  });
});

describe("OPS-2: the expiry sweeper", () => {
  it("marks due AVAILABLE and QUARANTINED codes EXPIRED with exact movements, counters, audit and idempotence; never deletes", async () => {
    f.clock.set(at(0));
    const v = await sellableVariant(f);
    const codes = makeCodes(6);
    await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: [{ code: codes[0]!, expiresAt: at(10) }, { code: codes[1]!, expiresAt: at(10) }, { code: codes[2]!, expiresAt: at(10) }, { code: codes[3]!, expiresAt: at(500) }, codes[4]!, codes[5]!] });
    const quarantineId = (await f.t.pool.query("select id from digital_codes where variant_id = $1 and expires_at = $2 order by id limit 1", [v, at(10)])).rows[0].id as string;
    await setCodeStatus(invCtx(f), quarantineId, "QUARANTINED", "supplier asked to hold this code");
    expect(await statuses(v)).toEqual({ AVAILABLE: 5, QUARANTINED: 1 });
    const total = Number((await f.t.pool.query("select count(*) n from digital_codes")).rows[0].n);

    f.clock.set(at(11));
    const run = await expireDueCodes(f.app.db, f.clock);
    expect(run).toEqual({ expired: 3, byVariant: { [v]: 3 } });
    expect(await statuses(v)).toEqual({ AVAILABLE: 3, EXPIRED: 3 });
    const moves = await movements(v, "CODE_EXPIRE");
    expect(moves.map((m) => m.qty_delta).sort()).toEqual([-1, -1, 0]); // the quarantined one already left the available pool
    expect(moves.every((m) => m.actor === "worker:inventory-expiry" && m.reason === "supplier expiry reached")).toBe(true);
    expect((await stock(v)).itemisedAvailable).toBe(3);
    expect(Number((await f.t.pool.query("select count(*) n from digital_codes")).rows[0].n)).toBe(total); // nothing deleted
    const audit = (await f.t.pool.query("select actor_type, actor_id, metadata from audit_logs where action = 'inventory.codes.expired' order by id desc limit 1")).rows[0];
    expect(audit).toMatchObject({ actor_type: "SYSTEM", actor_id: "worker:inventory-expiry", metadata: { expired: 3, byVariant: { [v]: 3 } } });
    await healthy();
    // idempotent: nothing left to do, nothing written
    const auditsBefore = Number((await f.t.pool.query("select count(*) n from audit_logs where action = 'inventory.codes.expired'")).rows[0].n);
    expect(await expireDueCodes(f.app.db, f.clock)).toEqual({ expired: 0, byVariant: {} });
    expect(Number((await f.t.pool.query("select count(*) n from audit_logs where action = 'inventory.codes.expired'")).rows[0].n)).toBe(auditsBefore);
    f.clock.set(at(0));
  });

  it("works in bounded batches (oldest expiry first) and an administrator can run it with permission, attributed to them", async () => {
    f.clock.set(at(0));
    const v = await sellableVariant(f);
    await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: makeCodes(5).map((c, i) => ({ code: c, expiresAt: at(10 + i) })) });
    f.clock.set(at(60));
    expect((await expireDueCodes(f.app.db, f.clock, { batchSize: 2 })).expired).toBe(2);
    expect((await expireDueCodes(f.app.db, f.clock, { batchSize: 2 })).expired).toBe(2);
    expect(await code(runCodeExpiry(invCtx(f, ["inventory.stock.read"])))).toBe("AUTH_FORBIDDEN");
    expect(await runCodeExpiry(invCtx(f, "all", "admin-9"))).toMatchObject({ expired: 1 });
    expect((await f.t.pool.query("select actor_id from audit_logs where action = 'inventory.codes.expired' order by id desc limit 1")).rows[0].actor_id).toBe("admin-9");
    expect(await statuses(v)).toEqual({ EXPIRED: 5 });
    await healthy();
    f.clock.set(at(0));
  });

  it("a RESERVED code is not touched by the sweeper; once its lapsed reservation is released the code expires normally", async () => {
    f.clock.set(at(0));
    const v = await sellableVariant(f);
    await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: [{ code: makeCodes(1)[0]!, expiresAt: at(16) }] });
    await res(v, 1); // hold ends at +15, the code expires at +16 (allowed)
    f.clock.set(at(17)); // hold lapsed (not yet swept), code expired
    expect((await expireDueCodes(f.app.db, f.clock)).byVariant[v]).toBeUndefined();
    expect(await statuses(v)).toEqual({ RESERVED: 1 });
    expect(await sweepExpired(f.app.db, f.clock)).toBeGreaterThanOrEqual(1); // reservations sweeper returns the code to the pool
    expect(await statuses(v)).toEqual({ AVAILABLE: 1 });
    expect((await stock(v)).itemisedAvailable).toBe(0); // expired, so not available even before it is marked
    expect((await expireDueCodes(f.app.db, f.clock)).byVariant[v]).toBe(1);
    expect(await statuses(v)).toEqual({ EXPIRED: 1 });
    await healthy();
    f.clock.set(at(0));
  });
});

describe("OPS-2: codes that expire after being sold", () => {
  it("stay SOLD and deliverable: the sweeper never touches them, the sale cannot be undone by expiry, and a late delivery job still works", async () => {
    f.clock.set(at(0));
    const v = await sellableVariant(f);
    const plain = makeCodes(1)[0]!;
    await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: [{ code: plain, expiresAt: at(16) }] });
    const r = await res(v, 1);
    f.clock.set(at(5));
    expect(await withTransaction(f.app.db, (tx) => consume(tx, f.clock, r.reservationId))).toMatchObject({ outcome: "CONSUMED" }); // payment verified in time
    // the delivery job runs LATE: after the reservation window and after the code's expiry — the sale decision was the payment
    f.clock.set(at(30));
    await withTransaction(f.app.db, (tx) => markSold(tx, f.clock, { reservationId: r.reservationId, assignments: [{ variantId: v, orderItemRef: `item-${key()}#1` }] }));
    expect(await statuses(v)).toEqual({ SOLD: 1 });
    f.clock.set(at(600));
    expect((await expireDueCodes(f.app.db, f.clock)).byVariant[v]).toBeUndefined();
    expect(await statuses(v)).toEqual({ SOLD: 1 });
    const sold = (await f.t.pool.query("select id, order_item_ref from digital_codes where variant_id = $1", [v])).rows[0];
    let seen = "";
    await withDeliverySecret(f.app.db, f.keys, f.clock, { codeId: sold.id, orderItemRef: sold.order_item_ref, requestedBy: "customer", purpose: "reveal" }, (p) => { seen = p.toString(); });
    expect(seen.replace(/[-\s]/g, "").toUpperCase()).toBe(plain.replace(/[-\s]/g, "").toUpperCase());
    // expiry cannot rewrite a sold code (SOLD may still only move to VOID, which this process never does)
    expect(await sqlCode("update digital_codes set status = 'EXPIRED', updated_at = $2 where id = $1", [sold.id, at(600)])).toBe("PV002");
    await healthy();
    f.clock.set(at(0));
  });

  it("a code that had ALREADY expired when its reservation was consumed can never be sold (database guard)", async () => {
    f.clock.set(at(0));
    const v = await sellableVariant(f);
    await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: [{ code: makeCodes(1)[0]!, expiresAt: at(16) }] });
    const r = await res(v, 1);
    const id = (await f.t.pool.query("select id from digital_codes where variant_id = $1", [v])).rows[0].id as string;
    // a reservation consumed at +5 min, then (hypothetically) a code whose expiry precedes that moment
    f.clock.set(at(5));
    await withTransaction(f.app.db, (tx) => consume(tx, f.clock, r.reservationId));
    const c = await f.t.pool.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica"); // only to forge the impossible premise (expiry earlier than the consumption)
      await c.query("update digital_codes set expires_at = $2 where id = $1", [id, at(1)]);
      await c.query("set local session_replication_role = origin");
      const e = await c.query("update digital_codes set status = 'SOLD', order_item_ref = 'forged#1', sold_at = $2, updated_at = $2 where id = $1", [id, at(6)]).then(() => "ok", (x: unknown) => pgCode(x));
      expect(e).toBe("PV003");
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});

describe("OPS-2: retention and invariants", () => {
  it("EXPIRED codes are retained forever (no deletion path), their fingerprint still blocks re-import, and the integrity report stays clean", async () => {
    f.clock.set(at(0));
    const v = await sellableVariant(f);
    const [c1] = makeCodes(1);
    await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: [{ code: c1!, expiresAt: at(10) }] });
    f.clock.set(at(20));
    await expireDueCodes(f.app.db, f.clock);
    expect(await appSqlCode("delete from digital_codes")).toBe("42501");
    // re-importing the same code (e.g. a re-issued supplier code) is a duplicate — see OPEN_QUESTIONS OPS-2b
    expect(await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: [{ code: c1!, expiresAt: at(9000) }] })).toMatchObject({ imported: 0, duplicates: 1 });
    expect(await statuses(v)).toEqual({ EXPIRED: 1 });
    expect(await appSqlCode("update inventory_movements set qty_delta = 0")).toBe("42501");
    await healthy();
    f.clock.set(at(0));
  });

  it("the integrity report detects a forged state (reserved across its expiry) — the safety net itself works", async () => {
    f.clock.set(at(0));
    const v = await sellableVariant(f);
    await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: [{ code: makeCodes(1)[0]!, expiresAt: at(40) }] });
    await res(v, 1);
    const forge = async (to: Date) => {
      const c = await f.t.pool.connect();
      try {
        await c.query("begin");
        await c.query("set local session_replication_role = replica"); // only to forge the impossible premise
        await c.query("update digital_codes set expires_at = $2 where variant_id = $1", [v, to]);
        await c.query("commit");
      } finally {
        c.release();
      }
    };
    await forge(at(5));
    try {
      expect((await verifyInventory(f.app.db)).map((x) => x.check)).toContain("code_reserved_or_sold_past_its_expiry");
    } finally {
      await forge(at(40));
    }
    await healthy();
  });
});
