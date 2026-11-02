import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changePrice } from "@/modules/catalog";
import { adjustStock, availability, verifyInventory } from "@/modules/inventory";
import { deliveryStatus, withRevealedSecret } from "@/modules/fulfillment";
import { claimManualTask, completeManualTask } from "@/modules/fulfillment";
import { verifyIntegrity } from "@/modules/ledger";
import {
  NullOrderPostingPolicy, cancelOrder, checkout, confirmGatewayPayment, expireStale, getOrder, getOrderAdmin, listOpenHolds, listOrdersForUser, payOrderWithWallet, resolveHold, syncFulfillment,
} from "@/modules/orders";
import { ORDER_NUMBER_PATTERN } from "@/platform/ids";
import { ManualClock } from "@/platform/clock/testing";
import { pgCode } from "../helpers/db";
import { adminCtx } from "../helpers/catalog";
import { sellableVariant } from "../helpers/inventory";
import { adminOf, gatewayCheckout, orderFixture, orderRow, ordersDeps, stockedVariant, uniqKey, userId } from "../helpers/orders";
import type { OrderFixture } from "../helpers/orders";
import { readySupplier, routedVariant } from "../helpers/suppliers";

let f: OrderFixture;
beforeAll(async () => {
  f = await orderFixture();
});
afterAll(async () => {
  await f?.app.close();
  await f?.t.drop();
});

const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? "OTHER"; } return "NO_ERROR"; };
const sqlCode = (q: string, p: unknown[] = []) => f.t.pool.query(q, p).then(() => "ok", (e: unknown) => pgCode(e));
const counts = async () => (await f.t.pool.query("select (select count(*) from orders)::int o, (select count(*) from order_items)::int i, (select count(*) from inventory_reservations)::int r, (select count(*) from payments)::int p")).rows[0];
const paid = async (checkoutRes: { gatewayRef: string }, amount: number) => {
  f.gateway.script(checkoutRes.gatewayRef, { status: "PAID", amount });
  return confirmGatewayPayment(ordersDeps(f), { gatewayRef: checkoutRes.gatewayRef, eventKey: `ev-${Math.random()}` });
};
const healthy = async () => {
  expect(await verifyInventory(f.app.db)).toEqual([]);
  expect(await verifyIntegrity(f.app.db)).toEqual([]);
};

describe("fail-closed business configuration (B3, D10)", () => {
  it("no reservation hold configured (B3), no accounting policy (D10) or no gateway: checkout is refused and NOTHING is written", async () => {
    const { variantId } = await stockedVariant(f, 2);
    const before = await counts();
    const lines = [{ variantId, quantity: 1 }];
    const base = { userId: "u-cfg", paymentMethod: "GATEWAY" as const, idempotencyKey: "k", lines };
    expect(await code(checkout(ordersDeps(f, { reservationTtlSeconds: undefined }), base))).toBe("ORDER_RESERVATION_TTL_NOT_CONFIGURED"); // inventory's 900 s technical default is NOT used
    for (const bad of [0, 30, 4000, 90.5]) expect(await code(checkout(ordersDeps(f, { reservationTtlSeconds: bad }), base)), String(bad)).toBe("ORDER_RESERVATION_TTL_NOT_CONFIGURED");
    expect(await code(checkout(ordersDeps(f, { policy: new NullOrderPostingPolicy() }), base))).toBe("ORDER_ACCOUNTING_NOT_CONFIGURED");
    expect(await code(checkout({ db: f.app.db, clock: f.clock, gateway: f.gateway, reservationTtlSeconds: 900 }, base))).toBe("ORDER_ACCOUNTING_NOT_CONFIGURED"); // default policy refuses
    const none = { ...f.gateway, key: "none" } as never;
    expect(await code(checkout(ordersDeps(f, { gateway: none }), base))).toBe("PAYMENT_GATEWAY_NOT_CONFIGURED");
    expect(await counts()).toEqual(before);
    expect((await availability(f.app.db, [variantId]))[0]).toMatchObject({ itemisedAvailable: 2, itemisedReserved: 0 });
  });
  it("wallet payment and hold re-reservation also refuse while accounting is undecided, rolling back every effect", async () => {
    const { variantId } = await stockedVariant(f, 1);
    const user = userId();
    const o = await checkout(ordersDeps(f), { userId: user, paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }] });
    const nullDeps = ordersDeps(f, { policy: new NullOrderPostingPolicy() });
    expect(await code(payOrderWithWallet(nullDeps, { userId: user, orderId: o.orderId }))).toBe("ORDER_ACCOUNTING_NOT_CONFIGURED");
    expect((await orderRow(f, o.orderId)).status).toBe("PENDING_PAYMENT");
    expect((await availability(f.app.db, [variantId]))[0]).toMatchObject({ itemisedReserved: 1 }); // still held, not consumed
    expect((await f.t.pool.query("select status from inventory_reservations where id = $1", [(await orderRow(f, o.orderId)).reservation_id])).rows[0].status).toBe("ACTIVE");
    expect(await code(resolveHold(nullDeps, adminOf(f), "00000000-0000-7000-8000-000000000000", { resolution: "RE_RESERVE", note: "irrelevant note here" }))).toBe("ORDER_NOT_FOUND");
  });
});

