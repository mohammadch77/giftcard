import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importCodes, consume, reserve } from "@/modules/inventory";
import { claimManualTask, completeManualTask, createTasks, deliverAutoCodes, deliveryStatus, fulfillSupplierTask, getTask, listTasksAdmin, withRevealedSecret } from "@/modules/fulfillment";
import type { FulfillmentAdminContext } from "@/modules/fulfillment";
import { reconcileSupplierOrder, updateSupplier } from "@/modules/suppliers";
import { withTransaction } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { adjustStock } from "@/modules/inventory";
import { ManualClock } from "@/platform/clock/testing";
import { pgCode } from "../helpers/db";
import { invCtx, makeCodes, sellableVariant } from "../helpers/inventory";
import { CANARY, readySupplier, routedVariant, supCtx, supplierFixture } from "../helpers/suppliers";
import type { SupplierFixture } from "../helpers/suppliers";

let f: SupplierFixture;
beforeAll(async () => {
  f = await supplierFixture();
});
afterAll(async () => {
  await f?.app.close();
  await f?.t.drop();
});

const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? "OTHER"; } return "NO_ERROR"; };
const sqlCode = (q: string, p: unknown[] = []) => f.t.pool.query(q, p).then(() => "ok", (e: unknown) => pgCode(e));
let n = 0;
const uid = (p = "x") => `${p}-${++n}-${Math.random().toString(36).slice(2, 6)}`;
const ctx = (actorId: string, allowed: "all" | string[] = "all"): FulfillmentAdminContext => ({
  db: f.app.db, clock: f.clock, keys: f.keys, actor: { type: "ADMIN", id: actorId },
  authorize: async (p) => { if (allowed !== "all" && !allowed.includes(p)) throw new DomainError("AUTH_FORBIDDEN", "no"); },
});
const rdeps = () => ({ db: f.app.db, keys: f.keys, clock: f.clock });
const fdeps = () => ({ ...f.deps, db: f.app.db });
const task = async (variantId: string, user = "user-1") => {
  const orderItemRef = uid("item");
  await withTransaction(f.app.db, (tx) => createTasks(tx, f.clock, { orderRef: uid("order"), userRef: user, paymentRef: "pay-1", items: [{ orderItemRef, variantId }] }));
  const id = (await f.t.pool.query("select id from fulfillment_tasks where order_item_ref = $1", [orderItemRef])).rows[0].id as string;
  return { id, orderItemRef };
};
const dumpSecrets = async () => ["deliveries", "delivery_secrets", "fulfillment_tasks", "fulfillment_events", "secret_access_log", "supplier_order_secrets", "audit_logs", "outbox_events", "digital_codes"]
  .reduce(async (a, t) => (await a) + JSON.stringify((await f.t.pool.query(`select * from ${t}`)).rows), Promise.resolve(""));

describe("tasks", () => {
  it("one task per paid order item (idempotent), method taken from the catalog variant; queue is permissioned", async () => {
    const [a, m, s] = [await sellableVariant(f, "AUTO_CODE"), await sellableVariant(f, "MANUAL"), await sellableVariant(f, "SUPPLIER_API")];
    const refs = [uid("i"), uid("i"), uid("i")];
    const input = { orderRef: uid("o"), userRef: "u1", paymentRef: "pay-9", items: [{ orderItemRef: refs[0]!, variantId: a }, { orderItemRef: refs[1]!, variantId: m }, { orderItemRef: refs[2]!, variantId: s }] };
    expect(await withTransaction(f.app.db, (tx) => createTasks(tx, f.clock, input))).toEqual({ created: 3, existing: 0 });
    expect(await withTransaction(f.app.db, (tx) => createTasks(tx, f.clock, input))).toEqual({ created: 0, existing: 3 });
    const methods = (await f.t.pool.query("select method from fulfillment_tasks where order_item_ref = any($1) order by method", [refs])).rows.map((r) => r.method);
    expect(methods).toEqual(["AUTO_CODE", "MANUAL", "SUPPLIER_API"]);
    expect(await code(listTasksAdmin(ctx("x", []), {}))).toBe("AUTH_FORBIDDEN");
    expect((await listTasksAdmin(ctx("x"), { status: "PENDING" })).length).toBeGreaterThanOrEqual(3);
    expect(await code(withTransaction(f.app.db, (tx) => createTasks(tx, f.clock, { ...input, paymentRef: "" })))).toBe("FULFILLMENT_INVALID");
    expect(await sqlCode("update fulfillment_tasks set method = 'MANUAL' where order_item_ref = $1", [refs[0]])).toBe("PI001");
  });
});

