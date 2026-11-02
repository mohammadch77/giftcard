import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importCodes, consume, reserve } from "@/modules/inventory";
import { claimManualTask, createTasks, deliverAutoCodes, deliveryStatus, fulfillSupplierTask, withRevealedSecret } from "@/modules/fulfillment";
import type { FulfillmentAdminContext } from "@/modules/fulfillment";
import { createSupplierOrder, reconcileSupplierOrder, submitSupplierOrder } from "@/modules/suppliers";
import { withTransaction } from "@/platform/db";
import { makeCodes, sellableVariant } from "../helpers/inventory";
import { invCtx } from "../helpers/inventory";
import { readySupplier, routedVariant, seedPaidOrder, supplierFixture } from "../helpers/suppliers";
import type { SupplierFixture } from "../helpers/suppliers";

let f: SupplierFixture;
beforeAll(async () => {
  f = await supplierFixture();
});
afterAll(async () => {
  await f?.app.close();
  await f?.t.drop();
});

let n = 0;
const uid = (p = "x") => `${p}-${++n}-${Math.random().toString(36).slice(2, 6)}`;
const all = <T>(k: number, fn: (i: number) => Promise<T>) => Promise.all(Array.from({ length: k }, (_, i) => fn(i)));
const fdeps = () => ({ ...f.deps, db: f.app.db });
const mkTask = async (variantId: string, user = "u") => {
  const so = await seedPaidOrder(f, user, [{ variantId }]);
  const orderItemRef = so.refs[0]!;
  await withTransaction(f.app.db, (tx) => createTasks(tx, f.clock, { orderRef: so.orderId, userRef: user, paymentRef: "p", items: [{ orderItemRef, variantId }] }));
  return { orderItemRef, id: (await f.t.pool.query("select id from fulfillment_tasks where order_item_ref = $1", [orderItemRef])).rows[0].id as string };
};

describe("C4 — duplicate supplier submission", () => {
  it("50 parallel submissions of one supplier order reach the supplier exactly once", async () => {
    const { products } = await readySupplier(f, ["C1"]);
    const k = uid("key");
    const o = (await withTransaction(f.app.db, (tx) => createSupplierOrder(tx, f.clock, { supplierProductId: products.C1!, orderItemRef: uid("i"), quantity: 1, idempotencyKey: k }))).order;
    f.supplier.script(k, { kind: "SLOW_CONFIRM", ms: 80, deliverables: ["C4-CODE"] });
    const res = await all(50, () => submitSupplierOrder(f.app.db, f.deps, o.id));
    expect(res.filter((r) => r.outcome === "CONFIRMED")).toHaveLength(1);
    expect(res.filter((r) => r.outcome === "NOT_SUBMITTABLE")).toHaveLength(49);
    expect(f.supplier.attempts.get(k)).toBe(1);
    expect((await f.t.pool.query("select count(*)::int c from supplier_order_secrets where supplier_order_id = $1", [o.id])).rows[0].c).toBe(1);
  });

  it("30 parallel fulfilments of one task buy once, deliver once and complete once", async () => {
    const s = await readySupplier(f, ["C2"]);
    const v = await routedVariant(f, [s.products.C2!]);
    const t = await mkTask(v);
    const k = `fulfil:${t.orderItemRef}:${s.products.C2}`;
    f.supplier.script(k, { kind: "SLOW_CONFIRM", ms: 60, deliverables: ["C2-CODE"] });
    const res = await all(30, () => fulfillSupplierTask(fdeps(), t.id));
    expect(res.filter((r) => r.outcome === "COMPLETED").length).toBeGreaterThanOrEqual(1);
    expect(res.every((r) => ["COMPLETED", "RETRYABLE", "NOT_APPLICABLE", "AWAITING_RECONCILIATION"].includes(r.outcome))).toBe(true);
    expect(f.supplier.attempts.get(k)).toBe(1);
    expect((await f.t.pool.query("select count(*)::int c from deliveries where order_item_ref = $1", [t.orderItemRef])).rows[0].c).toBe(1);
    expect((await f.t.pool.query("select count(*)::int c from fulfillment_events where task_id = $1 and type = 'DELIVERED'", [t.id])).rows[0].c).toBe(1);
    expect((await f.t.pool.query("select status from fulfillment_tasks where id = $1", [t.id])).rows[0].status).toBe("COMPLETED");
  });

  it("10 concurrent reconciliations of one UNKNOWN order settle it once", async () => {
    const { products } = await readySupplier(f, ["C3"]);
    const k = uid("key");
    const o = (await withTransaction(f.app.db, (tx) => createSupplierOrder(tx, f.clock, { supplierProductId: products.C3!, orderItemRef: uid("i"), quantity: 1, idempotencyKey: k }))).order;
    f.supplier.script(k, { kind: "TIMEOUT_AFTER_EXECUTE", deliverables: ["C3-CODE"] });
    await submitSupplierOrder(f.app.db, f.deps, o.id);
    const res = await all(10, () => reconcileSupplierOrder(f.app.db, f.deps, o.id));
    expect(res.filter((r) => r.outcome === "CONFIRMED")).toHaveLength(1);
    expect(res.filter((r) => r.outcome === "NOT_UNKNOWN")).toHaveLength(9);
    expect((await f.t.pool.query("select count(*)::int c from supplier_order_secrets where supplier_order_id = $1", [o.id])).rows[0].c).toBe(1);
    expect(f.supplier.attempts.get(k)).toBe(1);
  });
});