describe("checkout", () => {
  it("quotes server-side, snapshots everything immutably, reserves stock, and the order total equals its items; catalog changes later do not touch the order", async () => {
    const { variantId } = await stockedVariant(f, 5);
    const user = userId();
    const r = await checkout(ordersDeps(f), { userId: user, paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 3 }] });
    expect(r).toMatchObject({ status: "PENDING_PAYMENT", total: 3_000_000, replay: false });
    expect(r.number).toMatch(ORDER_NUMBER_PATTERN);
    expect((await availability(f.app.db, [variantId]))[0]).toMatchObject({ itemisedAvailable: 2, itemisedReserved: 3 });
    const before = await getOrder(f.app.db, user, r.orderId);
    await changePrice(adminCtx(f), variantId, { price: 9_000_000, reason: "later repricing" });
    const after = await getOrder(f.app.db, user, r.orderId);
    expect(after).toEqual(before);
    expect(after?.items[0]).toMatchObject({ unitPrice: 1_000_000, lineTotal: 3_000_000, quantity: 3 });
    expect(JSON.stringify(after?.items[0]?.snapshot)).toContain("productName");
    expect(await sqlCode("update order_items set unit_price = 10 where order_id = $1", [r.orderId])).toBe("PI001");
    expect(await f.app.pool.query("update order_items set unit_price = 10").then(() => "ok", (e: unknown) => pgCode(e))).toBe("42501");
    expect(await code(checkout(ordersDeps(f), { userId: user, paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }], total: 1 }))).toBe("ORDER_INVALID"); // no client price exists
    expect(await code(checkout(ordersDeps(f), { userId: user, paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1, unitPrice: 1 }] }))).toBe("ORDER_INVALID");
  });
  it("is atomic: a shortage leaves no order, no item, no reservation, no payment; unsellable variants are refused", async () => {
    const { variantId } = await stockedVariant(f, 2);
    const before = await counts();
    expect(await code(checkout(ordersDeps(f), { userId: "u", paymentMethod: "GATEWAY", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 3 }] }))).toBe("INVENTORY_INSUFFICIENT");
    const draft = await sellableVariant(f, "AUTO_CODE", "GIFT_CARD", false);
    expect(await code(checkout(ordersDeps(f), { userId: "u", paymentMethod: "GATEWAY", idempotencyKey: uniqKey(), lines: [{ variantId: draft, quantity: 1 }] }))).toBe("CATALOG_NOT_SELLABLE");
    expect(await counts()).toEqual(before);
  });
  it("is idempotent per (user, key): same request -> same order and no extra stock; different content conflicts; other users are independent", async () => {
    const { variantId } = await stockedVariant(f, 6);
    const user = userId(), key = uniqKey();
    const a = await checkout(ordersDeps(f), { userId: user, paymentMethod: "GATEWAY", idempotencyKey: key, lines: [{ variantId, quantity: 2 }] });
    const b = await checkout(ordersDeps(f), { userId: user, paymentMethod: "GATEWAY", idempotencyKey: key, lines: [{ variantId, quantity: 2 }] });
    expect(b).toMatchObject({ orderId: a.orderId, replay: true });
    expect((await availability(f.app.db, [variantId]))[0]).toMatchObject({ itemisedReserved: 2 });
    expect(await code(checkout(ordersDeps(f), { userId: user, paymentMethod: "GATEWAY", idempotencyKey: key, lines: [{ variantId, quantity: 3 }] }))).toBe("IDEMPOTENCY_CONFLICT");
    expect(await code(checkout(ordersDeps(f), { userId: user, paymentMethod: "WALLET", idempotencyKey: key, lines: [{ variantId, quantity: 2 }] }))).toBe("IDEMPOTENCY_CONFLICT");
    const other = await checkout(ordersDeps(f), { userId: userId(), paymentMethod: "GATEWAY", idempotencyKey: key, lines: [{ variantId, quantity: 1 }] });
    expect(other.orderId).not.toBe(a.orderId);
    expect(a.redirectUrl).toMatch(/^https:\/\/gateway\.invalid\//);
  });
  it("database invariants: total = sum of items at commit, no payment row on wallet orders (D6), ON_HOLD iff an open hold", async () => {
    const { variantId } = await stockedVariant(f, 1);
    const user = userId();
    const r = await checkout(ordersDeps(f), { userId: user, paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }] });
    const c = await f.t.pool.connect();
    try {
      await c.query("select set_config('app.actor_id','t',false)");
      await c.query("begin");
      await c.query("insert into orders (id, number, user_ref, status, payment_status, payment_method, currency, total, pricing_version, idempotency_key, request_hash, expires_at, created_at, updated_at) values (gen_random_uuid(), 'ZZZZZ-ZZZZZ', 'x', 'PENDING_PAYMENT', 'PENDING', 'WALLET', 'IRR', 5000, 'v', 'bad-total', decode(repeat('ab',32),'hex'), now(), now(), now())");
      expect(await c.query("commit").then(() => "ok", (e: unknown) => pgCode(e))).toBe("PO001");
    } finally {
      c.release();
    }
    const c2 = await f.t.pool.connect();
    try {
      await c2.query("select set_config('app.actor_id','t',false)");
      await c2.query("begin");
      await c2.query("update orders set status = 'CANCELLED' where id = $1", [r.orderId]);
      await c2.query("update orders set status = 'ON_HOLD' where id = $1", [r.orderId]);
      expect(await c2.query("commit").then(() => "ok", (e: unknown) => pgCode(e))).toBe("PO001"); // ON_HOLD without a hold
    } finally {
      c2.release();
    }
    expect(await sqlCode("update orders set payment_id = gen_random_uuid() where id = $1", [r.orderId])).toBe("PI001");
    expect((await orderRow(f, r.orderId)).status).toBe("PENDING_PAYMENT");
  });
  it("reads are owner-scoped (IDOR-safe); admin reads need orders.read; order numbers are random", async () => {
    const { variantId } = await stockedVariant(f, 2);
    const [u1, u2] = [userId(), userId()];
    const a = await checkout(ordersDeps(f), { userId: u1, paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }] });
    const b = await checkout(ordersDeps(f), { userId: u2, paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }] });
    expect(await getOrder(f.app.db, u2, a.orderId)).toBeNull();
    expect(await getOrder(f.app.db, u1, "not-a-uuid")).toBeNull();
    expect((await listOrdersForUser(f.app.db, u1)).map((o) => o.id)).toEqual([a.orderId]);
    expect(await code(getOrderAdmin(adminOf(f, "x", []).ctx, a.orderId))).toBe("AUTH_FORBIDDEN");
    expect((await getOrderAdmin(adminOf(f).ctx, b.orderId)).userRef).toBe(u2);
    expect(a.number).not.toBe(b.number);
  });
});

