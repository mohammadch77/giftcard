import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adjustStock, availability, consume, importCodes, release, reserve, sweepExpired, verifyInventory } from "@/modules/inventory";
import { ManualClock } from "@/platform/clock/testing";
import { withTransaction } from "@/platform/db";
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

let k = 0;
const key = () => `c-${++k}-${Math.random().toString(36).slice(2, 7)}`;
const res = (clock: ManualClock, variantId: string, quantity: number, reservationKey = key(), ttlSeconds?: number) =>
  withTransaction(f.app.db, (tx) => reserve(tx, clock, { reservationKey, orderRef: `o-${reservationKey}`, lines: [{ variantId, quantity }], ...(ttlSeconds ? { ttlSeconds } : {}) }));
const outcome = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string }) => e.code ?? "ERR");
const healthy = async () => expect(await verifyInventory(f.app.db)).toEqual([]);

describe("S1 — allocation under contention", () => {
  it("1,000 concurrent attempts against 10 codes: exactly 10 succeed and no code is allocated twice", async () => {
    const v = await sellableVariant(f);
    await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: makeCodes(10) });
    const results = await Promise.all(Array.from({ length: 1000 }, () => outcome(res(f.clock, v, 1))));
    expect(results.filter((r) => r === "OK")).toHaveLength(10);
    expect(results.filter((r) => r === "INVENTORY_INSUFFICIENT")).toHaveLength(990);
    const held = (await f.t.pool.query("select id, reservation_id from digital_codes where variant_id = $1 and status = 'RESERVED'", [v])).rows;
    expect(held).toHaveLength(10);
    expect(new Set(held.map((x) => x.id)).size).toBe(10);
    expect(new Set(held.map((x) => x.reservation_id)).size).toBe(10); // each code belongs to a different reservation
    expect((await f.t.pool.query("select count(*)::int c from inventory_reservations r join inventory_reservation_lines l on l.reservation_id = r.id where l.variant_id = $1", [v])).rows[0].c).toBe(10); // failed attempts left no rows
    expect((await availability(f.app.db, [v]))[0]).toMatchObject({ itemisedAvailable: 0, itemisedReserved: 10 });
    await healthy();
  });

  it("multi-unit contention: 300 buyers of 3 against 100 codes get exactly 33 reservations and never a partial one", async () => {
    const v = await sellableVariant(f);
    await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: makeCodes(100) });
    const results = await Promise.all(Array.from({ length: 300 }, () => outcome(res(f.clock, v, 3))));
    expect(results.filter((r) => r === "OK")).toHaveLength(33);
    const per = (await f.t.pool.query("select count(*)::int c from digital_codes where variant_id = $1 and status = 'RESERVED' group by reservation_id", [v])).rows;
    expect(per.every((x) => x.c === 3)).toBe(true);
    expect((await availability(f.app.db, [v]))[0]!.itemisedAvailable).toBe(1);
    await healthy();
  });

  it("counted stock: 500 attempts against 10 units admit exactly 10", async () => {
    const m = await sellableVariant(f, "MANUAL");
    await adjustStock(invCtx(f), m, 10, "opening stock");
    const results = await Promise.all(Array.from({ length: 500 }, () => outcome(res(f.clock, m, 1))));
    expect(results.filter((r) => r === "OK")).toHaveLength(10);
    expect((await availability(f.app.db, [m]))[0]).toMatchObject({ countedAvailable: 0, countedReserved: 10 });
    await healthy();
  });
});

