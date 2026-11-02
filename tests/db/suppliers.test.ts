import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSupplier, createSupplierOrder, deactivateRoute, getRoutes, getSupplierAdmin, getSupplierOrder, mapVariantToSupplierProduct, reconcileSupplierOrder, resolveSupplierOrderManually,
  setSupplierCredentials, submitSupplierOrder, syncSupplierProducts, sweepStuckSubmissions, updateSupplier, withSupplierDeliverable,
} from "@/modules/suppliers";
import * as suppliersApi from "@/modules/suppliers";
import { withTransaction } from "@/platform/db";
import { NullKeyProvider } from "@/platform/crypto";
import type { DevKeyProvider } from "@/platform/crypto/testing/dev-key-provider";
import { TestSupplier } from "@/platform/supplier-adapter/testing/test-supplier";
import type { SubmitReply, SupplierAdapter } from "@/platform/supplier-adapter";
import { pgCode } from "../helpers/db";
import { sellableVariant } from "../helpers/inventory";
import { CANARY, readySupplier, supCtx, supplierFixture } from "../helpers/suppliers";
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
const key = () => `sk-${++n}-${Math.random().toString(36).slice(2, 6)}`;
const mkOrder = async (spId: string, k = key()) => (await withTransaction(f.app.db, (tx) => createSupplierOrder(tx, f.clock, { supplierProductId: spId, orderItemRef: `item-${k}`, quantity: 1, idempotencyKey: k }))).order;
const status = async (id: string) => (await f.t.pool.query("select status from supplier_orders where id = $1", [id])).rows[0].status as string;
const dump = async () => ["suppliers", "supplier_credentials", "supplier_products", "supplier_orders", "supplier_order_events", "supplier_order_secrets", "supplier_sync_runs", "audit_logs", "outbox_events"]
  .reduce(async (acc, t) => (await acc) + JSON.stringify((await f.t.pool.query(`select * from ${t}`)).rows), Promise.resolve(""));

describe("administration and credentials", () => {
  it("requires permissions, validates config (no secrets/hosts/URLs), conflicts on duplicate keys, audits", async () => {
    expect(await code(createSupplier(supCtx(f, []), { key: "denied", name: "x", adapterKey: "test" }))).toBe("AUTH_FORBIDDEN");
    for (const config of [{ api_url: "https://x" }, { host: "a" }, { secret: "s" }, { token: "t" }, { endpoint: "e" }]) {
      expect(await code(createSupplier(supCtx(f), { key: key().slice(0, 30), name: "x", adapterKey: "test", config })), JSON.stringify(config)).toBe("SUPPLIER_INVALID");
    }
    const k = key().slice(0, 30);
    const { id } = await createSupplier(supCtx(f), { key: k, name: "Acme", adapterKey: "test", config: { region: "eu", retries: 2 } });
    expect(await code(createSupplier(supCtx(f), { key: k, name: "Dup", adapterKey: "test" }))).toBe("SUPPLIER_INVALID");
    await updateSupplier(supCtx(f), id, { name: "Acme 2", status: "DISABLED" });
    expect((await f.t.pool.query("select 1 from audit_logs where action in ('suppliers.supplier.created','suppliers.supplier.updated') and entity_id = $1", [id])).rows).toHaveLength(2);
    expect(await sqlCode("update suppliers set adapter_key = 'other' where id = $1", [id])).toBe("PI001");
  });
  it("credentials are write-only: sealed, never in any table/audit/event, rotation keeps history, fail closed without a KeyProvider", async () => {
    const r = await readySupplier(f, ["A1"]);
    expect(await dump()).not.toContain(CANARY);
    expect(Object.keys(suppliersApi).some((k) => /credential/i.test(k) && /get|read|reveal/i.test(k))).toBe(false); // no read API exists
    const view = await getSupplierAdmin(supCtx(f), r.supplierId);
    expect(JSON.stringify(view)).not.toContain(CANARY);
    expect(view).toMatchObject({ has_credentials: 1 });
    await setSupplierCredentials(supCtx(f), r.supplierId, { apiKey: "rotated-key-2" });
    const rows = (await f.t.pool.query("select status from supplier_credentials where supplier_id = $1 order by created_at", [r.supplierId])).rows.map((x) => x.status);
    expect(rows).toEqual(["REPLACED", "ACTIVE"]);
    expect(await code(setSupplierCredentials({ ...supCtx(f), keys: new NullKeyProvider() as never }, r.supplierId, { apiKey: "x" }))).toBe("KEY_PROVIDER_NOT_CONFIGURED");
    expect(await code(setSupplierCredentials(supCtx(f, []), r.supplierId, { apiKey: "x" }))).toBe("AUTH_FORBIDDEN");
    expect(await code(setSupplierCredentials(supCtx(f), r.supplierId, {}))).toBe("SUPPLIER_INVALID");
    expect(await sqlCode("update supplier_credentials set sealed = decode('00','hex') where supplier_id = $1", [r.supplierId])).toBe("PI001");
    expect((await f.t.pool.query("select metadata from audit_logs where action = 'suppliers.credentials.set' order by id desc limit 1")).rows[0].metadata).toEqual({ fields: 1 });
  });
});