describe("gateway payment", () => {
  it("a redirect alone never pays: an unanswered verification leaves the order unpaid with nothing delivered; the verified payment then settles and delivers", async () => {
    const { variantId, codes } = await stockedVariant(f, 2);
    const user = userId();
    const r = await gatewayCheckout(f, user, [{ variantId, quantity: 1 }]);
    const calls0 = f.policy.calls.length;
    const redirect = await confirmGatewayPayment(ordersDeps(f), { gatewayRef: r.gatewayRef, eventKey: "browser-return", raw: { success: true } }); // gateway has no answer
    expect(redirect).toEqual({ outcome: "RETRY_LATER", status: "VERIFYING" });
    expect((await orderRow(f, r.orderId)).status).toBe("PENDING_PAYMENT");
    expect((await f.t.pool.query("select count(*)::int c from fulfillment_tasks where order_ref = $1", [r.orderId])).rows[0].c).toBe(0);
    f.clock.advance(121_000);
    expect(await paid(r, 1_000_000)).toMatchObject({ outcome: "SUCCEEDED" });
    const o = await getOrder(f.app.db, user, r.orderId);
    expect(o).toMatchObject({ status: "COMPLETED", paymentStatus: "SUCCEEDED" });
    expect(f.policy.calls.length).toBe(calls0 + 1);
    expect(f.policy.calls.at(-1)).toMatchObject({ orderId: r.orderId, method: "GATEWAY", fromSuspense: false });
    const ref = `${(await f.t.pool.query("select id from order_items where order_id = $1", [r.orderId])).rows[0].id}#1`;
    const d = await deliveryStatus(f.app.db, ref);
    expect(d.state).toBe("DELIVERED_UNREVEALED");
    const seen = await withRevealedSecret({ db: f.app.db, keys: f.keys, clock: f.clock }, { deliveryId: d.deliveryId!, actor: { type: "CUSTOMER", id: user } }, (p) => p.toString());
    expect(codes).toContain(seen);
    expect(await withRevealedSecret({ db: f.app.db, keys: f.keys, clock: f.clock }, { deliveryId: d.deliveryId!, actor: { type: "CUSTOMER", id: userId() } }, () => 1).catch((e: { code: string }) => e.code)).toBe("FULFILLMENT_NOT_FOUND"); // delivery belongs to the right customer
    const hist = (await f.t.pool.query("select to_status, actor_id from order_status_history where entity_id = $1 order by id", [r.orderId])).rows;
    expect(hist.map((h) => h.to_status)).toEqual(["PENDING_PAYMENT", "PAID", "COMPLETED"]);
    expect(hist[0].actor_id).toBe(user);
    // duplicate callback after settlement
    expect(await paid(r, 1_000_000)).toMatchObject({ outcome: "FINAL", status: "SUCCEEDED" });
    expect(f.policy.calls.length).toBe(calls0 + 1);
    await healthy();
  });
  it("amount mismatch => payment NEEDS_REVIEW (money in suspense, nothing delivered), order ON_HOLD(PAYMENT_NEEDS_REVIEW); its resolution is blocked (B12/B13)", async () => {
    const { variantId } = await stockedVariant(f, 1);
    const r = await gatewayCheckout(f, userId(), [{ variantId, quantity: 1 }]);
    expect(await paid(r, 900_000)).toMatchObject({ outcome: "NEEDS_REVIEW" });
    const o = await orderRow(f, r.orderId);
    expect(o).toMatchObject({ status: "ON_HOLD", payment_status: "PENDING" });
    const holds = await listOpenHolds(adminOf(f).ctx);
    const h = holds.find((x) => x.orderId === r.orderId)!;
    expect(h.reason).toBe("PAYMENT_NEEDS_REVIEW");
    expect(await code(resolveHold(ordersDeps(f), adminOf(f), h.id, { resolution: "RE_RESERVE", note: "trying to re-reserve this" }))).toBe("ORDER_INVALID");
    expect((await f.t.pool.query("select count(*)::int c from fulfillment_tasks where order_ref = $1", [r.orderId])).rows[0].c).toBe(0);
  });
});