describe("manual claims and reveals", () => {
  it("20 administrators claim one manual task: exactly one wins", async () => {
    const v = await sellableVariant(f, "MANUAL");
    const t = await mkTask(v);
    const ctx = (id: string): FulfillmentAdminContext => ({ db: f.app.db, clock: f.clock, keys: f.keys, actor: { type: "ADMIN", id }, authorize: async () => undefined });
    const out = await all(20, (i) => claimManualTask(ctx(`admin-${i}`), t.id).then(() => "OK", (e: { code?: string }) => e.code ?? "ERR"));
    expect(out.filter((o) => o === "OK")).toHaveLength(1);
    expect(out.filter((o) => o === "FULFILLMENT_INVALID")).toHaveLength(19);
    expect((await f.t.pool.query("select count(*)::int c from fulfillment_events where task_id = $1 and type = 'CLAIMED'", [t.id])).rows[0].c).toBe(1);
  });

  it("100 parallel reveals: counters and access log stay exact (and the per-actor limit holds)", async () => {
    const v = await sellableVariant(f, "AUTO_CODE");
    await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: makeCodes(1) });
    const key = uid("r");
    const res = await withTransaction(f.app.db, (tx) => reserve(tx, f.clock, { reservationKey: key, orderRef: key, lines: [{ variantId: v, quantity: 1 }] }));
    const so = await seedPaidOrder(f, "u-rev", [{ variantId: v }]);
    const ref = so.refs[0]!;
    await withTransaction(f.app.db, (tx) => createTasks(tx, f.clock, { orderRef: so.orderId, userRef: "u-rev", paymentRef: "p", items: [{ orderItemRef: ref, variantId: v }] }));
    await withTransaction(f.app.db, (tx) => consume(tx, f.clock, res.reservationId));
    await withTransaction(f.app.db, (tx) => deliverAutoCodes(tx, f.clock, { reservationId: res.reservationId, assignments: [{ variantId: v, orderItemRef: ref }] }));
    const d = (await deliveryStatus(f.app.db, ref)).deliveryId!;
    const out = await all(100, () => withRevealedSecret({ db: f.app.db, keys: f.keys, clock: f.clock }, { deliveryId: d, actor: { type: "CUSTOMER", id: "u-rev" } }, () => 1).then(() => "OK", (e: { code?: string }) => e.code ?? "ERR"));
    const ok = out.filter((o) => o === "OK").length;
    expect(ok).toBe(20);
    expect(out.filter((o) => o === "FULFILLMENT_INVALID")).toHaveLength(80);
    expect((await deliveryStatus(f.app.db, ref)).revealCount).toBe(ok);
    expect((await f.t.pool.query("select count(*)::int c from secret_access_log where delivery_id = $1", [d])).rows[0].c).toBe(ok);
  });

  it("outbox-style redelivery: 20 parallel 'deliver' calls for one consumed reservation deliver once", async () => {
    const v = await sellableVariant(f, "AUTO_CODE");
    await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: makeCodes(2) });
    const key = uid("r");
    const res = await withTransaction(f.app.db, (tx) => reserve(tx, f.clock, { reservationKey: key, orderRef: key, lines: [{ variantId: v, quantity: 2 }] }));
    const so = await seedPaidOrder(f, "u", [{ variantId: v, qty: 2 }]);
    const refs = so.refs;
    await withTransaction(f.app.db, (tx) => createTasks(tx, f.clock, { orderRef: so.orderId, userRef: "u", paymentRef: "p", items: refs.map((orderItemRef) => ({ orderItemRef, variantId: v })) }));
    await withTransaction(f.app.db, (tx) => consume(tx, f.clock, res.reservationId));
    const out = await all(20, () => withTransaction(f.app.db, (tx) => deliverAutoCodes(tx, f.clock, { reservationId: res.reservationId, assignments: refs.map((orderItemRef) => ({ variantId: v, orderItemRef })) })));
    expect(out.reduce((s, r) => s + r.delivered, 0)).toBe(2);
    expect((await f.t.pool.query("select count(*)::int c from deliveries where order_item_ref = any($1)", [refs])).rows[0].c).toBe(2);
  });
});