describe("price and availability synchronisation", () => {
  it("creates, updates, detects unchanged items and marks missing ones unavailable, with change history; catalog prices are untouched", async () => {
    const variant = await sellableVariant(f, "SUPPLIER_API");
    const before = (await f.t.pool.query("select price from product_variants where id = $1", [variant])).rows[0].price;
    const r = await readySupplier(f, ["S1", "S2", "S3"], { cost: 400_000 });
    expect(r.run).toMatchObject({ status: "SUCCEEDED", fetched: 3, created: 3, updated: 0, rejected: 0 });
    f.supplier.catalog = [
      { externalSku: "S1", name: "Product S1", cost: 400_000, currency: "IRR", available: true }, // unchanged
      { externalSku: "S2", name: "Product S2", cost: 450_000, currency: "IRR", available: false }, // changed
      { externalSku: "S4", name: "New", cost: 100_000, currency: "IRR", available: true }, // new (S3 missing)
    ];
    const r2 = await syncSupplierProducts(f.app.db, f.deps, { type: "ADMIN", id: "admin-1" }, r.supplierId);
    expect(r2).toMatchObject({ status: "SUCCEEDED", fetched: 3, created: 1, updated: 1, markedUnavailable: 1 });
    const rows = (await f.t.pool.query("select external_sku, cost, available from supplier_products where supplier_id = $1 order by external_sku", [r.supplierId])).rows.map((x) => [x.external_sku, Number(x.cost), x.available]);
    expect(rows).toEqual([["S1", 400_000, true], ["S2", 450_000, false], ["S3", 400_000, false], ["S4", 100_000, true]]);
    const hist = (await f.t.pool.query("select p.external_sku, c.old_cost, c.new_cost, c.old_available, c.new_available from supplier_product_changes c join supplier_products p on p.id = c.supplier_product_id where c.run_id = $1 order by p.external_sku", [r2.runId])).rows;
    expect(hist.map((h) => h.external_sku)).toEqual(["S2", "S3", "S4"]);
    expect((await f.t.pool.query("select price from product_variants where id = $1", [variant])).rows[0].price).toBe(before);
    expect(await sqlCode("update supplier_product_changes set new_cost = 1")).not.toBe("ok");
  });
  it("rejects invalid items (currency, non-integer or negative cost, bad SKU, duplicates) instead of guessing", async () => {
    const r = await readySupplier(f, ["OK1"]);
    f.supplier.catalog = [
      { externalSku: "OK1", name: "ok", cost: 1000, currency: "IRR", available: true },
      { externalSku: "USD1", name: "usd", cost: 1000, currency: "USD", available: true },
      { externalSku: "FLT", name: "float", cost: 10.5, currency: "IRR", available: true },
      { externalSku: "NEG", name: "neg", cost: -1, currency: "IRR", available: true },
      { externalSku: "bad sku!", name: "bad", cost: 1, currency: "IRR", available: true },
      { externalSku: "OK1", name: "dup", cost: 2000, currency: "IRR", available: true },
    ];
    const r2 = await syncSupplierProducts(f.app.db, f.deps, { type: "ADMIN", id: "a" }, r.supplierId);
    expect(r2).toMatchObject({ status: "SUCCEEDED", fetched: 6, rejected: 5 });
    expect((await f.t.pool.query("select count(*)::int c from supplier_products where supplier_id = $1", [r.supplierId])).rows[0].c).toBe(1);
  });
  it("a failing fetch changes nothing and is recorded; missing adapter / credentials / disabled supplier fail closed", async () => {
    const r = await readySupplier(f, ["F1"]);
    const snapshot = JSON.stringify((await f.t.pool.query("select * from supplier_products where supplier_id = $1", [r.supplierId])).rows);
    f.supplier.listMode = "throw";
    const bad = await syncSupplierProducts(f.app.db, f.deps, { type: "ADMIN", id: "a" }, r.supplierId);
    f.supplier.listMode = "ok";
    expect(bad).toMatchObject({ status: "FAILED", errorKind: "ERROR" });
    expect(JSON.stringify((await f.t.pool.query("select * from supplier_products where supplier_id = $1", [r.supplierId])).rows)).toBe(snapshot);
    expect(await code(syncSupplierProducts(f.app.db, { ...f.deps, adapters: new Map() }, { type: "ADMIN", id: "a" }, r.supplierId))).toBe("SUPPLIER_ADAPTER_NOT_CONFIGURED");
    const noCreds = (await createSupplier(supCtx(f), { key: key().slice(0, 30), name: "nocreds", adapterKey: "test" })).id;
    expect(await syncSupplierProducts(f.app.db, f.deps, { type: "ADMIN", id: "a" }, noCreds)).toMatchObject({ status: "FAILED", errorKind: "SUPPLIER_INVALID" });
    await updateSupplier(supCtx(f), r.supplierId, { status: "DISABLED" });
    expect(await code(syncSupplierProducts(f.app.db, f.deps, { type: "ADMIN", id: "a" }, r.supplierId))).toBe("SUPPLIER_INVALID");
    expect(await dump()).not.toContain(CANARY);
  });
});