describe("D9 — late payments", () => {
  it("payment verified after the order expired: suspense + ON_HOLD, nothing consumed/sold/delivered, stock released; no TTL extension anywhere", async () => {
    const clock = new ManualClock(f.clock.now());
    const { variantId } = await stockedVariant(f, 1);
    const user = userId();
    const deps = ordersDeps(f, { clock });
    const r = await checkout(deps, { userId: user, paymentMethod: "GATEWAY", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }] });
    const ref = (await f.t.pool.query("select gateway_ref from payments where id = $1", [r.paymentId])).rows[0].gateway_ref as string;
    const resId = (await orderRow(f, r.orderId)).reservation_id as string;
    clock.advance(901_000);
    expect(await expireStale({ ...deps })).toBeGreaterThanOrEqual(1); // other lapsed orders of this shared database expire too
    expect((await orderRow(f, r.orderId)).status).toBe("EXPIRED");
    expect((await f.t.pool.query("select status from inventory_reservations where id = $1", [resId])).rows[0].status).toBe("RELEASED");
    f.gateway.script(ref, { status: "PAID", amount: 1_000_000 });
    const calls0 = f.policy.calls.length;
    expect(await confirmGatewayPayment(deps, { gatewayRef: ref, eventKey: "late-1" })).toMatchObject({ outcome: "SUCCEEDED" });
    const o = await orderRow(f, r.orderId);
    expect(o).toMatchObject({ status: "ON_HOLD", payment_status: "SUCCEEDED" });
    expect(f.policy.calls.length).toBe(calls0); // the D10 policy is NOT invoked for a late payment
    expect((await f.t.pool.query("select status from inventory_reservations where id = $1", [resId])).rows[0].status).toBe("RELEASED"); // never consumed
    expect((await f.t.pool.query("select count(*)::int c from fulfillment_tasks where order_ref = $1", [r.orderId])).rows[0].c).toBe(0);
    expect((await f.t.pool.query("select count(*)::int c from digital_codes where status = 'SOLD' and variant_id = $1", [variantId])).rows[0].c).toBe(0);
    expect((await availability(f.app.db, [variantId]))[0]).toMatchObject({ itemisedAvailable: 1, itemisedReserved: 0 });
    const susp = (await f.t.pool.query("select e.amount from ledger_entries e join ledger_accounts a on a.id = e.account_id join ledger_transactions t on t.id = e.transaction_id where a.code = 'SUSPENSE_UNRESOLVED_RECEIPTS' and t.idempotency_key = $1", [`late:${r.paymentId}`])).rows;
    expect(susp.map((x) => Number(x.amount))).toEqual([1_000_000]);
    expect((await listOpenHolds(adminOf(f).ctx)).find((h) => h.orderId === r.orderId)?.reason).toBe("LATE_PAYMENT_NO_RESERVATION");
    expect((await getOrder(f.app.db, user, r.orderId))?.underReview).toBe(true);
    expect(await sqlCode("update inventory_reservations set expires_at = expires_at + interval '1 hour' where id = $1", [resId])).toBe("PI001");
    await healthy();
  });
  it("payment verified after the hold lapsed but BEFORE the sweeper ran (order still PENDING_PAYMENT) is late too — an expired reservation is never consumed", async () => {
    const clock = new ManualClock(f.clock.now());
    const { variantId } = await stockedVariant(f, 1);
    const deps = ordersDeps(f, { clock });
    const r = await checkout(deps, { userId: userId(), paymentMethod: "GATEWAY", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }] });
    const ref = (await f.t.pool.query("select gateway_ref from payments where id = $1", [r.paymentId])).rows[0].gateway_ref as string;
    const resId = (await orderRow(f, r.orderId)).reservation_id as string;
    clock.advance(900_000); // exactly the expiry instant
    f.gateway.script(ref, { status: "PAID", amount: 1_000_000 });
    await confirmGatewayPayment(deps, { gatewayRef: ref, eventKey: "edge" });
    expect((await orderRow(f, r.orderId)).status).toBe("ON_HOLD");
    expect((await f.t.pool.query("select status, consumed_at from inventory_reservations where id = $1", [resId])).rows[0]).toMatchObject({ status: "RELEASED", consumed_at: null });
  });
  it("a payment arriving for a CANCELLED order follows the same path", async () => {
    const { variantId } = await stockedVariant(f, 1);
    const user = userId();
    const r = await gatewayCheckout(f, user, [{ variantId, quantity: 1 }]);
    expect(await cancelOrder(ordersDeps(f), { orderId: r.orderId, by: { type: "CUSTOMER", userId: user }, reason: "changed my mind" })).toEqual({ status: "CANCELLED", replay: false });
    expect((await availability(f.app.db, [variantId]))[0]).toMatchObject({ itemisedAvailable: 1, itemisedReserved: 0 });
    await paid(r, 1_000_000);
    expect((await orderRow(f, r.orderId)).status).toBe("ON_HOLD");
    expect((await f.t.pool.query("select count(*)::int c from fulfillment_tasks where order_ref = $1", [r.orderId])).rows[0].c).toBe(0);
  });
  it("RE_RESERVE: a human takes a NEW reservation (the lapsed one is never reused), the order settles from suspense, delivers, and the hold closes; insufficient stock keeps it on hold", async () => {
    const clock = new ManualClock(f.clock.now());
    const { variantId } = await stockedVariant(f, 1);
    const user = userId();
    const deps = ordersDeps(f, { clock });
    const r = await checkout(deps, { userId: user, paymentMethod: "GATEWAY", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }] });
    const ref = (await f.t.pool.query("select gateway_ref from payments where id = $1", [r.paymentId])).rows[0].gateway_ref as string;
    const oldRes = (await orderRow(f, r.orderId)).reservation_id as string;
    clock.advance(901_000);
    await expireStale(deps);
    f.gateway.script(ref, { status: "PAID", amount: 1_000_000 });
    await confirmGatewayPayment(deps, { gatewayRef: ref, eventKey: "l" });
    const hold = (await listOpenHolds(adminOf(f).ctx)).find((h) => h.orderId === r.orderId)!;
    // someone else takes the only code first -> re-reservation fails, order stays on hold
    const thief = await checkout(deps, { userId: userId(), paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }] });
    expect(await code(resolveHold(deps, adminOf(f), hold.id, { resolution: "RE_RESERVE", note: "customer paid, retrying stock" }))).toBe("INVENTORY_INSUFFICIENT");
    expect((await orderRow(f, r.orderId)).status).toBe("ON_HOLD");
    await cancelOrder(deps, { orderId: thief.orderId, by: { type: "SYSTEM" }, reason: "free the code" });
    // authorisation and note rules
    expect(await code(resolveHold(deps, adminOf(f, "nobody", []), hold.id, { resolution: "RE_RESERVE", note: "customer paid, retrying stock" }))).toBe("AUTH_FORBIDDEN");
    expect(await code(resolveHold(deps, adminOf(f), hold.id, { resolution: "RE_RESERVE", note: "short" }))).toBe("ORDER_INVALID");
    const calls0 = f.policy.calls.length;
    expect(await resolveHold(deps, adminOf(f, "reviewer-7"), hold.id, { resolution: "RE_RESERVE", note: "customer paid, stock restored by cancel" })).toEqual({ status: "PAID" });
    expect(f.policy.calls.length).toBe(calls0 + 1);
    expect(f.policy.calls.at(-1)).toMatchObject({ orderId: r.orderId, fromSuspense: true });
    const o = await orderRow(f, r.orderId);
    expect(o.status).toBe("COMPLETED");
    expect(o.reservation_id).not.toBe(oldRes);
    expect((await f.t.pool.query("select status from inventory_reservations where id = $1", [oldRes])).rows[0].status).toBe("RELEASED"); // the lapsed one stays closed
    expect((await f.t.pool.query("select status from inventory_reservations where id = $1", [o.reservation_id])).rows[0].status).toBe("CONSUMED");
    expect((await f.t.pool.query("select resolution, resolved_by from order_holds where id = $1", [hold.id])).rows[0]).toEqual({ resolution: "RE_RESERVED", resolved_by: "reviewer-7" });
    expect(await code(resolveHold(deps, adminOf(f), hold.id, { resolution: "RE_RESERVE", note: "resolving it a second time" }))).toBe("ORDER_INVALID");
    await healthy();
  });
  it("KEEP_ON_HOLD only records the review", async () => {
    const clock = new ManualClock(f.clock.now());
    const { variantId } = await stockedVariant(f, 1);
    const deps = ordersDeps(f, { clock });
    const r = await checkout(deps, { userId: userId(), paymentMethod: "GATEWAY", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }] });
    const ref = (await f.t.pool.query("select gateway_ref from payments where id = $1", [r.paymentId])).rows[0].gateway_ref as string;
    clock.advance(901_000);
    f.gateway.script(ref, { status: "PAID", amount: 1_000_000 });
    await confirmGatewayPayment(deps, { gatewayRef: ref, eventKey: "k" });
    const hold = (await listOpenHolds(adminOf(f).ctx)).find((h) => h.orderId === r.orderId)!;
    expect(await resolveHold(deps, adminOf(f), hold.id, { resolution: "KEEP_ON_HOLD", note: "waiting for restock decision" })).toEqual({ status: "ON_HOLD" });
    expect((await f.t.pool.query("select resolved_at from order_holds where id = $1", [hold.id])).rows[0].resolved_at).toBeNull();
  });
});

