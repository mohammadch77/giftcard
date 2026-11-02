import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { availability, sweepExpired, verifyInventory } from "@/modules/inventory";
import { verifyIntegrity } from "@/modules/ledger";
import { cancelOrder, checkout, confirmGatewayPayment, expireStale, payOrderWithWallet } from "@/modules/orders";
import { ManualClock } from "@/platform/clock/testing";
import { gatewayCheckout, orderFixture, orderRow, ordersDeps, stockedVariant, uniqKey, userId } from "../helpers/orders";
import type { OrderFixture } from "../helpers/orders";

let f: OrderFixture;
beforeAll(async () => {
  f = await orderFixture();
});
afterAll(async () => {
  await f?.app.close();
  await f?.t.drop();
});

const all = <T>(k: number, fn: (i: number) => Promise<T>) => Promise.all(Array.from({ length: k }, (_, i) => fn(i)));
const safe = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: { code?: string }) => ({ ok: false as const, code: e.code ?? "ERR" }));
const q = async <T = Record<string, unknown>>(s: string, p: unknown[] = []) => (await f.t.pool.query(s, p)).rows as T[];

/** The cross-module invariant set (zero rows everywhere = consistent). */
async function assertConsistent(variantId: string, total: number) {
  expect(await verifyInventory(f.app.db)).toEqual([]);
  expect(await verifyIntegrity(f.app.db)).toEqual([]);
  const a = (await availability(f.app.db, [variantId]))[0]!;
  const sold = Number((await q("select count(*)::int c from digital_codes where variant_id = $1 and status = 'SOLD'", [variantId]))[0]!.c);
  expect(a.itemisedAvailable + a.itemisedReserved + sold).toBe(total); // available + reserved + sold = total (nothing voided here)
  expect(a.itemisedAvailable).toBeGreaterThanOrEqual(0);
  // every paid-ish order has exactly its tasks and deliveries; every delivery has a SOLD code of the same item
  const bad1 = await q("select o.id from orders o where o.status in ('PAID','FULFILLING','PARTIALLY_COMPLETED','COMPLETED') and (select count(*) from fulfillment_tasks t where t.order_ref = o.id::text) <> (select sum(quantity) from order_items i where i.order_id = o.id)");
  expect(bad1).toEqual([]);
  const bad2 = await q("select d.id from deliveries d where d.kind = 'INVENTORY_CODE' and not exists (select 1 from digital_codes c where c.id = d.code_ref and c.status = 'SOLD' and c.order_item_ref = d.order_item_ref)");
  expect(bad2).toEqual([]);
  // no unpaid / held / expired / cancelled order has any fulfilment row or sold code
  const bad3 = await q("select o.id from orders o where o.status in ('PENDING_PAYMENT','ON_HOLD','CANCELLED','EXPIRED') and exists (select 1 from fulfillment_tasks t where t.order_ref = o.id::text)");
  expect(bad3).toEqual([]);
  const bad4 = await q("select c.id from digital_codes c where c.status = 'SOLD' and c.variant_id = $1 and not exists (select 1 from order_items i join orders o on o.id = i.order_id where i.id::text = split_part(c.order_item_ref, '#', 1) and o.status in ('PAID','FULFILLING','PARTIALLY_COMPLETED','COMPLETED'))", [variantId]);
  expect(bad4).toEqual([]);
}

