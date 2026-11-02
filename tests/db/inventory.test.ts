import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adjustStock, availability, consume, getStock, importCodes, markSold, release, reserve, setCodeStatus, sweepExpired, verifyInventory, withDeliverySecret,
} from "@/modules/inventory";
import { ManualClock } from "@/platform/clock/testing";
import { NullKeyProvider } from "@/platform/crypto";
import { withTransaction } from "@/platform/db";
import { pgCode } from "../helpers/db";
import { inventoryFixture, invCtx, makeCodes, sellableVariant } from "../helpers/inventory";
import type { InventoryFixture } from "../helpers/inventory";

let f: InventoryFixture;
beforeAll(async () => {
  f = await inventoryFixture();
});
afterAll(async () => {
  await f?.app.close();
  await f?.t.drop();
});

const ic = () => invCtx(f);
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? "OTHER"; } return "NO_ERROR"; };
const sqlCode = (q: string, p: unknown[] = []) => f.t.pool.query(q, p).then(() => "ok", (e: unknown) => pgCode(e));
let k = 0;
const key = () => `key-${++k}-${Math.random().toString(36).slice(2, 6)}`;
const res = (variantId: string, quantity: number, reservationKey = key(), ttlSeconds?: number) =>
  withTransaction(f.app.db, (tx) => reserve(tx, f.clock, { reservationKey, orderRef: `order-${reservationKey}`, lines: [{ variantId, quantity }], ...(ttlSeconds ? { ttlSeconds } : {}) }));
const stock = async (v: string) => (await availability(f.app.db, [v]))[0]!;
const healthy = async () => expect(await verifyInventory(f.app.db)).toEqual([]);