describe("wallet payment, cancellation and expiry", () => {
  it("wallet order settles in one transaction; an expired one is never paid (it expires, nothing is posted); a failure after the posting rolls EVERYTHING back", async () => {
    const { variantId } = await stockedVariant(f, 3);
    const user = userId();
    const ok = await checkout(ordersDeps(f), { userId: user, paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }] });
    expect(await code(payOrderWithWallet(ordersDeps(f), { userId: "intruder", orderId: ok.orderId }))).toBe("ORDER_NOT_FOUND");
    expect(await payOrderWithWallet(ordersDeps(f), { userId: user, orderId: ok.orderId })).toEqual({ status: "PAID" });
    expect((await orderRow(f, ok.orderId)).status).toBe("COMPLETED");
    expect(await code(payOrderWithWallet(ordersDeps(f), { userId: user, orderId: ok.orderId }))).toBe("ORDER_INVALID");

    const clock = new ManualClock(f.clock.now());
    const exp = await checkout(ordersDeps(f, { clock }), { userId: user, paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }] });
    clock.advance(900_000);
    const calls0 = f.policy.calls.length;
    expect(await code(payOrderWithWallet(ordersDeps(f, { clock }), { userId: user, orderId: exp.orderId }))).toBe("ORDER_EXPIRED");
    expect((await orderRow(f, exp.orderId)).status).toBe("EXPIRED");
    expect(f.policy.calls.length).toBe(calls0);

    const bad = await checkout(ordersDeps(f), { userId: user, paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }] });
    f.policy.failAfterMarker = true;
    const markers0 = (await f.t.pool.query("select count(*)::int c from audit_logs where action = 'orders.test_policy.posted'")).rows[0].c;
    expect(await code(payOrderWithWallet(ordersDeps(f), { userId: user, orderId: bad.orderId }))).toBe("OTHER");
    f.policy.failAfterMarker = false;
    expect((await f.t.pool.query("select count(*)::int c from audit_logs where action = 'orders.test_policy.posted'")).rows[0].c).toBe(markers0); // marker rolled back with the settlement
    expect((await orderRow(f, bad.orderId)).status).toBe("PENDING_PAYMENT");
    expect((await f.t.pool.query("select status from inventory_reservations where id = $1", [(await orderRow(f, bad.orderId)).reservation_id])).rows[0].status).toBe("ACTIVE");
    expect((await f.t.pool.query("select count(*)::int c from fulfillment_tasks where order_ref = $1", [bad.orderId])).rows[0].c).toBe(0);
    await healthy();
  });
  it("cancel: owner or permissioned admin only, releases the reservation idempotently, never touches paid orders", async () => {
    const { variantId } = await stockedVariant(f, 2);
    const user = userId();
    const o = await checkout(ordersDeps(f), { userId: user, paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 2 }] });
    expect(await code(cancelOrder(ordersDeps(f), { orderId: o.orderId, by: { type: "CUSTOMER", userId: "someone" }, reason: "not mine" }))).toBe("ORDER_NOT_FOUND");
    expect(await code(cancelOrder(ordersDeps(f), { orderId: o.orderId, by: { type: "ADMIN", ...adminOf(f, "x", []) }, reason: "support request" }))).toBe("AUTH_FORBIDDEN");
    expect(await cancelOrder(ordersDeps(f), { orderId: o.orderId, by: { type: "ADMIN", ...adminOf(f) }, reason: "support request" })).toEqual({ status: "CANCELLED", replay: false });
    expect(await cancelOrder(ordersDeps(f), { orderId: o.orderId, by: { type: "CUSTOMER", userId: user }, reason: "again" })).toEqual({ status: "CANCELLED", replay: true });
    expect((await availability(f.app.db, [variantId]))[0]).toMatchObject({ itemisedAvailable: 2, itemisedReserved: 0 });
    const p = await checkout(ordersDeps(f), { userId: user, paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }] });
    await payOrderWithWallet(ordersDeps(f), { userId: user, orderId: p.orderId });
    expect(await code(cancelOrder(ordersDeps(f), { orderId: p.orderId, by: { type: "CUSTOMER", userId: user }, reason: "refund please" }))).toBe("ORDER_INVALID");
    expect(await sqlCode("update orders set status = 'EXPIRED' where id = $1", [p.orderId])).toBe("PT001");
  });
  it("expireStale expires only lapsed unpaid orders and returns their stock", async () => {
    const clock = new ManualClock(f.clock.now());
    const { variantId } = await stockedVariant(f, 3);
    const deps = ordersDeps(f, { clock });
    const a = await checkout(deps, { userId: userId(), paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }] });
    clock.advance(500_000);
    const b = await checkout(deps, { userId: userId(), paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }] });
    clock.advance(401_000); // a lapsed (901 s), b not (401 s)
    expect(await expireStale(deps)).toBeGreaterThanOrEqual(1);
    expect((await orderRow(f, a.orderId)).status).toBe("EXPIRED");
    expect((await orderRow(f, b.orderId)).status).toBe("PENDING_PAYMENT");
    expect(await expireStale(deps)).toBe(0);
    expect((await availability(f.app.db, [variantId]))[0]).toMatchObject({ itemisedAvailable: 2, itemisedReserved: 1 });
    await healthy();
  });
});