describe("S1 end-to-end — 1,000 concurrent checkout -> pay -> deliver attempts on 10 codes", () => {
  it("gateway-paid: at most 10 orders deliver, no code twice, no negative stock, everything consistent", async () => {
    const { variantId } = await stockedVariant(f, 10);
    const calls0 = f.policy.calls.length;
    const out = await all(1000, async () => {
      const user = userId();
      const c = await safe(gatewayCheckout(f, user, [{ variantId, quantity: 1 }]));
      if (!c.ok) return c.code;
      f.gateway.script(c.v.gatewayRef, { status: "PAID", amount: 1_000_000 });
      const v = await safe(confirmGatewayPayment(ordersDeps(f), { gatewayRef: c.v.gatewayRef, eventKey: `e-${c.v.orderId}` }));
      return v.ok ? v.v.outcome : v.code;
    });
    expect(out.filter((x) => x === "SUCCEEDED")).toHaveLength(10);
    expect(out.filter((x) => x === "INVENTORY_INSUFFICIENT")).toHaveLength(990);
    expect(f.policy.calls.length - calls0).toBe(10);
    expect(Number((await q("select count(*)::int c from orders o join order_items i on i.order_id = o.id where i.variant_id = $1", [variantId]))[0]!.c)).toBe(10); // failed attempts left no order
    expect(Number((await q("select count(distinct c.id)::int c from digital_codes c where c.variant_id = $1 and c.status = 'SOLD'", [variantId]))[0]!.c)).toBe(10);
    expect(Number((await q("select count(*)::int c from deliveries d join digital_codes c on c.id = d.code_ref where c.variant_id = $1", [variantId]))[0]!.c)).toBe(10);
    await assertConsistent(variantId, 10);
  });

  it("mixed wallet / gateway payers (400 attempts, 10 codes): same guarantees", async () => {
    const { variantId } = await stockedVariant(f, 10);
    const out = await all(400, async (i) => {
      const user = userId();
      if (i % 2 === 0) {
        const c = await safe(checkout(ordersDeps(f), { userId: user, paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }] }));
        if (!c.ok) return c.code;
        const p = await safe(payOrderWithWallet(ordersDeps(f), { userId: user, orderId: c.v.orderId }));
        return p.ok ? "SUCCEEDED" : p.code;
      }
      const c = await safe(gatewayCheckout(f, user, [{ variantId, quantity: 1 }]));
      if (!c.ok) return c.code;
      f.gateway.script(c.v.gatewayRef, { status: "PAID", amount: 1_000_000 });
      const v = await safe(confirmGatewayPayment(ordersDeps(f), { gatewayRef: c.v.gatewayRef, eventKey: `e-${c.v.orderId}` }));
      return v.ok ? v.v.outcome : v.code;
    });
    expect(out.filter((x) => x === "SUCCEEDED")).toHaveLength(10);
    expect(out.every((x) => x === "SUCCEEDED" || x === "INVENTORY_INSUFFICIENT")).toBe(true);
    await assertConsistent(variantId, 10);
  });
});

describe("duplicate requests", () => {
  it("30 parallel checkouts with one key create one order and hold the stock once", async () => {
    const { variantId } = await stockedVariant(f, 10);
    const user = userId(), key = uniqKey();
    const res = await all(30, () => checkout(ordersDeps(f), { userId: user, paymentMethod: "GATEWAY", idempotencyKey: key, lines: [{ variantId, quantity: 3 }] }));
    expect(new Set(res.map((r) => r.orderId)).size).toBe(1);
    expect(res.filter((r) => !r.replay)).toHaveLength(1);
    expect((await availability(f.app.db, [variantId]))[0]).toMatchObject({ itemisedAvailable: 7, itemisedReserved: 3 });
    expect(Number((await q("select count(*)::int c from payments where order_ref = $1", [res[0]!.orderId]))[0]!.c)).toBe(1);
  });

  it("100 parallel callbacks for one order payment: ONE settlement, ONE delivery", async () => {
    const { variantId } = await stockedVariant(f, 2);
    const c = await gatewayCheckout(f, userId(), [{ variantId, quantity: 1 }]);
    f.gateway.script(c.gatewayRef, { status: "PAID", amount: 1_000_000 });
    f.gateway.verifyDelayMs = 30;
    const calls0 = f.policy.calls.length;
    const res = await all(100, (i) => confirmGatewayPayment(ordersDeps(f), { gatewayRef: c.gatewayRef, eventKey: `dup-${i % 25}` }));
    f.gateway.verifyDelayMs = 0;
    expect(res.filter((r) => r.outcome === "SUCCEEDED")).toHaveLength(1);
    expect(f.policy.calls.length - calls0).toBe(1);
    expect(Number((await q("select count(*)::int c from deliveries d where d.order_item_ref like $1", [`${(await q("select id from order_items where order_id = $1", [c.orderId]))[0]!.id}#%`]))[0]!.c)).toBe(1);
    expect((await orderRow(f, c.orderId)).status).toBe("COMPLETED");
  });
});