describe("inventory-backed delivery and reveal", () => {
  async function paidAutoOrder(user: string, secrets: string[], ttl = 900) {
    const v = await sellableVariant(f, "AUTO_CODE");
    await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: secrets });
    const key = uid("res");
    const res = await withTransaction(f.app.db, (tx) => reserve(tx, f.clock, { reservationKey: key, orderRef: `o-${key}`, ttlSeconds: ttl, lines: [{ variantId: v, quantity: secrets.length }] }));
    const refs = secrets.map(() => uid("item"));
    await withTransaction(f.app.db, (tx) => createTasks(tx, f.clock, { orderRef: `o-${key}`, userRef: user, paymentRef: "pay-1", items: refs.map((orderItemRef) => ({ orderItemRef, variantId: v })) }));
    return { v, res, refs, assignments: refs.map((orderItemRef) => ({ variantId: v, orderItemRef })) };
  }
  it("consumed reservation -> codes SOLD, deliveries + COMPLETED tasks; replay is a no-op; reveal returns the code to its owner only and tracks disclosure", async () => {
    const user = uid("u");
    const [c1, c2] = makeCodes(2);
    const o = await paidAutoOrder(user, [c1!, c2!]);
    await withTransaction(f.app.db, (tx) => consume(tx, f.clock, o.res.reservationId));
    expect(await withTransaction(f.app.db, (tx) => deliverAutoCodes(tx, f.clock, { reservationId: o.res.reservationId, assignments: o.assignments }))).toEqual({ delivered: 2, replay: false });
    expect(await withTransaction(f.app.db, (tx) => deliverAutoCodes(tx, f.clock, { reservationId: o.res.reservationId, assignments: o.assignments }))).toEqual({ delivered: 0, replay: true });
    expect((await f.t.pool.query("select status from fulfillment_tasks where order_item_ref = any($1)", [o.refs])).rows.map((r) => r.status)).toEqual(["COMPLETED", "COMPLETED"]);
    expect(await deliveryStatus(f.app.db, o.refs[0]!)).toMatchObject({ state: "DELIVERED_UNREVEALED", revealCount: 0 });
    const d = await deliveryStatus(f.app.db, o.refs[0]!);
    expect(await code(withRevealedSecret(rdeps(), { deliveryId: d.deliveryId!, actor: { type: "CUSTOMER", id: "someone-else" } }, () => 1))).toBe("FULFILLMENT_NOT_FOUND"); // IDOR
    expect(await code(withRevealedSecret(rdeps(), { deliveryId: d.deliveryId!, actor: { type: "ADMIN", id: "adm" } }, () => 1))).toBe("FULFILLMENT_INVALID"); // admin needs an authorisation check
    expect(await code(withRevealedSecret(rdeps(), { deliveryId: d.deliveryId!, actor: { type: "ADMIN", id: "adm" }, authorize: async () => { throw new DomainError("AUTH_FORBIDDEN", "no"); } }, () => 1))).toBe("AUTH_FORBIDDEN");
    expect((await deliveryStatus(f.app.db, o.refs[0]!)).revealCount).toBe(0); // refused attempts leave no trace of disclosure
    let held!: Buffer;
    const seen = await withRevealedSecret(rdeps(), { deliveryId: d.deliveryId!, actor: { type: "CUSTOMER", id: user } }, (p) => { held = p; return p.toString(); });
    expect([c1, c2]).toContain(seen);
    expect(held.every((b) => b === 0)).toBe(true);
    expect(await deliveryStatus(f.app.db, o.refs[0]!)).toMatchObject({ state: "REVEALED_BY_CUSTOMER", revealCount: 1 });
    await withRevealedSecret(rdeps(), { deliveryId: d.deliveryId!, actor: { type: "ADMIN", id: "adm" }, authorize: async () => undefined }, () => 1);
    expect((await f.t.pool.query("select actor_type, action from secret_access_log where delivery_id = $1 order by id", [d.deliveryId])).rows).toEqual([{ actor_type: "CUSTOMER", action: "REVEAL" }, { actor_type: "ADMIN", action: "ADMIN_REVEAL" }]);
    const dd = (await f.t.pool.query("select reveal_count, first_revealed_by_type from deliveries where id = $1", [d.deliveryId])).rows[0];
    expect(dd).toEqual({ reveal_count: 2, first_revealed_by_type: "CUSTOMER" });
    expect((await f.t.pool.query("select 1 from outbox_events where event_type = 'fulfillment.delivered' and aggregate_id = any($1)", [o.refs])).rows).toHaveLength(2);
    const all = await dumpSecrets();
    expect(all).not.toContain(c1!);
    expect(all).not.toContain(c2!);
  });
  it("an admin-only reveal is its own disclosure state", async () => {
    const o = await paidAutoOrder("u-adm", makeCodes(1));
    await withTransaction(f.app.db, (tx) => consume(tx, f.clock, o.res.reservationId));
    await withTransaction(f.app.db, (tx) => deliverAutoCodes(tx, f.clock, { reservationId: o.res.reservationId, assignments: o.assignments }));
    const d = await deliveryStatus(f.app.db, o.refs[0]!);
    await withRevealedSecret(rdeps(), { deliveryId: d.deliveryId!, actor: { type: "ADMIN", id: "adm" }, authorize: async () => undefined }, () => 1);
    expect((await deliveryStatus(f.app.db, o.refs[0]!)).state).toBe("REVEALED_BY_ADMIN_ONLY");
  });
  it("reveal logs FIRST: if the log write fails nothing is opened or returned; reveals are rate limited", async () => {
    const o = await paidAutoOrder("u-log", makeCodes(1));
    await withTransaction(f.app.db, (tx) => consume(tx, f.clock, o.res.reservationId));
    await withTransaction(f.app.db, (tx) => deliverAutoCodes(tx, f.clock, { reservationId: o.res.reservationId, assignments: o.assignments }));
    const d = (await deliveryStatus(f.app.db, o.refs[0]!)).deliveryId!;
    await f.t.pool.query("create function public.test_fail_log() returns trigger language plpgsql as $$ begin raise exception 'log failure'; end $$");
    await f.t.pool.query("create trigger test_fail_log before insert on secret_access_log for each row execute function public.test_fail_log()");
    let called = false;
    try {
      expect(await code(withRevealedSecret(rdeps(), { deliveryId: d, actor: { type: "CUSTOMER", id: "u-log" } }, () => { called = true; }))).toBe("OTHER");
    } finally {
      await f.t.pool.query("drop trigger test_fail_log on secret_access_log");
      await f.t.pool.query("drop function public.test_fail_log()");
    }
    expect(called).toBe(false);
    expect((await deliveryStatus(f.app.db, o.refs[0]!)).revealCount).toBe(0);
    const rl = f.clock;
    const outs: string[] = [];
    for (let i = 0; i < 22; i++) outs.push(await code(withRevealedSecret({ ...rdeps(), clock: rl }, { deliveryId: d, actor: { type: "CUSTOMER", id: "u-log" } }, () => 1)));
    expect(outs.filter((x) => x === "NO_ERROR")).toHaveLength(19); // the failed-log attempt above also consumed one of the 20 slots
    expect(outs.filter((x) => x === "FULFILLMENT_INVALID")).toHaveLength(3);
  });
  it("a lapsed or unpaid reservation can never be delivered; DB guards back this up", async () => {
    const clock = new ManualClock(f.clock.now());
    const v = await sellableVariant(f, "AUTO_CODE");
    await importCodes(invCtx(f), v, { payloadKind: "CODE", codes: makeCodes(2) });
    const mkRes = (k: string) => withTransaction(f.app.db, (tx) => reserve(tx, clock, { reservationKey: k, orderRef: k, ttlSeconds: 60, lines: [{ variantId: v, quantity: 1 }] }));
    const late = await mkRes(uid("late"));
    const ref = uid("item");
    await withTransaction(f.app.db, (tx) => createTasks(tx, clock, { orderRef: "o", userRef: "u", paymentRef: "p", items: [{ orderItemRef: ref, variantId: v }] }));
    clock.advance(61_000);
    expect(await withTransaction(f.app.db, (tx) => consume(tx, clock, late.reservationId))).toMatchObject({ outcome: "LATE" });
    expect(await code(withTransaction(f.app.db, (tx) => deliverAutoCodes(tx, clock, { reservationId: late.reservationId, assignments: [{ variantId: v, orderItemRef: ref }] })))).toBe("INVENTORY_INVALID");
    expect((await f.t.pool.query("select status from fulfillment_tasks where order_item_ref = $1", [ref])).rows[0].status).toBe("PENDING");
    expect((await f.t.pool.query("select count(*)::int c from deliveries where order_item_ref = $1", [ref])).rows[0].c).toBe(0);
    // raw SQL: a delivery without a SOLD code of that item, and completing a task without a delivery
    const freeCode = (await f.t.pool.query("select id from digital_codes where variant_id = $1 and status = 'AVAILABLE' limit 1", [v])).rows[0].id;
    expect(await sqlCode("insert into deliveries (id, order_item_ref, user_ref, kind, code_ref, delivered_at) values (gen_random_uuid(), $1, 'u', 'INVENTORY_CODE', $2, now())", [ref, freeCode])).toBe("PF001");
    const cl = await f.t.pool.connect();
    try {
      await cl.query("update fulfillment_tasks set status='PROCESSING' where order_item_ref=$1", [ref]);
      expect(await cl.query("update fulfillment_tasks set status='COMPLETED', completed_at=now() where order_item_ref=$1", [ref]).then(() => "ok", (e: unknown) => pgCode(e))).toBe("PF001");
    } finally {
      cl.release();
    }
    for (const q of ["delete from deliveries", "delete from delivery_secrets", "delete from secret_access_log", "update secret_access_log set action = 'REVEAL'", "delete from fulfillment_events"]) {
      expect(await f.app.pool.query(q).then(() => "ok", (e: unknown) => pgCode(e)), q).toBe("42501");
    }
  });
  it("mixed order: counted (manual) lines are sold with the reservation while only AUTO_CODE tasks get code deliveries", async () => {
    const a = await sellableVariant(f, "AUTO_CODE"), m = await sellableVariant(f, "MANUAL");
    await importCodes(invCtx(f), a, { payloadKind: "CODE", codes: makeCodes(1) });
    await adjustStock(invCtx(f), m, 3, "opening manual stock");
    const key = uid("mix");
    const res = await withTransaction(f.app.db, (tx) => reserve(tx, f.clock, { reservationKey: key, orderRef: key, lines: [{ variantId: a, quantity: 1 }, { variantId: m, quantity: 1 }] }));
    const [ra, rm] = [uid("i"), uid("i")];
    await withTransaction(f.app.db, (tx) => createTasks(tx, f.clock, { orderRef: key, userRef: "u", paymentRef: "p", items: [{ orderItemRef: ra, variantId: a }, { orderItemRef: rm, variantId: m }] }));
    await withTransaction(f.app.db, (tx) => consume(tx, f.clock, res.reservationId));
    expect(await withTransaction(f.app.db, (tx) => deliverAutoCodes(tx, f.clock, { reservationId: res.reservationId, assignments: [{ variantId: a, orderItemRef: ra }, { variantId: m, orderItemRef: rm }] }))).toMatchObject({ delivered: 1 });
    expect((await f.t.pool.query("select order_item_ref, status from fulfillment_tasks where order_item_ref in ($1,$2) order by order_item_ref", [ra, rm])).rows.find((r) => r.order_item_ref === rm)?.status).toBe("PENDING");
  });
});

