import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adjustStock } from "@/modules/inventory";
import { adminWalletCredit, ensureAccount, post, systemAccount, walletAccount } from "@/modules/ledger";
import { checkout, payOrderWithWallet, requestRefund } from "@/modules/orders";
import { TestBookingPolicy } from "@/modules/orders/testing/booking-policy";
import { withTransaction } from "@/platform/db";
import { pgCode } from "../helpers/db";
import { sellableVariant } from "../helpers/inventory";
import { orderFixture, ordersDeps, stockedVariant, uniqKey, userId } from "../helpers/orders";
import type { OrderFixture } from "../helpers/orders";

let f: OrderFixture;
const booking = new TestBookingPolicy();
beforeAll(async () => { f = await orderFixture(); });
afterAll(async () => { await f?.app.close(); await f?.t.drop(); });

const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? "OTHER"; } return "NO_ERROR"; };
const q = async <T = Record<string, unknown>>(s: string, p: unknown[] = []) => (await f.t.pool.query(s, p)).rows as T[];
const ownerSql = (s: string, p: unknown[] = []) => f.t.pool.query(s, p).then(() => "ok", (e: unknown) => pgCode(e));
const appSql = (s: string, p: unknown[] = []) => f.app.pool.query(s, p).then(() => "ok", (e: unknown) => pgCode(e));
const restoreActivePolicy = async () => {
  await f.t.pool.query("update refund_policy_versions set active = false where active");
  await f.t.pool.query("update refund_policy_versions set active = true where version = 'temporary-0'");
};
const bd = () => ordersDeps(f, { policy: booking });

async function fund(user: string, amount: number): Promise<void> {
  const actor = { type: "SYSTEM" as const, id: "system:test" };
  await withTransaction(f.app.db, async (tx) => {
    await ensureAccount(tx, walletAccount(user), actor);
    await ensureAccount(tx, systemAccount("ADJUSTMENT_EXPENSE"), actor);
    await post(tx, { kind: "ADMIN_ADJUSTMENT", idempotencyKey: `fund:${user}`, reference: { type: "user", id: user }, entries: adminWalletCredit({ userId: user, amount }), reason: "test funding", actor });
  });
}
/** A MANUAL item stays undelivered after payment, i.e. in the only state whose refund can be requested/evaluated end to end. */
async function paidWalletOrder() {
  const user = userId();
  await fund(user, 5_000_000);
  const v = await sellableVariant(f, "MANUAL");
  await adjustStock({ db: f.app.db, clock: f.clock, keys: f.keys, actor: { type: "ADMIN", id: "a" }, authorize: async () => undefined }, v, 50, "opening manual stock");
  const o = await checkout(bd(), { userId: user, paymentMethod: "WALLET", idempotencyKey: uniqKey(), lines: [{ variantId: v, quantity: 1 }] });
  await payOrderWithWallet(bd(), { userId: user, orderId: o.orderId });
  return { user, orderId: o.orderId };
}