describe("import and secret storage", () => {
  it("imports codes sealed + fingerprinted; counts duplicates/invalid; plaintext appears in no table, audit, movement or result", async () => {
    const v = await sellableVariant(f);
    const codes = makeCodes(5);
    const input = [...codes, codes[0]!, "   ", "x".repeat(5000)];
    const r = await importCodes(ic(), v, { payloadKind: "CODE", codes: input, note: "first batch" });
    expect(r).toMatchObject({ imported: 5, duplicates: 1, invalid: 2 });
    expect(JSON.stringify(r)).not.toContain(codes[1]!);
    expect((await stock(v)).itemisedAvailable).toBe(5);
    const dump = ["digital_codes", "inventory_batches", "inventory_movements", "audit_logs"].map(async (t) => JSON.stringify((await f.t.pool.query(`select * from ${t}`)).rows));
    const text = (await Promise.all(dump)).join("");
    for (const c of codes) expect(text).not.toContain(c);
    const row = (await f.t.pool.query("select sealed, code_fp from digital_codes where variant_id = $1 limit 1", [v])).rows[0];
    expect(row.sealed.length).toBeGreaterThan(60);
    expect(row.code_fp.length).toBe(32);
    const audit = (await f.t.pool.query("select actor_id, metadata from audit_logs where action = 'inventory.codes.imported' order by id desc limit 1")).rows[0];
    expect(audit).toMatchObject({ actor_id: "admin-1", metadata: { imported: 5, duplicates: 1, invalid: 2 } });
  });
  it("duplicates are detected across variants, batches and pepper rotation; error text never carries a code", async () => {
    const a = await sellableVariant(f), b = await sellableVariant(f);
    const [x, y] = makeCodes(2);
    await importCodes(ic(), a, { payloadKind: "CODE", codes: [x!, y!] });
    expect(await importCodes(ic(), b, { payloadKind: "CODE", codes: [x!, "  " + y! + " "] })).toMatchObject({ imported: 0, duplicates: 2 });
  });
  it("rotation of the HMAC pepper does not hide an existing code", async () => {
    const v = await sellableVariant(f);
    const [x] = makeCodes(1);
    await importCodes(ic(), v, { payloadKind: "CODE", codes: [x!] });
    const rotated = invCtx(f, "all", "admin-1", f.keys.withRotation({ newPepper: true }));
    expect(await importCodes(rotated, v, { payloadKind: "CODE", codes: [x!] })).toMatchObject({ imported: 0, duplicates: 1 });
  });
  it("only AUTO_CODE variants accept codes; invalid input errors never echo values; no KeyProvider = fail closed with no writes", async () => {
    const manual = await sellableVariant(f, "MANUAL");
    expect(await code(importCodes(ic(), manual, { payloadKind: "CODE", codes: ["A-1"] }))).toBe("INVENTORY_INVALID");
    const v = await sellableVariant(f);
    const err = await importCodes(ic(), v, { payloadKind: "CODE", codes: [12345 as unknown as string] }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain("12345");
    const before = (await f.t.pool.query("select (select count(*) from digital_codes)::int c, (select count(*) from inventory_batches)::int b")).rows[0];
    expect(await code(importCodes(invCtx(f, "all", "admin-1", new NullKeyProvider() as never), v, { payloadKind: "CODE", codes: makeCodes(2) }))).toBe("KEY_PROVIDER_NOT_CONFIGURED");
    expect((await f.t.pool.query("select (select count(*) from digital_codes)::int c, (select count(*) from inventory_batches)::int b")).rows[0]).toEqual(before);
  });
  it("import needs inventory.codes.import and writes nothing without it", async () => {
    const v = await sellableVariant(f);
    expect(await code(importCodes(invCtx(f, []), v, { payloadKind: "CODE", codes: makeCodes(1) }))).toBe("AUTH_FORBIDDEN");
    expect((await stock(v)).itemisedAvailable).toBe(0);
  });
});

describe("reservation", () => {
  it("reserves all-or-nothing, records movements, and a shortage leaves the caller's transaction usable", async () => {
    const v = await sellableVariant(f);
    await importCodes(ic(), v, { payloadKind: "CODE", codes: makeCodes(5) });
    const r = await res(v, 3);
    expect(r).toMatchObject({ status: "ACTIVE", replay: false });
    expect(await stock(v)).toMatchObject({ itemisedAvailable: 2, itemisedReserved: 3 });
    const outcome = await withTransaction(f.app.db, async (tx) => {
      const short = await code(reserve(tx, f.clock, { reservationKey: key(), orderRef: "o", lines: [{ variantId: v, quantity: 3 }] }));
      const ok = await reserve(tx, f.clock, { reservationKey: key(), orderRef: "o2", lines: [{ variantId: v, quantity: 2 }] }); // same tx continues after the failed savepoint
      return { short, ok };
    });
    expect(outcome.short).toBe("INVENTORY_INSUFFICIENT");
    expect(outcome.ok.status).toBe("ACTIVE");
    expect(await stock(v)).toMatchObject({ itemisedAvailable: 0, itemisedReserved: 5 });
    const moves = (await f.t.pool.query("select type, sum(qty_delta)::int s from inventory_movements where variant_id = $1 group by type order by type", [v])).rows;
    expect(moves).toEqual([{ type: "IMPORT", s: 5 }, { type: "RESERVE", s: -5 }]);
    await healthy();
  });
  it("is idempotent per key: a repeat returns the same reservation and takes no more stock; changed content conflicts", async () => {
    const v = await sellableVariant(f);
    await importCodes(ic(), v, { payloadKind: "CODE", codes: makeCodes(6) });
    const kk = key();
    const a = await res(v, 2, kk);
    const b = await res(v, 2, kk);
    expect(b).toMatchObject({ reservationId: a.reservationId, replay: true });
    expect(await stock(v)).toMatchObject({ itemisedAvailable: 4, itemisedReserved: 2 });
    expect(await code(res(v, 3, kk))).toBe("IDEMPOTENCY_CONFLICT");
    expect(await code(res(v, 2, kk, 600))).toBe("IDEMPOTENCY_CONFLICT");
    expect((await f.t.pool.query("select count(*)::int c from inventory_reservations where reservation_key = $1", [kk])).rows[0].c).toBe(1);
  });
  it("rejects unsellable, unknown, supplier-backed and malformed requests", async () => {
    const draft = await sellableVariant(f, "AUTO_CODE", "GIFT_CARD", false);
    expect(await code(res(draft, 1))).toBe("CATALOG_NOT_SELLABLE");
    expect(await code(res("0192a000-0000-7000-8000-0000000000aa", 1))).toBe("CATALOG_NOT_FOUND");
    const supplier = await sellableVariant(f, "SUPPLIER_API");
    expect(await code(res(supplier, 1))).toBe("INVENTORY_NOT_MANAGED");
    const v = await sellableVariant(f);
    for (const q of [0, -1, 1.5, 1001]) expect(await code(res(v, q)), String(q)).toBe("INVENTORY_INVALID");
    expect(await code(res(v, 1, key(), 5))).toBe("INVENTORY_INVALID"); // ttl below minimum
    expect(await code(withTransaction(f.app.db, (tx) => reserve(tx, f.clock, { reservationKey: key(), orderRef: "o", lines: [{ variantId: v, quantity: 1 }, { variantId: v, quantity: 1 }] })))).toBe("INVENTORY_INVALID");
  });
  it("a multi-line reservation is atomic across itemised and counted lines", async () => {
    const a = await sellableVariant(f), m = await sellableVariant(f, "MANUAL");
    await importCodes(ic(), a, { payloadKind: "CODE", codes: makeCodes(3) });
    await adjustStock(ic(), m, 2, "initial manual stock");
    const attempt = withTransaction(f.app.db, (tx) => reserve(tx, f.clock, { reservationKey: key(), orderRef: "o", lines: [{ variantId: a, quantity: 2 }, { variantId: m, quantity: 3 }] }));
    expect(await code(attempt)).toBe("INVENTORY_INSUFFICIENT");
    expect(await stock(a)).toMatchObject({ itemisedAvailable: 3, itemisedReserved: 0 });
    expect(await stock(m)).toMatchObject({ countedAvailable: 2, countedReserved: 0 });
    const ok = await withTransaction(f.app.db, (tx) => reserve(tx, f.clock, { reservationKey: key(), orderRef: "o", lines: [{ variantId: a, quantity: 2 }, { variantId: m, quantity: 2 }] }));
    expect(ok.status).toBe("ACTIVE");
    await healthy();
  });
  it("release returns the stock once (idempotent) and a released reservation cannot be consumed", async () => {
    const v = await sellableVariant(f);
    await importCodes(ic(), v, { payloadKind: "CODE", codes: makeCodes(2) });
    const r = await res(v, 2);
    expect(await withTransaction(f.app.db, (tx) => release(tx, f.clock, r.reservationId, "customer left"))).toBe(true);
    expect(await withTransaction(f.app.db, (tx) => release(tx, f.clock, r.reservationId, "again"))).toBe(false);
    expect(await stock(v)).toMatchObject({ itemisedAvailable: 2, itemisedReserved: 0 });
    expect(await withTransaction(f.app.db, (tx) => consume(tx, f.clock, r.reservationId))).toEqual({ outcome: "LATE", status: "RELEASED" });
    await healthy();
  });
});

describe("counted (manual) stock", () => {
  it("adjust, reserve, release and sell keep counters exact; never negative; audited", async () => {
    const m = await sellableVariant(f, "MANUAL");
    expect(await code(adjustStock(ic(), m, -1, "remove nothing"))).toBe("INVENTORY_INSUFFICIENT");
    expect((await adjustStock(ic(), m, 10, "stocktake opening")).available).toBe(10);
    expect(await code(adjustStock(ic(), m, -11, "too much removed"))).toBe("INVENTORY_INSUFFICIENT");
    expect(await code(adjustStock(ic(), m, 0, "zero delta"))).toBe("INVENTORY_INVALID");
    const r = await res(m, 4);
    expect(await stock(m)).toMatchObject({ countedAvailable: 6, countedReserved: 4 });
    await withTransaction(f.app.db, (tx) => release(tx, f.clock, r.reservationId, "left"));
    expect(await stock(m)).toMatchObject({ countedAvailable: 10, countedReserved: 0 });
    const r2 = await res(m, 3);
    await withTransaction(f.app.db, async (tx) => {
      expect((await consume(tx, f.clock, r2.reservationId)).outcome).toBe("CONSUMED");
      await markSold(tx, f.clock, { reservationId: r2.reservationId, assignments: ["a", "b", "c"].map((x) => ({ variantId: m, orderItemRef: `m-${r2.reservationId}-${x}` })) });
    });
    expect(await stock(m)).toMatchObject({ countedAvailable: 7, countedReserved: 0 });
    expect((await f.t.pool.query("select 1 from audit_logs where action = 'inventory.stock.adjusted' and actor_id = 'admin-1'")).rows.length).toBeGreaterThanOrEqual(2);
    expect(await code(getStock(invCtx(f, []), [m]))).toBe("AUTH_FORBIDDEN");
    expect((await getStock(ic(), [m]))[0]!.countedAvailable).toBe(7);
    await healthy();
  });
  it("only MANUAL variants have counted stock", async () => {
    expect(await code(adjustStock(ic(), await sellableVariant(f, "AUTO_CODE"), 1, "wrong kind of stock"))).toBe("INVENTORY_INVALID");
  });
});

describe("expiry, late payment (D9) and sales", () => {
  it("consume works strictly before expiry; at/after expiry it is LATE; the sweeper then frees the stock; nothing extends the TTL", async () => {
    const v = await sellableVariant(f);
    await importCodes(ic(), v, { payloadKind: "CODE", codes: makeCodes(4) });
    const clock = new ManualClock(f.clock.now());
    const r1 = await withTransaction(f.app.db, (tx) => reserve(tx, clock, { reservationKey: key(), orderRef: "o1", ttlSeconds: 600, lines: [{ variantId: v, quantity: 2 }] }));
    const r2 = await withTransaction(f.app.db, (tx) => reserve(tx, clock, { reservationKey: key(), orderRef: "o2", ttlSeconds: 600, lines: [{ variantId: v, quantity: 2 }] }));
    clock.advance(599_999);
    expect(await withTransaction(f.app.db, (tx) => consume(tx, clock, r1.reservationId))).toEqual({ outcome: "CONSUMED", replay: false });
    expect(await withTransaction(f.app.db, (tx) => consume(tx, clock, r1.reservationId))).toEqual({ outcome: "CONSUMED", replay: true });
    clock.advance(1); // exactly expires_at
    expect(await withTransaction(f.app.db, (tx) => consume(tx, clock, r2.reservationId))).toEqual({ outcome: "LATE", status: "ACTIVE" });
    expect(await sqlCode("update inventory_reservations set expires_at = expires_at + interval '1 hour'")).toBe("PI001"); // no extension, not even by the owner
    expect(await f.app.pool.query("update inventory_reservations set expires_at = now()").then(() => "ok", (e: unknown) => pgCode(e))).toBe("42501");
    expect(await sweepExpired(f.app.db, clock)).toBe(1); // r1 is CONSUMED and untouched
    expect(await withTransaction(f.app.db, (tx) => consume(tx, clock, r2.reservationId))).toEqual({ outcome: "LATE", status: "EXPIRED" });
    expect(await stock(v)).toMatchObject({ itemisedAvailable: 2, itemisedReserved: 2 });
    expect(await code(withTransaction(f.app.db, (tx) => markSold(tx, clock, { reservationId: r2.reservationId, assignments: [] })))).toBe("INVENTORY_INVALID"); // an expired reservation can never be sold
    expect(await sweepExpired(f.app.db, clock)).toBe(0);
    await healthy();
  });
  it("a reserve that finds too little first reclaims lapsed reservations of that variant", async () => {
    const v = await sellableVariant(f);
    await importCodes(ic(), v, { payloadKind: "CODE", codes: makeCodes(2) });
    const clock = new ManualClock(f.clock.now());
    await withTransaction(f.app.db, (tx) => reserve(tx, clock, { reservationKey: key(), orderRef: "o", ttlSeconds: 60, lines: [{ variantId: v, quantity: 2 }] }));
    expect(await code(withTransaction(f.app.db, (tx) => reserve(tx, clock, { reservationKey: key(), orderRef: "o", lines: [{ variantId: v, quantity: 1 }] })))).toBe("INVENTORY_INSUFFICIENT");
    clock.advance(61_000);
    const r = await withTransaction(f.app.db, (tx) => reserve(tx, clock, { reservationKey: key(), orderRef: "o", lines: [{ variantId: v, quantity: 2 }] }));
    expect(r.status).toBe("ACTIVE");
    expect(await stock(v)).toMatchObject({ itemisedAvailable: 0, itemisedReserved: 2 });
    await healthy();
  });
  it("sale flow: consume -> markSold assigns one distinct code per unit; replay is a no-op; wrong assignments are refused", async () => {
    const v = await sellableVariant(f);
    const codes = makeCodes(3);
    await importCodes(ic(), v, { payloadKind: "CODE", codes });
    const r = await res(v, 2);
    const refs = [`${r.reservationId}#1`, `${r.reservationId}#2`];
    expect(await code(withTransaction(f.app.db, (tx) => markSold(tx, f.clock, { reservationId: r.reservationId, assignments: refs.map((o) => ({ variantId: v, orderItemRef: o })) })))).toBe("INVENTORY_INVALID"); // not consumed yet
    await withTransaction(f.app.db, (tx) => consume(tx, f.clock, r.reservationId));
    expect(await code(withTransaction(f.app.db, (tx) => markSold(tx, f.clock, { reservationId: r.reservationId, assignments: [{ variantId: v, orderItemRef: refs[0]! }] })))).toBe("INVENTORY_INVALID");
    expect(await code(withTransaction(f.app.db, (tx) => markSold(tx, f.clock, { reservationId: r.reservationId, assignments: [{ variantId: v, orderItemRef: "same" }, { variantId: v, orderItemRef: "same" }] })))).toBe("INVENTORY_INVALID");
    const sold = await withTransaction(f.app.db, (tx) => markSold(tx, f.clock, { reservationId: r.reservationId, assignments: refs.map((o) => ({ variantId: v, orderItemRef: o })) }));
    expect(sold).toEqual({ replay: false, sold: 2 });
    expect(await withTransaction(f.app.db, (tx) => markSold(tx, f.clock, { reservationId: r.reservationId, assignments: refs.map((o) => ({ variantId: v, orderItemRef: o })) }))).toEqual({ replay: true, sold: 0 });
    const rows = (await f.t.pool.query("select status, order_item_ref from digital_codes where reservation_id = $1 order by order_item_ref", [r.reservationId])).rows;
    expect(rows.map((x) => x.status)).toEqual(["SOLD", "SOLD"]);
    expect(new Set(rows.map((x) => x.order_item_ref)).size).toBe(2);
    expect(await code(withTransaction(f.app.db, (tx) => release(tx, f.clock, r.reservationId, "too late")))).toBe("NO_ERROR"); // false, nothing moves
    expect((await stock(v)).itemisedAvailable).toBe(1);
    await healthy();
  });
  it("database guards hold when the service is bypassed with raw SQL", async () => {
    const v = await sellableVariant(f);
    await importCodes(ic(), v, { payloadKind: "CODE", codes: makeCodes(4) });
    const clock = new ManualClock(f.clock.now());
    const live = await withTransaction(f.app.db, (tx) => reserve(tx, clock, { reservationKey: key(), orderRef: "o", ttlSeconds: 60, lines: [{ variantId: v, quantity: 1 }] }));
    const lapsed = await withTransaction(f.app.db, (tx) => reserve(tx, clock, { reservationKey: key(), orderRef: "o", ttlSeconds: 60, lines: [{ variantId: v, quantity: 1 }] }));
    const codeOf = async (rid: string) => (await f.t.pool.query("select id from digital_codes where reservation_id = $1", [rid])).rows[0].id as string;
    // SOLD from an ACTIVE (unconsumed) reservation is refused
    expect(await sqlCode("update digital_codes set status='SOLD', order_item_ref='x', sold_at=now() where id=$1", [await codeOf(live.reservationId)])).toBe("PV001");
    clock.advance(61_000);
    await sweepExpired(f.app.db, clock);
    // taking a code under an EXPIRED reservation is refused
    const free = (await f.t.pool.query("select id from digital_codes where variant_id=$1 and status='AVAILABLE' limit 1", [v])).rows[0].id;
    expect(await sqlCode("update digital_codes set status='RESERVED', reservation_id=$2, reserved_until=now() where id=$1", [free, lapsed.reservationId])).toBe("PV001");
    // consumed-late is impossible even for the owner: consumed_at must be < expires_at
    const fresh = await res(v, 1);
    expect(await sqlCode("update inventory_reservations set status='CONSUMED', consumed_at=expires_at where id=$1", [fresh.reservationId])).toBe("23514");
    await withTransaction(f.app.db, (tx) => release(tx, f.clock, fresh.reservationId, "test cleanup"));
    // a SOLD code is frozen; sold -> available is not a transition; two codes cannot share an order item
    const r = await res(v, 2);
    await withTransaction(f.app.db, (tx) => consume(tx, f.clock, r.reservationId));
    await withTransaction(f.app.db, (tx) => markSold(tx, f.clock, { reservationId: r.reservationId, assignments: [{ variantId: v, orderItemRef: "u1" }, { variantId: v, orderItemRef: "u2" }] }));
    const [a, b] = (await f.t.pool.query("select id from digital_codes where reservation_id = $1 order by order_item_ref", [r.reservationId])).rows.map((x) => x.id as string);
    expect(await sqlCode("update digital_codes set order_item_ref='zz' where id=$1", [a])).toBe("PV002");
    expect(await sqlCode("update digital_codes set status='AVAILABLE', reservation_id=null, order_item_ref=null, reserved_until=null where id=$1", [a])).toBe("PV002");
    expect(await sqlCode("update digital_codes set sealed = decode('00','hex') where id=$1", [a])).toBe("PV002");
    expect(await sqlCode("update digital_codes set order_item_ref='u1' where id=$1", [b])).toBe("PV002");
    expect(await sqlCode("update digital_codes set code_fp = decode(repeat('00',32),'hex') where id=$1", [a])).toBe("PI001");
    for (const q of ["delete from digital_codes", "delete from inventory_reservations", "delete from inventory_movements", "update inventory_movements set qty_delta = 0", "delete from code_access_log"]) {
      expect(await f.app.pool.query(q).then(() => "ok", (e: unknown) => pgCode(e)), q).toBe("42501");
    }
    expect(await sqlCode("update inventory_movements set qty_delta = 0")).not.toBe("ok"); // append-only even for the owner
    await healthy();
  });
});

describe("delivery access", () => {
  it("only a SOLD code of exactly this order item can be opened; the access is logged first; the buffer is zeroed afterwards", async () => {
    const v = await sellableVariant(f);
    const [secret, other] = makeCodes(2);
    await importCodes(ic(), v, { payloadKind: "CODE", codes: [secret!, other!] });
    const r = await res(v, 1);
    const id = (await f.t.pool.query("select id from digital_codes where reservation_id = $1", [r.reservationId])).rows[0].id as string;
    const req = { codeId: id, orderItemRef: "item-1", requestedBy: "fulfilment:test", purpose: "deliver" };
    expect(await code(withDeliverySecret(f.app.db, f.keys, f.clock, req, () => 1))).toBe("INVENTORY_NOT_FOUND"); // merely reserved
    await withTransaction(f.app.db, (tx) => consume(tx, f.clock, r.reservationId));
    expect(await code(withDeliverySecret(f.app.db, f.keys, f.clock, req, () => 1))).toBe("INVENTORY_NOT_FOUND"); // consumed but not sold
    await withTransaction(f.app.db, (tx) => markSold(tx, f.clock, { reservationId: r.reservationId, assignments: [{ variantId: v, orderItemRef: "item-1" }] }));
    expect(await code(withDeliverySecret(f.app.db, f.keys, f.clock, { ...req, orderItemRef: "item-2" }, () => 1))).toBe("INVENTORY_NOT_FOUND");
    let held!: Buffer;
    const seen = await withDeliverySecret(f.app.db, f.keys, f.clock, req, (plain) => { held = plain; return plain.toString("utf8"); });
    expect(seen).toBe(secret);
    expect(held.every((b) => b === 0)).toBe(true);
    const log = (await f.t.pool.query("select code_id, order_item_ref, requested_by from code_access_log")).rows;
    expect(log).toEqual([{ code_id: id, order_item_ref: "item-1", requested_by: "fulfilment:test" }]);
  });
});

describe("administration", () => {
  it("void / quarantine / release-from-quarantine with reason, audit and movements; reserved or sold codes cannot be touched", async () => {
    const v = await sellableVariant(f);
    await importCodes(ic(), v, { payloadKind: "CODE", codes: makeCodes(3) });
    const ids = (await f.t.pool.query("select id from digital_codes where variant_id = $1 order by id", [v])).rows.map((x) => x.id as string);
    expect(await code(setCodeStatus(invCtx(f, []), ids[0]!, "VOID", "denied by role"))).toBe("AUTH_FORBIDDEN");
    expect(await code(setCodeStatus(ic(), ids[0]!, "VOID", "x"))).toBe("INVENTORY_INVALID");
    await setCodeStatus(ic(), ids[0]!, "QUARANTINED", "suspected leak");
    expect((await stock(v)).itemisedAvailable).toBe(2);
    await setCodeStatus(ic(), ids[0]!, "AVAILABLE", "cleared after check");
    await setCodeStatus(ic(), ids[1]!, "VOID", "provider recalled it");
    expect(await code(setCodeStatus(ic(), ids[1]!, "AVAILABLE", "revive a voided code"))).toBe("INVENTORY_INVALID");
    const r = await res(v, 1);
    const held = (await f.t.pool.query("select id from digital_codes where reservation_id = $1", [r.reservationId])).rows[0].id as string;
    expect(await code(setCodeStatus(ic(), held, "VOID", "reserved code is off limits"))).toBe("INVENTORY_INVALID");
    expect((await f.t.pool.query("select count(*)::int c from audit_logs where action = 'inventory.code.status_changed' and actor_id = 'admin-1'")).rows[0].c).toBeGreaterThanOrEqual(3);
    await healthy();
  });
});