describe("manual fulfilment", () => {
  it("claim (one winner), only the assignee completes, the secret is sealed, reveal works for the owner; permissions enforced", async () => {
    const v = await sellableVariant(f, "MANUAL");
    const t = await task(v, "u-man");
    expect(await code(claimManualTask(ctx("a", []), t.id))).toBe("AUTH_FORBIDDEN");
    const claimed = await claimManualTask(ctx("alice"), t.id);
    expect(claimed).toMatchObject({ status: "PROCESSING", assignee: "alice" });
    expect(await code(claimManualTask(ctx("bob"), t.id))).toBe("FULFILLMENT_INVALID");
    expect(await code(completeManualTask(ctx("bob"), t.id, "stolen"))).toBe("FULFILLMENT_INVALID");
    expect(await code(completeManualTask(ctx("alice", ["fulfillment.manual.claim"]), t.id, "x"))).toBe("AUTH_FORBIDDEN");
    await completeManualTask(ctx("alice"), t.id, "login: bob / pass: S3cretManual!");
    expect((await getTask(f.app.db, t.id))?.status).toBe("COMPLETED");
    expect(await dumpSecrets()).not.toContain("S3cretManual!");
    expect(await dumpSecrets()).not.toContain("login: bob");
    const d = (await deliveryStatus(f.app.db, t.orderItemRef)).deliveryId!;
    expect(await withRevealedSecret(rdeps(), { deliveryId: d, actor: { type: "CUSTOMER", id: "u-man" } }, (p) => p.toString())).toBe("login: bob / pass: S3cretManual!");
    expect(await code(completeManualTask(ctx("alice"), t.id, "again"))).toBe("FULFILLMENT_INVALID");
  });
});