describe("order-time policy snapshots (P1-A)", () => {
  it("checkout records the refund policy version, reservation TTL + settings version and the fulfilment rules from authoritative server-side data", async () => {
    const { variantId } = await stockedVariant(f, 2);
    const r = await checkout(ordersDeps(f), { userId: userId(), paymentMethod: "GATEWAY", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }] });
    const o = (await q<{ refund_policy_version: string; policy_snapshot: Record<string, unknown>; created_at: Date }>("select refund_policy_version, policy_snapshot, created_at from orders where id = $1", [r.orderId]))[0]!;
    expect(o.refund_policy_version).toBe("temporary-0");
    const snap = o.policy_snapshot as { fulfillmentRules: Record<string, string[]> };
    expect(snap).toMatchObject({ schema: 1, backfilled: false, refundPolicyVersion: "temporary-0", reservationTtlSeconds: 900, orderSettingsVersion: 1, itemFulfillmentMethods: ["AUTO_CODE"], capturedAt: o.created_at.toISOString() });
    const productType = (await q<{ t: string }>("select p.type t from products p join product_variants v on v.product_id = p.id where v.id = $1", [variantId]))[0]!.t;
    const dbRules = (await q<{ method: string }>("select method from product_type_fulfillment where product_type = $1 order by method", [productType])).map((x) => x.method);
    expect(snap.fulfillmentRules).toEqual({ [productType]: dbRules }); // exactly the matrix rows in force, nothing else
    expect(snap.fulfillmentRules[productType]).toContain("AUTO_CODE");
  });

  it("is immutable: neither the owner nor the application can rewrite it, and it must agree with the typed column", async () => {
    const { orderId } = await paidWalletOrder();
    expect(await ownerSql("update orders set refund_policy_version = 'temporary-0' where id = $1", [orderId])).toBe("ok"); // same value: not a change
    expect(await ownerSql("update orders set policy_snapshot = '{}'::jsonb where id = $1", [orderId])).toBe("PI001");
    expect(await ownerSql("update orders set policy_snapshot = jsonb_set(policy_snapshot, '{reservationTtlSeconds}', '3600') where id = $1", [orderId])).toBe("PI001");
    expect(await appSql("update orders set policy_snapshot = '{}'::jsonb where id = $1", [orderId])).toBe("42501");
    expect(await appSql("update orders set refund_policy_version = 'temporary-0' where id = $1", [orderId])).toBe("42501");
    expect(await ownerSql("insert into refund_policy_versions (version, status, legal_review_required, active, description, created_at) values ('other-v', 'TEMPORARY', true, false, 'probe', now())")).toBe("ok");
    expect(await ownerSql("update orders set refund_policy_version = 'other-v' where id = $1", [orderId])).toBe("PI001");
    // typed column and JSON snapshot cannot disagree (CHECK), proven with a raw insert that is never committed
    const c = await f.t.pool.connect();
    try {
      await c.query("begin");
      const err = await c
        .query(`insert into orders (id, number, user_ref, payment_method, total, pricing_version, refund_policy_version, policy_snapshot, idempotency_key, request_hash, expires_at, created_at, updated_at)
                values (gen_random_uuid(), 'N-PROBE', 'u', 'WALLET', 10, 'x', 'temporary-0', '{"refundPolicyVersion":"other-v"}'::jsonb, 'probe', '\\x00', now(), now(), now())`)
        .then(() => "ok", (e: unknown) => pgCode(e));
      expect(err).toBe("23514");
    } finally {
      await c.query("rollback");
      c.release();
    }
    // a policy version recorded on an order must exist (foreign key)
    expect(await ownerSql("insert into orders (id, number, user_ref, payment_method, total, pricing_version, refund_policy_version, policy_snapshot, idempotency_key, request_hash, expires_at, created_at, updated_at) values (gen_random_uuid(), 'N-PROBE2', 'u', 'WALLET', 10, 'x', 'no-such-version', '{\"refundPolicyVersion\":\"no-such-version\"}'::jsonb, 'probe2', decode('00', 'hex'), now(), now(), now())")).toBe("23503");
  });

  it("refund evaluation uses the order's RECORDED policy version, not the currently active one", async () => {
    const before = await paidWalletOrder(); // created under 'temporary-0'
    // A new FINAL policy becomes active: nothing is refundable any more.
    await f.t.pool.query("update refund_policy_versions set active = false where active");
    await f.t.pool.query("insert into refund_policy_versions (version, status, legal_review_required, active, description, created_at) values ('final-probe', 'FINAL', false, true, 'probe: nothing refundable', now())");
    await f.t.pool.query(`insert into refund_policy_rules (version, disclosure_state, decision) values
      ('final-probe', 'NOT_DELIVERED', 'DENIED'), ('final-probe', 'DELIVERED_UNREVEALED', 'DENIED'), ('final-probe', 'REVEALED_BY_CUSTOMER', 'DENIED'), ('final-probe', 'REVEALED_BY_ADMIN_ONLY', 'DENIED')`);
    try {
      const after = await paidWalletOrder(); // created under 'final-probe'
      expect((await q<{ v: string }>("select refund_policy_version v from orders where id = $1", [before.orderId]))[0]!.v).toBe("temporary-0");
      expect((await q<{ v: string }>("select refund_policy_version v from orders where id = $1", [after.orderId]))[0]!.v).toBe("final-probe");

      const rb = await requestRefund(bd(), { type: "CUSTOMER", userId: before.user }, { orderId: before.orderId, destination: "WALLET", reasonCode: "CUSTOMER_REQUEST" });
      expect(rb.refund).toMatchObject({ policyVersion: "temporary-0", decision: "ELIGIBLE" }); // the terms it was sold under
      const ra = await requestRefund(bd(), { type: "CUSTOMER", userId: after.user }, { orderId: after.orderId, destination: "WALLET", reasonCode: "CUSTOMER_REQUEST" });
      expect(ra.refund).toMatchObject({ policyVersion: "final-probe", decision: "DENIED" });
    } finally {
      await restoreActivePolicy();
    }
  });

  it("checkout fails closed when no refund policy is active (nothing is written)", async () => {
    const { variantId } = await stockedVariant(f, 1);
    const n = Number((await q("select count(*)::int c from orders"))[0]!.c);
    await f.t.pool.query("update refund_policy_versions set active = false where active");
    try {
      expect(await code(checkout(ordersDeps(f), { userId: userId(), paymentMethod: "GATEWAY", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }] }))).toBe("ORDER_REFUND_POLICY_NOT_CONFIGURED");
    } finally {
      await restoreActivePolicy();
    }
    expect(Number((await q("select count(*)::int c from orders"))[0]!.c)).toBe(n);
  });

  it("a later tightening of the fulfilment-compatibility matrix does not rewrite what an existing order was sold under", async () => {
    const { variantId } = await stockedVariant(f, 1);
    const r = await checkout(ordersDeps(f), { userId: userId(), paymentMethod: "GATEWAY", idempotencyKey: uniqKey(), lines: [{ variantId, quantity: 1 }] });
    const rulesBefore = (await q<{ policy_snapshot: unknown }>("select policy_snapshot from orders where id = $1", [r.orderId]))[0]!.policy_snapshot;
    const productType = (await q<{ t: string }>("select p.type t from products p join product_variants v on v.product_id = p.id where v.id = $1", [variantId]))[0]!.t;
    const c = await f.t.pool.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      await c.query("delete from product_type_fulfillment where product_type = $1 and method <> 'AUTO_CODE'", [productType]);
      const after = (await c.query("select policy_snapshot from orders where id = $1", [r.orderId])).rows[0].policy_snapshot;
      expect(after).toEqual(rulesBefore);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});