describe("variant mapping", () => {
  it("maps only SUPPLIER_API variants to active suppliers, orders routes by priority, hides unavailable/disabled ones", async () => {
    const a = await readySupplier(f, ["M1"]), b = await readySupplier(f, ["M2"]);
    const auto = await sellableVariant(f, "AUTO_CODE");
    expect(await code(mapVariantToSupplierProduct(supCtx(f), { variantId: auto, supplierProductId: a.products.M1!, priority: 1 }))).toBe("SUPPLIER_INVALID");
    const v = await sellableVariant(f, "SUPPLIER_API");
    expect(await code(mapVariantToSupplierProduct(supCtx(f, []), { variantId: v, supplierProductId: a.products.M1!, priority: 1 }))).toBe("AUTH_FORBIDDEN");
    await mapVariantToSupplierProduct(supCtx(f), { variantId: v, supplierProductId: b.products.M2!, priority: 2 });
    const first = await mapVariantToSupplierProduct(supCtx(f), { variantId: v, supplierProductId: a.products.M1!, priority: 1 });
    expect(await code(mapVariantToSupplierProduct(supCtx(f), { variantId: v, supplierProductId: a.products.M1!, priority: 3 }))).toBe("SUPPLIER_INVALID"); // already mapped
    expect(await code(mapVariantToSupplierProduct(supCtx(f), { variantId: v, supplierProductId: b.products.M2!, priority: 1 }))).toBe("SUPPLIER_INVALID"); // priority taken
    expect((await getRoutes(f.app.db, v)).map((r) => r.externalSku)).toEqual(["M1", "M2"]);
    await updateSupplier(supCtx(f), b.supplierId, { status: "DISABLED" });
    expect((await getRoutes(f.app.db, v)).map((r) => r.externalSku)).toEqual(["M1"]);
    await deactivateRoute(supCtx(f), first.routeId, "supplier retired");
    expect(await getRoutes(f.app.db, v)).toEqual([]);
    expect(await code(deactivateRoute(supCtx(f), first.routeId, "again"))).toBe("SUPPLIER_NOT_FOUND");
  });
});

