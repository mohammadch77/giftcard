import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adjustStock } from "@/modules/inventory";
import { adminWalletCredit, ensureAccount, getBalance, post, systemAccount, verifyIntegrity, walletAccount } from "@/modules/ledger";
import { approveRefund, checkout, confirmGatewayPayment, executeRefund, payOrderWithWallet, requestRefund } from "@/modules/orders";
import { TestBookingPolicy } from "@/modules/orders/testing/booking-policy";
import { withTransaction } from "@/platform/db";
import { sellableVariant } from "../helpers/inventory";
import { adminOf, orderFixture, ordersDeps, uniqKey, userId } from "../helpers/orders";
import type { OrderFixture } from "../helpers/orders";

let f: OrderFixture;
beforeAll(async () => { f = await orderFixture(); });
afterAll(async () => { await f?.app.close(); await f?.t.drop(); });

const all = <T>(k: number, fn: (i: number) => Promise<T>) => Promise.all(Array.from({ length: k }, (_, i) => fn(i)));
const safe = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: { code?: string }) => ({ ok: false as const, code: e.code ?? "ERR" }));
const q = async <T = Record<string, unknown>>(s: string, p: unknown[] = []) => (await f.t.pool.query(s, p)).rows as T[];
const booking = new TestBookingPolicy();
const bd = () => ordersDeps(f, { policy: booking });
const adm = (id: string) => adminOf(f, id);

async function manualVariant(): Promise<string> {
  const v = await sellableVariant(f, "MANUAL");
  await adjustStock({ db: f.app.db, clock: f.clock, keys: f.keys, actor: { type: "ADMIN", id: "a" }, authorize: async () => undefined }, v, 50, "opening manual stock");
  return v;
}
async function paidWallet() {
  const user = userId();
  const actor = { type: "SYSTEM" as const, id: "system:test" };
  await withTransaction(f.app.db, async (tx) => {
    await ensureAccount(tx, walletAccount(user), actor);
    await ensureAccount(tx, systemAccount("ADJUSTMENT_EXPENSE"), actor);
    await post(tx, { kind: "ADMIN_ADJUSTMENT", idempotencyKey: `fund:${user}`, reference: { type: "user", id: user }, entries: adminWalletCredit({ userId: user, amount: 3_000_000 }), reason: "test funding", actor });
  });
  const o = await checkout(bd(), { userId: user, paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId: await manualVariant(), quantity: 1 }] });
  await payOrderWithWallet(bd(), { userId: user, orderId: o.orderId });
  return { user, orderId: o.orderId };
}
async function paidGateway() {
  const o = await checkout(bd(), { userId: userId(), paymentMethod: "GATEWAY", idempotencyKey: uniqKey(), lines: [{ variantId: await manualVariant(), quantity: 1 }] });
  const ref = (await q<{ gateway_ref: string }>("select gateway_ref from payments where id = $1", [o.paymentId]))[0]!.gateway_ref;
  f.gateway.script(ref, { status: "PAID", amount: 1_000_000 });
  await confirmGatewayPayment(bd(), { gatewayRef: ref, eventKey: `ev-${Math.random()}` });
  return o.orderId;
}
const ledgerCount = async () => Number((await q("select count(*)::int c from ledger_transactions"))[0]!.c);

describe("refund races (2b-9)", () => {
  it("40 parallel identical requests create ONE refund (the rest are replays)", async () => {
    const { orderId } = await paidWallet();
    const rs = await all(40, () => safe(requestRefund(bd(), { type: "ADMIN", ...adm("requester") }, { orderId, destination: "WALLET", reasonCode: "CUSTOMER_REQUEST" })));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(new Set(rs.map((r) => (r as { v: { refund: { id: string } } }).v.refund.id)).size).toBe(1);
    expect(rs.filter((r) => r.ok && !r.v.replay).length).toBe(1);
    expect(Number((await q("select count(*)::int c from refunds where order_id = $1", [orderId]))[0]!.c)).toBe(1);
  });
  it("two approvers racing: exactly one decision is recorded", async () => {
    const { orderId } = await paidWallet();
    const r = await requestRefund(bd(), { type: "ADMIN", ...adm("requester") }, { orderId, destination: "WALLET", reasonCode: "CUSTOMER_REQUEST" });
    const rs = await all(12, (i) => safe(approveRefund(bd(), adm(`approver-${i % 3}`), r.refund.id, { note: "approved after review" })));
    const row = (await q<{ status: string; decided_by: string }>("select status, decided_by from refunds where id = $1", [r.refund.id]))[0]!;
    expect(row.status).toBe("APPROVED");
    expect(rs.filter((x) => x.ok).length).toBeGreaterThanOrEqual(1);
    for (const x of rs) if (!x.ok) expect(x.code).toBe("REFUND_INVALID");
    expect(Number((await q("select count(*)::int c from refund_status_history where entity_id = $1 and to_status = 'APPROVED'", [r.refund.id]))[0]!.c)).toBe(1);
  });
  it("25 parallel executions of one wallet refund post exactly ONE reversal and restore the wallet once", async () => {
    const { user, orderId } = await paidWallet();
    const r = await requestRefund(bd(), { type: "ADMIN", ...adm("requester") }, { orderId, destination: "WALLET", reasonCode: "CUSTOMER_REQUEST" });
    await approveRefund(bd(), adm("approver"), r.refund.id, { note: "approved after review" });
    const l0 = await ledgerCount();
    const rs = await all(25, () => safe(executeRefund(bd(), adm("exec"), r.refund.id)));
    expect(rs.every((x) => x.ok), JSON.stringify(rs.filter((x) => !x.ok))).toBe(true);
    expect(await ledgerCount()).toBe(l0 + 1);
    expect(await getBalance(f.app.db, walletAccount(user))).toBe(3_000_000);
    expect(await verifyIntegrity(f.app.db)).toEqual([]);
  });
  it("15 parallel executions of one GATEWAY refund send the gateway request ONCE and complete once", async () => {
    f.gateway.refundMode = "accept"; f.gateway.refundVerify = "REFUNDED"; f.gateway.capabilities = { refund: true, refundIdempotent: false };
    const orderId = await paidGateway();
    const r = await requestRefund(bd(), { type: "ADMIN", ...adm("requester") }, { orderId, destination: "GATEWAY", reasonCode: "CUSTOMER_REQUEST" });
    await approveRefund(bd(), adm("approver"), r.refund.id, { note: "approved after review" });
    const l0 = await ledgerCount();
    const sent0 = f.gateway.refundCalls.filter((c) => c.refundId === r.refund.id).length;
    const rs = await all(15, () => safe(executeRefund(bd(), adm("exec"), r.refund.id)));
    expect(rs.filter((x) => !x.ok), JSON.stringify(rs.filter((x) => !x.ok))).toEqual([]);
    expect(f.gateway.refundCalls.filter((c) => c.refundId === r.refund.id).length - sent0).toBe(1); // never a second refund at the gateway
    // whoever lost the race may have only verified; a final execute converges to COMPLETED
    expect(await executeRefund(bd(), adm("exec"), r.refund.id)).toMatchObject({ status: "COMPLETED" });
    expect(await ledgerCount()).toBe(l0 + 1);
    expect((await q("select status, external_outcome from refunds where id = $1", [r.refund.id]))[0]).toEqual({ status: "COMPLETED", external_outcome: "CONFIRMED" });
    expect(await verifyIntegrity(f.app.db)).toEqual([]);
  });
});