describe("supplier-backed fulfilment (generic adapter, test double)", () => {
  it("happy path: purchase confirmed, supplier code re-sealed into the delivery, task completed, customer reveals it", async () => {
    const s = await readySupplier(f, ["P1"]);
    const v = await routedVariant(f, [s.products.P1!]);
    const t = await task(v, "u-sup");
    f.supplier.script(`fulfil:${t.orderItemRef}:${s.products.P1}`, { kind: "CONFIRM", deliverables: ["SUPPLIER-CODE-XYZ-1"] });
    expect(await fulfillSupplierTask(fdeps(), t.id)).toEqual({ outcome: "COMPLETED" });
    expect(await fulfillSupplierTask(fdeps(), t.id)).toMatchObject({ outcome: "NOT_APPLICABLE" });
    const d = (await deliveryStatus(f.app.db, t.orderItemRef)).deliveryId!;
    expect(await withRevealedSecret(rdeps(), { deliveryId: d, actor: { type: "CUSTOMER", id: "u-sup" } }, (p) => p.toString())).toBe("SUPPLIER-CODE-XYZ-1");
    const all = await dumpSecrets();
    expect(all).not.toContain("SUPPLIER-CODE-XYZ-1");
    expect(all).not.toContain(CANARY);
  });
  it("failover only after an EXPLICIT rejection; an ambiguous first supplier blocks the second until reconciled (no double purchase)", async () => {
    const [a, b] = [await readySupplier(f, ["FA"]), await readySupplier(f, ["FB"])];
    const v = await routedVariant(f, [a.products.FA!, b.products.FB!]);
    // rejection -> next route
    const t1 = await task(v);
    f.supplier.script(`fulfil:${t1.orderItemRef}:${a.products.FA}`, { kind: "REJECT", reason: "OUT_OF_STOCK" });
    f.supplier.script(`fulfil:${t1.orderItemRef}:${b.products.FB}`, { kind: "CONFIRM", deliverables: ["B-CODE-1"] });
    expect(await fulfillSupplierTask(fdeps(), t1.id)).toEqual({ outcome: "COMPLETED" });
    // ambiguity -> blocked
    const t2 = await task(v);
    const ka = `fulfil:${t2.orderItemRef}:${a.products.FA}`, kb = `fulfil:${t2.orderItemRef}:${b.products.FB}`;
    f.supplier.script(ka, { kind: "TIMEOUT_AFTER_EXECUTE", deliverables: ["A-CODE-2"] });
    f.supplier.script(kb, { kind: "CONFIRM", deliverables: ["B-CODE-2"] });
    f.supplier.capabilities = { idempotentSubmit: false, statusQuery: false, deliversCodes: true };
    expect(await fulfillSupplierTask(fdeps(), t2.id)).toEqual({ outcome: "AWAITING_RECONCILIATION", status: "PROCESSING" });
    expect(await fulfillSupplierTask(fdeps(), t2.id)).toEqual({ outcome: "AWAITING_RECONCILIATION", status: "PROCESSING" });
    expect(f.supplier.attempts.get(kb)).toBeUndefined(); // the second supplier was NEVER contacted
    expect(f.supplier.attempts.get(ka)).toBe(1);
    // reconciliation (status query now available) confirms supplier A; the task then completes from A's data
    f.supplier.capabilities = { idempotentSubmit: false, statusQuery: true, deliversCodes: true };
    expect(await fulfillSupplierTask(fdeps(), t2.id)).toEqual({ outcome: "COMPLETED" });
    expect(f.supplier.attempts.get(kb)).toBeUndefined();
    const d = (await deliveryStatus(f.app.db, t2.orderItemRef)).deliveryId!;
    expect(await withRevealedSecret(rdeps(), { deliveryId: d, actor: { type: "CUSTOMER", id: "user-1" } }, (p) => p.toString())).toBe("A-CODE-2");
  });
  it("no usable route / all rejected => FAILED, then an administrator takes over manually; confirmed-without-data needs a human too", async () => {
    const s = await readySupplier(f, ["N1"]);
    const v = await routedVariant(f, [s.products.N1!]);
    const t = await task(v, "u-fail");
    f.supplier.script(`fulfil:${t.orderItemRef}:${s.products.N1}`, { kind: "REJECT", reason: "OTHER" });
    expect(await fulfillSupplierTask(fdeps(), t.id)).toEqual({ outcome: "NO_ROUTE", status: "FAILED" });
    expect((await getTask(f.app.db, t.id))?.lastError).toBe("all supplier routes rejected");
    await claimManualTask(ctx("carol"), t.id); // FAILED -> PROCESSING (manual fallback)
    await completeManualTask(ctx("carol"), t.id, "hand-delivered credential");
    expect((await getTask(f.app.db, t.id))?.status).toBe("COMPLETED");
    // supplier confirms but returns no data
    const t2 = await task(v, "u-fail2");
    f.supplier.script(`fulfil:${t2.orderItemRef}:${s.products.N1}`, { kind: "CONFIRM" });
    expect(await fulfillSupplierTask(fdeps(), t2.id)).toEqual({ outcome: "MANUAL_REQUIRED", status: "FAILED" });
    // disabled supplier: no route at all
    await updateSupplier(supCtx(f), s.supplierId, { status: "DISABLED" });
    const t3 = await task(v);
    expect(await fulfillSupplierTask(fdeps(), t3.id)).toEqual({ outcome: "NO_ROUTE", status: "FAILED" });
    void reconcileSupplierOrder;
  });
});