describe("supplier orders — explicit outcomes", () => {
  it("CONFIRMED stores the supplier's codes sealed (never plaintext), logs access, outbox + audit; resubmission is refused", async () => {
    const { products } = await readySupplier(f, ["O1"]);
    const o = await mkOrder(products.O1!);
    f.supplier.script((await f.t.pool.query("select idempotency_key k from supplier_orders where id = $1", [o.id])).rows[0].k, { kind: "CONFIRM", deliverables: ["GIFT-CODE-AAAA-1111"] });
    const out = await submitSupplierOrder(f.app.db, f.deps, o.id);
    expect(out).toMatchObject({ outcome: "CONFIRMED", order: { status: "CONFIRMED", deliverableCount: 1 } });
    expect(await dump()).not.toContain("GIFT-CODE-AAAA-1111");
    expect(await dump()).not.toContain(CANARY);
    const seen = await withSupplierDeliverable(f.app.db, f.keys, f.clock, { supplierOrderId: o.id, position: 0, requestedBy: "system:fulfillment" }, (p) => p.toString());
    expect(seen).toBe("GIFT-CODE-AAAA-1111");
    expect((await f.t.pool.query("select 1 from supplier_order_events where supplier_order_id = $1 and type = 'DELIVERABLE_OPENED'", [o.id])).rows).toHaveLength(1);
    expect((await f.t.pool.query("select 1 from outbox_events where event_type = 'supplier_order.confirmed' and aggregate_id = $1", [o.id])).rows).toHaveLength(1);
    expect(await submitSupplierOrder(f.app.db, f.deps, o.id)).toEqual({ outcome: "NOT_SUBMITTABLE", status: "CONFIRMED" });
    expect(await code(withSupplierDeliverable(f.app.db, f.keys, f.clock, { supplierOrderId: o.id, position: 5, requestedBy: "x" }, () => 1))).toBe("SUPPLIER_NOT_FOUND");
  });
  it("create is idempotent per (supplier, key); different content conflicts; disabled supplier refused", async () => {
    const { products, supplierId } = await readySupplier(f, ["O2"]);
    const k = key();
    const a = await withTransaction(f.app.db, (tx) => createSupplierOrder(tx, f.clock, { supplierProductId: products.O2!, orderItemRef: "i1", quantity: 1, idempotencyKey: k }));
    const b = await withTransaction(f.app.db, (tx) => createSupplierOrder(tx, f.clock, { supplierProductId: products.O2!, orderItemRef: "i1", quantity: 1, idempotencyKey: k }));
    expect(b).toMatchObject({ replay: true, order: { id: a.order.id } });
    expect(await code(withTransaction(f.app.db, (tx) => createSupplierOrder(tx, f.clock, { supplierProductId: products.O2!, orderItemRef: "i1", quantity: 2, idempotencyKey: k })))).toBe("IDEMPOTENCY_CONFLICT");
    await updateSupplier(supCtx(f), supplierId, { status: "DISABLED" });
    expect(await code(mkOrder(products.O2!))).toBe("SUPPLIER_INVALID");
  });
  it("REJECTED is explicit and final", async () => {
    const { products } = await readySupplier(f, ["O3"]);
    const o = await mkOrder(products.O3!);
    f.supplier.script((await f.t.pool.query("select idempotency_key k from supplier_orders where id = $1", [o.id])).rows[0].k, { kind: "REJECT", reason: "OUT_OF_STOCK" });
    expect(await submitSupplierOrder(f.app.db, f.deps, o.id)).toMatchObject({ outcome: "REJECTED", order: { status: "REJECTED", rejectReason: "OUT_OF_STOCK" } });
    expect(await sqlCode("update supplier_orders set status = 'CREATED' where id = $1", [o.id])).toBe("PT001");
  });
  it("timeouts and unknown outcomes => UNKNOWN, never retried blindly; the supplier is contacted once", async () => {
    const { products } = await readySupplier(f, ["O4"]);
    for (const kind of ["TIMEOUT_BEFORE_EXECUTE", "TIMEOUT_AFTER_EXECUTE"] as const) {
      const o = await mkOrder(products.O4!);
      const k = (await f.t.pool.query("select idempotency_key k from supplier_orders where id = $1", [o.id])).rows[0].k as string;
      f.supplier.script(k, { kind });
      expect(await submitSupplierOrder(f.app.db, f.deps, o.id)).toMatchObject({ outcome: "UNKNOWN" });
      expect(await submitSupplierOrder(f.app.db, f.deps, o.id)).toEqual({ outcome: "NOT_SUBMITTABLE", status: "UNKNOWN" }); // no blind retry
      expect(f.supplier.attempts.get(k)).toBe(1);
    }
    // a slow supplier beyond our timeout is also UNKNOWN even though it executed
    const slow = await mkOrder(products.O4!);
    const sk = (await f.t.pool.query("select idempotency_key k from supplier_orders where id = $1", [slow.id])).rows[0].k as string;
    f.supplier.script(sk, { kind: "SLOW_CONFIRM", ms: 300, deliverables: ["SLOW-CODE-1"] });
    expect(await submitSupplierOrder(f.app.db, { ...f.deps, submitTimeoutMs: 50 }, slow.id)).toMatchObject({ outcome: "UNKNOWN" });
    expect(f.supplier.executed.has(sk)).toBe(false);
    await new Promise((r) => setTimeout(r, 400));
    expect(f.supplier.executed.has(sk)).toBe(true); // the dangerous case: it DID buy
    expect(await reconcileSupplierOrder(f.app.db, f.deps, slow.id)).toEqual({ outcome: "CONFIRMED" });
    expect(f.supplier.attempts.get(sk)).toBe(1);
  });
  it("reconciliation: status query resolves executed orders; NOT_FOUND alone never authorises a resend; documented idempotent suppliers may resend with the SAME key", async () => {
    const { products } = await readySupplier(f, ["O5"]);
    const mk = async (script: Parameters<TestSupplier["script"]>[1]) => {
      const o = await mkOrder(products.O5!);
      const k = (await f.t.pool.query("select idempotency_key k from supplier_orders where id = $1", [o.id])).rows[0].k as string;
      f.supplier.script(k, script);
      await submitSupplierOrder(f.app.db, f.deps, o.id);
      return { id: o.id, k };
    };
    const executed = await mk({ kind: "TIMEOUT_AFTER_EXECUTE", deliverables: ["RECON-CODE-9"] });
    expect(await reconcileSupplierOrder(f.app.db, f.deps, executed.id)).toEqual({ outcome: "CONFIRMED" });
    expect(await withSupplierDeliverable(f.app.db, f.keys, f.clock, { supplierOrderId: executed.id, position: 0, requestedBy: "t" }, (p) => p.toString())).toBe("RECON-CODE-9");
    expect(f.supplier.attempts.get(executed.k)).toBe(1);

    const lost = await mk({ kind: "TIMEOUT_BEFORE_EXECUTE" });
    expect(await reconcileSupplierOrder(f.app.db, f.deps, lost.id)).toEqual({ outcome: "STILL_UNKNOWN" }); // NOT_FOUND is not proof
    expect(await status(lost.id)).toBe("UNKNOWN");
    f.supplier.capabilities = { ...f.supplier.capabilities, statusQuery: false };
    expect(await reconcileSupplierOrder(f.app.db, f.deps, lost.id)).toEqual({ outcome: "MANUAL_REQUIRED" });
    f.supplier.capabilities = { idempotentSubmit: true, statusQuery: true, deliversCodes: true };
    expect(await reconcileSupplierOrder(f.app.db, f.deps, lost.id)).toEqual({ outcome: "RESUBMIT_ALLOWED" });
    expect(await status(lost.id)).toBe("CREATED");
    f.supplier.script(lost.k, { kind: "CONFIRM" });
    expect(await submitSupplierOrder(f.app.db, f.deps, lost.id)).toMatchObject({ outcome: "CONFIRMED" });
    expect(f.supplier.attempts.get(lost.k)).toBe(2);
    expect(f.supplier.executed.size).toBeGreaterThan(0);
    f.supplier.capabilities = { idempotentSubmit: false, statusQuery: true, deliversCodes: true };
    expect(await reconcileSupplierOrder(f.app.db, f.deps, lost.id)).toEqual({ outcome: "NOT_UNKNOWN", status: "CONFIRMED" });
  });
  it("proof of non-transmission returns to CREATED; missing KeyProvider fails closed the same way; malformed replies are UNKNOWN; seal failure parks the order with its reference", async () => {
    const { products } = await readySupplier(f, ["O6"]);
    const o = await mkOrder(products.O6!);
    const k = (await f.t.pool.query("select idempotency_key k from supplier_orders where id = $1", [o.id])).rows[0].k as string;
    f.supplier.script(k, { kind: "NOT_SENT" });
    expect(await submitSupplierOrder(f.app.db, f.deps, o.id)).toMatchObject({ outcome: "RETRYABLE", order: { status: "CREATED" } });
    expect(await submitSupplierOrder(f.app.db, { ...f.deps, keys: new NullKeyProvider() as never }, o.id)).toMatchObject({ outcome: "RETRYABLE" });
    expect(f.supplier.executed.has(k)).toBe(false);
    f.supplier.script(k, { kind: "CONFIRM" });
    expect(await submitSupplierOrder(f.app.db, f.deps, o.id)).toMatchObject({ outcome: "CONFIRMED" });

    const weird: SupplierAdapter = { ...f.supplier, key: "test", capabilities: f.supplier.capabilities, listProducts: f.supplier.listProducts.bind(f.supplier), queryOrder: f.supplier.queryOrder.bind(f.supplier), submitOrder: async () => ({ status: "MAYBE" } as unknown as SubmitReply) };
    const o2 = await mkOrder(products.O6!);
    expect(await submitSupplierOrder(f.app.db, { ...f.deps, adapters: new Map([["test", weird]]) }, o2.id)).toMatchObject({ outcome: "UNKNOWN" });

    // seal failure: the KeyProvider works for credentials but fails when sealing the delivered codes
    const o3 = await mkOrder(products.O6!);
    const k3 = (await f.t.pool.query("select idempotency_key k from supplier_orders where id = $1", [o3.id])).rows[0].k as string;
    f.supplier.script(k3, { kind: "CONFIRM", deliverables: ["WILL-NOT-BE-LOST"] });
    let calls = 0;
    const flaky = Object.create(f.keys) as DevKeyProvider;
    flaky.wrapDek = async (...a: Parameters<DevKeyProvider["wrapDek"]>) => { if (++calls > 0) throw new Error("kms down"); return f.keys.wrapDek(...a); };
    flaky.unwrapDek = f.keys.unwrapDek.bind(f.keys);
    const r = await submitSupplierOrder(f.app.db, { ...f.deps, keys: flaky }, o3.id);
    expect(r).toMatchObject({ outcome: "UNKNOWN", order: { status: "UNKNOWN", externalRef: expect.stringMatching(/^ext-/) } });
    expect((await getSupplierOrder(f.app.db, o3.id))?.note).toContain("could not be stored");
    expect(await reconcileSupplierOrder(f.app.db, f.deps, o3.id)).toEqual({ outcome: "CONFIRMED" }); // re-fetch via status query, now storable
    expect(await withSupplierDeliverable(f.app.db, f.keys, f.clock, { supplierOrderId: o3.id, position: 0, requestedBy: "t" }, (p) => p.toString())).toBe("WILL-NOT-BE-LOST");
  });
  it("the adapter is called with NO database transaction open and receives credentials only for the call", async () => {
    const { products } = await readySupplier(f, ["O7"]);
    let idle = -1;
    class Probe extends TestSupplier {
      override async submitOrder(req: Parameters<TestSupplier["submitOrder"]>[0]) {
        idle = Number((await f.t.pool.query("select count(*)::int c from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'")).rows[0].c);
        expect(req.credentials.apiKey).toBe(CANARY);
        return super.submitOrder(req);
      }
    }
    const probe = new Probe();
    const o = await mkOrder(products.O7!);
    expect(await submitSupplierOrder(f.app.db, { ...f.deps, adapters: new Map([["test", probe]]) }, o.id)).toMatchObject({ outcome: "CONFIRMED" });
    expect(idle).toBe(0);
    expect(await dump()).not.toContain(CANARY);
  });
  it("a worker that died mid-submission leaves SUBMITTING; the sweeper parks it as UNKNOWN (never re-sends); manual resolution is permissioned, noted and audited", async () => {
    const { products } = await readySupplier(f, ["O8"]);
    const o = await mkOrder(products.O8!);
    await f.t.pool.query("select set_config('app.actor_id','t',false)");
    await f.t.pool.query("update supplier_orders set status = 'SUBMITTING', submitting_since = $2 where id = $1", [o.id, new Date(f.clock.now().getTime() - 300_000).toISOString()]);
    expect(await sweepStuckSubmissions(f.app.db, f.clock)).toBeGreaterThanOrEqual(1);
    expect(await status(o.id)).toBe("UNKNOWN");
    expect(await submitSupplierOrder(f.app.db, f.deps, o.id)).toEqual({ outcome: "NOT_SUBMITTABLE", status: "UNKNOWN" });
    expect(await code(resolveSupplierOrderManually(supCtx(f, []), o.id, { to: "REJECTED", note: "supplier confirmed by phone no purchase" }))).toBe("AUTH_FORBIDDEN");
    expect(await code(resolveSupplierOrderManually(supCtx(f), o.id, { to: "REJECTED", note: "short" }))).toBe("SUPPLIER_INVALID");
    await resolveSupplierOrderManually(supCtx(f, "all", "admin-9"), o.id, { to: "CONFIRMED", note: "supplier portal shows the purchase as done" });
    expect(await status(o.id)).toBe("CONFIRMED");
    expect(await code(resolveSupplierOrderManually(supCtx(f), o.id, { to: "REJECTED", note: "already resolved earlier" }))).toBe("SUPPLIER_INVALID");
    expect((await f.t.pool.query("select actor_id from audit_logs where action = 'suppliers.order.resolved_manually' and entity_id = $1", [o.id])).rows).toEqual([{ actor_id: "admin-9" }]);
    // DB: a CONFIRMED order needs a reference or a note
    const o2 = await mkOrder(products.O8!);
    const cl = await f.t.pool.connect();
    try {
      await cl.query("update supplier_orders set status='SUBMITTING' where id=$1", [o2.id]);
      expect(await cl.query("update supplier_orders set status='CONFIRMED' where id=$1", [o2.id]).then(() => "ok", (e: unknown) => pgCode(e))).toBe("23514");
    } finally {
      cl.release();
    }
    for (const q of ["delete from supplier_orders", "delete from supplier_order_secrets", "delete from supplier_order_events", "delete from supplier_credentials", "update supplier_order_events set type = 'X'"]) {
      expect(await f.app.pool.query(q).then(() => "ok", (e: unknown) => pgCode(e)), q).toBe("42501");
    }
  });
});