describe("idempotency under concurrency", () => {
  it("30 parallel requests with one key create ONE reservation and hold exactly the requested quantity", async () => {
    const v = await sellableVariant(f);
    await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: makeCodes(10) });
    const kk = key();
    const all = await Promise.all(Array.from({ length: 30 }, () => res(f.clock, v, 2, kk)));
    expect(new Set(all.map((a) => a.reservationId)).size).toBe(1);
    expect(all.filter((a) => !a.replay)).toHaveLength(1);
    expect((await availability(f.app.db, [v]))[0]).toMatchObject({ itemisedAvailable: 8, itemisedReserved: 2 });
    await healthy();
  });
  it("concurrent release of one reservation returns the stock exactly once", async () => {
    const v = await sellableVariant(f);
    await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: makeCodes(3) });
    const r = await res(f.clock, v, 3);
    const out = await Promise.all(Array.from({ length: 20 }, () => withTransaction(f.app.db, (tx) => release(tx, f.clock, r.reservationId, "race"))));
    expect(out.filter(Boolean)).toHaveLength(1);
    expect((await availability(f.app.db, [v]))[0]).toMatchObject({ itemisedAvailable: 3, itemisedReserved: 0 });
    await healthy();
  });
});

describe("expiry boundary (D9): consume vs sweeper", () => {
  it("200 races at the expiry instant: a reservation is CONSUMED xor EXPIRED, never both, and never delivered after expiry", async () => {
    const v = await sellableVariant(f);
    await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: makeCodes(200) });
    let consumed = 0, expired = 0;
    for (let i = 0; i < 200; i++) {
      const base = new ManualClock(f.clock.now());
      const r = await res(base, v, 1, key(), 60);
      const consumeClock = new ManualClock(base.now()); consumeClock.advance(59_999); // still valid for the payer
      const sweepClock = new ManualClock(base.now()); sweepClock.advance(60_000); // already lapsed for the sweeper
      const [c] = await Promise.all([withTransaction(f.app.db, (tx) => consume(tx, consumeClock, r.reservationId)), sweepExpired(f.app.db, sweepClock, { batchSize: 500 })]);
      const row = (await f.t.pool.query("select status from inventory_reservations where id = $1", [r.reservationId])).rows[0];
      const codeStatus = (await f.t.pool.query("select status from digital_codes where reservation_id = $1", [r.reservationId])).rows;
      if (c.outcome === "CONSUMED") {
        consumed++;
        expect(row.status).toBe("CONSUMED");
        expect(codeStatus.map((x) => x.status)).toEqual(["RESERVED"]); // still held for the buyer
      } else {
        expired++;
        expect(row.status).toBe("EXPIRED");
        expect(codeStatus).toEqual([]); // codes went back to the pool
      }
    }
    expect(consumed + expired).toBe(200);
    // sweep whatever the consumed ones left (they stay CONSUMED; nothing may expire them)
    await sweepExpired(f.app.db, new ManualClock(new Date(f.clock.now().getTime() + 3600_000)), { batchSize: 500 });
    expect((await f.t.pool.query("select count(*)::int c from inventory_reservations where status = 'CONSUMED' and id in (select reservation_id from digital_codes where status <> 'RESERVED')")).rows[0].c).toBe(0);
    await healthy();
  });

  it("parallel sweepers and reservers never deadlock, double-release or lose stock", async () => {
    const v = await sellableVariant(f);
    await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: makeCodes(40) });
    const clock = new ManualClock(f.clock.now());
    for (let i = 0; i < 20; i++) await res(clock, v, 2, key(), 60);
    clock.advance(61_000);
    const work = [
      ...Array.from({ length: 6 }, () => sweepExpired(f.app.db, clock, { batchSize: 7 }).then(() => "sweep")),
      ...Array.from({ length: 30 }, () => outcome(res(clock, v, 1))),
    ];
    const done = await Promise.all(work);
    expect(done.filter((x) => x === "OK").length + done.filter((x) => x === "INVENTORY_INSUFFICIENT").length).toBe(30);
    await sweepExpired(f.app.db, clock, { batchSize: 500 });
    const a = (await availability(f.app.db, [v]))[0]!;
    expect(a.itemisedAvailable + a.itemisedReserved).toBe(40);
    await healthy();
  });
});