describe("races at the expiry boundary (D9) and with cancellation", () => {
  it("50 races of 'payment verified' vs 'sweeper expires' at the expiry instant: PAID+delivered XOR ON_HOLD+suspense — never a delivery from a lapsed reservation", async () => {
    const { variantId } = await stockedVariant(f, 50);
    let paidN = 0, heldN = 0;
    for (let i = 0; i < 50; i++) {
      const base = new ManualClock(f.clock.now());
      const payerClock = new ManualClock(base.now());
      const sweepClock = new ManualClock(base.now());
      const r = await checkout(ordersDeps(f, { clock: base }), { userId: userId(), paymentMethod: "GATEWAY", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }] });
      const ref = (await q<{ gateway_ref: string }>("select gateway_ref from payments where id = $1", [r.paymentId]))[0]!.gateway_ref;
      f.gateway.script(ref, { status: "PAID", amount: 1_000_000 });
      payerClock.advance(899_999); // still inside the hold for the payer
      sweepClock.advance(900_000); // already lapsed for the sweeper
      await Promise.all([
        confirmGatewayPayment(ordersDeps(f, { clock: payerClock }), { gatewayRef: ref, eventKey: `race-${i}` }),
        expireStale(ordersDeps(f, { clock: sweepClock })),
        sweepExpired(f.app.db, sweepClock, { batchSize: 100 }),
      ]);
      const o = await orderRow(f, r.orderId);
      const res = (await q<{ status: string }>("select status from inventory_reservations where id = $1", [o.reservation_id]))[0]!.status;
      const delivered = Number((await q("select count(*)::int c from fulfillment_tasks where order_ref = $1", [r.orderId]))[0]!.c);
      if (o.status === "COMPLETED") {
        paidN++;
        expect(res).toBe("CONSUMED");
        expect(delivered).toBe(1);
      } else {
        heldN++;
        expect(o.status).toBe("ON_HOLD");
        expect(res).not.toBe("CONSUMED");
        expect(delivered).toBe(0);
        expect(Number((await q("select count(*)::int c from ledger_transactions where idempotency_key = $1", [`late:${r.paymentId}`]))[0]!.c)).toBe(1);
      }
    }
    expect(paidN + heldN).toBe(50);
    await assertConsistent(variantId, 50);
  });

  it("30 races of cancel vs payment: PAID or (CANCELLED -> ON_HOLD late); stock never leaks or double-sells", async () => {
    const { variantId } = await stockedVariant(f, 30);
    const jobs = await all(30, async () => {
      const user = userId();
      const c = await gatewayCheckout(f, user, [{ variantId, quantity: 1 }]);
      f.gateway.script(c.gatewayRef, { status: "PAID", amount: 1_000_000 });
      await Promise.all([
        safe(cancelOrder(ordersDeps(f), { orderId: c.orderId, by: { type: "CUSTOMER", userId: user }, reason: "racing cancel" })),
        safe(confirmGatewayPayment(ordersDeps(f), { gatewayRef: c.gatewayRef, eventKey: `r-${c.orderId}` })),
      ]);
      return (await orderRow(f, c.orderId)).status as string;
    });
    expect(jobs.every((s) => s === "COMPLETED" || s === "ON_HOLD")).toBe(true);
    await assertConsistent(variantId, 30);
  });
});