describe("fulfilment gate and progress", () => {
  it("fulfilment rows cannot exist for unpaid / held / foreign orders, even via raw SQL", async () => {
    const { variantId } = await stockedVariant(f, 2);
    const user = userId();
    const o = await checkout(ordersDeps(f), { userId: user, paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }] });
    const itemId = (await f.t.pool.query("select id from order_items where order_id = $1", [o.orderId])).rows[0].id as string;
    const ins = (ref: string, u: string, order: string, v: string) => sqlCode("insert into fulfillment_tasks (id, order_ref, order_item_ref, user_ref, variant_id, method, status, payment_ref, created_at, updated_at) values (gen_random_uuid(), $1, $2, $3, $4, 'AUTO_CODE', 'PENDING', 'p', now(), now())", [order, ref, u, v]);
    expect(await ins(`${itemId}#1`, user, o.orderId, variantId)).toBe("PO001"); // unpaid
    expect(await ins("not-an-item", user, o.orderId, variantId)).toBe("PO001");
    await payOrderWithWallet(ordersDeps(f), { userId: user, orderId: o.orderId });
    const other = (await f.t.pool.query("select id from order_items where order_id = $1", [o.orderId])).rows[0].id as string;
    expect(await ins(`${other}#9`, "another-user", o.orderId, variantId)).toBe("PO001"); // wrong customer
    expect(await ins(`${other}#9`, user, "00000000-0000-7000-8000-000000000001", variantId)).toBe("PO001"); // wrong order
    expect(await ins(`${other}#9`, user, o.orderId, (await stockedVariant(f, 0)).variantId)).toBe("PO001"); // wrong variant
  });
  it("order status follows the tasks (source of truth): manual item -> FULFILLING until an admin completes it, then COMPLETED; supplier items wait for the supplier path", async () => {
    const m = await sellableVariant(f, "MANUAL");
    await adjustStock({ db: f.app.db, clock: f.clock, keys: f.keys, actor: { type: "ADMIN", id: "a" }, authorize: async () => undefined }, m, 5, "opening manual stock");
    const user = userId();
    const o = await checkout(ordersDeps(f), { userId: user, paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId: m, quantity: 1 }] });
    await payOrderWithWallet(ordersDeps(f), { userId: user, orderId: o.orderId });
    expect((await orderRow(f, o.orderId)).status).toBe("FULFILLING");
    const task = (await f.t.pool.query("select id from fulfillment_tasks where order_ref = $1", [o.orderId])).rows[0].id as string;
    const fc = { db: f.app.db, clock: f.clock, keys: f.keys, actor: { type: "ADMIN" as const, id: "carol" }, authorize: async () => undefined };
    await claimManualTask(fc, task);
    await completeManualTask(fc, task, "manual credential 123");
    expect(await syncFulfillment(ordersDeps(f), o.orderId)).toBe("COMPLETED");
    expect(await syncFulfillment(ordersDeps(f), o.orderId)).toBe("COMPLETED");

    const s = await readySupplier(f, ["OS1"]);
    const sv = await routedVariant(f, [s.products.OS1!]);
    const so = await checkout(ordersDeps(f), { userId: user, paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId: sv, quantity: 1 }] });
    expect((await orderRow(f, so.orderId)).reservation_id).toBeNull(); // supplier-backed: nothing to reserve
    await payOrderWithWallet(ordersDeps(f), { userId: user, orderId: so.orderId });
    expect((await orderRow(f, so.orderId)).status).toBe("FULFILLING");
    expect((await f.t.pool.query("select method, status from fulfillment_tasks where order_ref = $1", [so.orderId])).rows).toEqual([{ method: "SUPPLIER_API", status: "PENDING" }]);
  });
  it("audit: every state change names its actor; nothing secret is stored", async () => {
    const actions = new Set((await f.t.pool.query("select distinct action from audit_logs where action like 'orders.%'")).rows.map((r) => r.action as string));
    for (const a of ["orders.order.created", "orders.order.paid", "orders.order.cancelled", "orders.order.expired", "orders.order.late_payment_hold", "orders.hold.resolved", "orders.order.payment_needs_review"]) expect(actions.has(a), a).toBe(true);
    expect((await f.t.pool.query("select count(*)::int c from order_status_history where actor_id is null")).rows[0].c).toBe(0);
    const dump = JSON.stringify((await f.t.pool.query("select * from audit_logs where action like 'orders.%'")).rows);
    expect(dump).not.toMatch(/gateway_ref|tg-/);
  });
});
