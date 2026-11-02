import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Clock } from "@/platform/clock";
import type { KeyProvider } from "@/platform/crypto";
import { decodeSealed, encodeSealed, openSecret, sealSecret } from "@/platform/crypto";
import type { Database, Tx } from "@/platform/db";
import { withTransaction } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { uuidv7 } from "@/platform/ids";
import { enqueueOutbox } from "@/platform/outbox";
import { SupplierNotSentError, getAdapter } from "@/platform/supplier-adapter";
import type { QueryReply, SubmitReply, SupplierAdapter, SupplierRejectReason } from "@/platform/supplier-adapter";
import { DEFAULT_SUBMIT_LEASE_SECONDS, DEFAULT_SUBMIT_TIMEOUT_MS, orderInput, parse } from "../domain/rules";
import type { SupplierOrderStatus } from "../domain/rules";
import { SYSTEM, addEvent, audit, classifyError, first, iso, secretSealCtx, withCredentials } from "./shared";
import type { SupplierDeps, Ts } from "./shared";
import type { SupplierAdminContext } from "./admin";

interface OrderRow {
  id: string; supplier_id: string; supplier_product_id: string; order_item_ref: string; quantity: number; idempotency_key: string; status: SupplierOrderStatus;
  external_ref: string | null; reject_reason: string | null; attempts: number; submitting_since: Ts | null; note: string | null;
}
export interface SupplierOrderView { id: string; supplierId: string; orderItemRef: string; quantity: number; status: SupplierOrderStatus; externalRef: string | null; rejectReason: string | null; attempts: number; note: string | null; deliverableCount: number }
const COLS = sql`id, supplier_id, supplier_product_id, order_item_ref, quantity, idempotency_key, status, external_ref, reject_reason, attempts, submitting_since, note`;
const toView = (r: OrderRow, n = 0): SupplierOrderView => ({ id: r.id, supplierId: r.supplier_id, orderItemRef: r.order_item_ref, quantity: r.quantity, status: r.status, externalRef: r.external_ref, rejectReason: r.reject_reason, attempts: r.attempts, note: r.note, deliverableCount: n });

/**
 * Persist a supplier order in CREATED state with its idempotency key FIXED before anything is sent. Idempotent per
 * (supplier, key): the same key and content returns the existing order, different content is IDEMPOTENCY_CONFLICT.
 */
export async function createSupplierOrder(tx: Tx, clock: Clock, raw: unknown): Promise<{ order: SupplierOrderView; replay: boolean }> {
  const i = parse(orderInput, raw);
  const sp = first<{ supplier_id: string; status: string; available: boolean }>(
    await tx.execute(sql`select p.supplier_id, s.status, p.available from supplier_products p join suppliers s on s.id = p.supplier_id where p.id = ${i.supplierProductId}`),
  );
  if (!sp) throw new DomainError("SUPPLIER_NOT_FOUND", "supplier product not found");
  if (sp.status !== "ACTIVE") throw new DomainError("SUPPLIER_INVALID", "supplier is not active");
  const hash = createHash("sha256").update(JSON.stringify([i.supplierProductId, i.orderItemRef, i.quantity])).digest();
  const id = uuidv7(clock);
  const now = clock.now();
  const ins = await tx.execute(
    sql`insert into supplier_orders (id, supplier_id, supplier_product_id, order_item_ref, quantity, idempotency_key, request_hash, status, created_at, updated_at)
        values (${id}, ${sp.supplier_id}, ${i.supplierProductId}, ${i.orderItemRef}, ${i.quantity}, ${i.idempotencyKey}, ${hash}, 'CREATED', ${iso(now)}::timestamptz, ${iso(now)}::timestamptz)
        on conflict (supplier_id, idempotency_key) do nothing returning ${COLS}`,
  );
  if (ins.rows.length === 1) {
    await addEvent(tx, id, "CREATED", SYSTEM.id, now);
    return { order: toView(ins.rows[0] as unknown as OrderRow), replay: false };
  }
  const ex = first<OrderRow & { request_hash: Buffer }>(await tx.execute(sql`select ${COLS}, request_hash from supplier_orders where supplier_id = ${sp.supplier_id} and idempotency_key = ${i.idempotencyKey}`))!;
  if (!Buffer.from(ex.request_hash).equals(hash)) throw new DomainError("IDEMPOTENCY_CONFLICT", "supplier order key was used with different content");
  return { order: toView(ex), replay: true };
}

export type SubmitOutcome =
  | { outcome: "CONFIRMED" | "REJECTED" | "UNKNOWN" | "RETRYABLE"; order: SupplierOrderView }
  | { outcome: "NOT_SUBMITTABLE"; status: SupplierOrderStatus };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(Object.assign(new Error("supplier call timed out"), { name: "SupplierTimeout" })), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

async function sealDeliverables(keys: KeyProvider, items: readonly string[] | undefined): Promise<{ id: string; sealed: Buffer }[]> {
  const out: { id: string; sealed: Buffer }[] = [];
  for (const d of items ?? []) {
    if (typeof d !== "string" || d.length < 1 || d.length > 4096) throw new DomainError("SUPPLIER_INVALID", "malformed deliverable");
    const id = uuidv7();
    out.push({ id, sealed: encodeSealed(await sealSecret(keys, d, secretSealCtx(id))) });
  }
  return out;
}

async function finishConfirmed(tx: Tx, deps: SupplierDeps, o: OrderRow, externalRef: string | null, secrets: { id: string; sealed: Buffer }[], actor: string, via: string): Promise<void> {
  const now = deps.clock.now();
  await tx.execute(sql`update supplier_orders set status = 'CONFIRMED', external_ref = ${externalRef}, response_redacted = ${JSON.stringify({ status: "CONFIRMED", externalRef, deliverables: secrets.length })}::jsonb, updated_at = ${iso(now)}::timestamptz where id = ${o.id}`);
  for (let k = 0; k < secrets.length; k++) {
    await tx.execute(sql`insert into supplier_order_secrets (id, supplier_order_id, position, sealed, created_at) values (${secrets[k]!.id}, ${o.id}, ${k}, ${secrets[k]!.sealed}, ${iso(now)}::timestamptz)`);
  }
  await addEvent(tx, o.id, "CONFIRMED", actor, now, { via, deliverables: secrets.length });
  await enqueueOutbox(tx, { eventType: "supplier_order.confirmed", aggregateType: "supplier_order", aggregateId: o.id, payload: { supplierOrderId: o.id, orderItemRef: o.order_item_ref } }, deps.clock);
  await audit(tx, SYSTEM, now, "suppliers.order.confirmed", { type: "supplier_order", id: o.id }, { via, deliverables: secrets.length });
}

async function finishRejected(tx: Tx, deps: SupplierDeps, o: OrderRow, reason: SupplierRejectReason, actor: string, via: string): Promise<void> {
  const now = deps.clock.now();
  await tx.execute(sql`update supplier_orders set status = 'REJECTED', reject_reason = ${reason}, response_redacted = ${JSON.stringify({ status: "REJECTED", reason })}::jsonb, updated_at = ${iso(now)}::timestamptz where id = ${o.id}`);
  await addEvent(tx, o.id, "REJECTED", actor, now, { via, reason });
  await enqueueOutbox(tx, { eventType: "supplier_order.rejected", aggregateType: "supplier_order", aggregateId: o.id, payload: { supplierOrderId: o.id, orderItemRef: o.order_item_ref, reason } }, deps.clock);
  await audit(tx, SYSTEM, now, "suppliers.order.rejected", { type: "supplier_order", id: o.id }, { via, reason });
}

/**
 * Submit a CREATED supplier order. THREE phases, the external call never inside a transaction:
 *  1. (tx) claim CREATED -> SUBMITTING under a row lock — the persisted key + state exist BEFORE anything is sent; a concurrent
 *     submitter loses here, so one key can reach the supplier at most once per claim;
 *  2. (no tx) credentials are opened and the adapter is called under a timeout;
 *  3. (tx) record the explicit answer. CONFIRMED / REJECTED only for explicit supplier replies. EVERYTHING else (timeout, error,
 *     malformed reply) => UNKNOWN: it is never retried blindly, only reconciled. `SupplierNotSentError` (proof of non-transmission)
 *     returns the order to CREATED.
 * If the confirmed codes cannot be sealed/stored, the order is parked as UNKNOWN (with the supplier reference) rather than losing them.
 */
export async function submitSupplierOrder(db: Database, deps: SupplierDeps, orderId: string): Promise<SubmitOutcome> {
  const pre = first<OrderRow & { adapter_key: string; external_sku: string; sstatus: string }>(
    await db.execute(sql`select o.id, o.supplier_id, o.supplier_product_id, o.order_item_ref, o.quantity, o.idempotency_key, o.status, o.external_ref, o.reject_reason, o.attempts, o.submitting_since, o.note, s.adapter_key, p.external_sku, s.status as sstatus
                           from supplier_orders o join suppliers s on s.id = o.supplier_id join supplier_products p on p.id = o.supplier_product_id where o.id = ${orderId}`),
  );
  if (!pre) throw new DomainError("SUPPLIER_NOT_FOUND", "supplier order not found");
  if (pre.status !== "CREATED") return { outcome: "NOT_SUBMITTABLE", status: pre.status };
  if (pre.sstatus !== "ACTIVE") throw new DomainError("SUPPLIER_INVALID", "supplier is not active");
  const adapter = getAdapter(deps.adapters, pre.adapter_key); // configuration problems surface BEFORE any state change

  const claimed = await withTransaction(db, async (tx) => {
    const now = deps.clock.now();
    const r = await tx.execute(sql`update supplier_orders set status = 'SUBMITTING', attempts = attempts + 1, submitting_since = ${iso(now)}::timestamptz, updated_at = ${iso(now)}::timestamptz where id = ${orderId} and status = 'CREATED' returning ${COLS}`);
    if (r.rows.length !== 1) return null;
    await addEvent(tx, orderId, "SUBMITTING", SYSTEM.id, now, { attempt: (r.rows[0] as unknown as OrderRow).attempts });
    return r.rows[0] as unknown as OrderRow;
  });
  if (!claimed) {
    const cur = first<{ status: SupplierOrderStatus }>(await db.execute(sql`select status from supplier_orders where id = ${orderId}`))!;
    return { outcome: "NOT_SUBMITTABLE", status: cur.status };
  }

  let reply: SubmitReply | null = null;
  let failure: "TIMEOUT" | "NOT_SENT" | "ERROR" | null = null;
  try {
    reply = await withCredentials(db, deps.keys, claimed.supplier_id, (cred) =>
      withTimeout(adapter.submitOrder({ idempotencyKey: claimed.idempotency_key, externalSku: pre.external_sku, quantity: claimed.quantity, credentials: cred }), deps.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS),
    );
  } catch (e) {
    // Credentials that could not be opened mean nothing was sent either.
    failure = e instanceof SupplierNotSentError || (e instanceof DomainError && (e.code === "KEY_PROVIDER_NOT_CONFIGURED" || e.code === "KEY_UNAVAILABLE" || e.code === "SUPPLIER_INVALID")) ? "NOT_SENT" : classifyError(e);
  }
  if (reply && reply.status !== "CONFIRMED" && reply.status !== "REJECTED") {
    reply = null; // malformed => unknown
    failure = "ERROR";
  }

  let sealed: { id: string; sealed: Buffer }[] = [];
  let sealFailed = false;
  if (reply?.status === "CONFIRMED") {
    if (typeof reply.externalRef !== "string" || reply.externalRef.length < 1 || reply.externalRef.length > 200) {
      reply = null;
      failure = "ERROR";
    } else {
      try {
        sealed = await sealDeliverables(deps.keys, reply.deliverables);
      } catch {
        sealFailed = true;
      }
    }
  }

  return withTransaction(db, async (tx): Promise<SubmitOutcome> => {
    const now = deps.clock.now();
    const o = first<OrderRow>(await tx.execute(sql`select ${COLS} from supplier_orders where id = ${orderId} for update`))!;
    if (o.status !== "SUBMITTING" && o.status !== "UNKNOWN") return { outcome: "NOT_SUBMITTABLE", status: o.status }; // a later reconcile already settled it
    const view = async (): Promise<SupplierOrderView> => toView(first<OrderRow>(await tx.execute(sql`select ${COLS} from supplier_orders where id = ${orderId}`))!, sealed.length);
    if (reply?.status === "CONFIRMED" && !sealFailed) {
      await finishConfirmed(tx, deps, o, reply.externalRef, sealed, SYSTEM.id, "submit");
      return { outcome: "CONFIRMED", order: await view() };
    }
    if (reply?.status === "CONFIRMED" && sealFailed) {
      await tx.execute(sql`update supplier_orders set status = 'UNKNOWN', external_ref = ${reply.externalRef}, note = 'confirmed by supplier but the delivered data could not be stored', updated_at = ${iso(now)}::timestamptz where id = ${orderId}`);
      await addEvent(tx, orderId, "UNKNOWN", SYSTEM.id, now, { cause: "SEAL_FAILED" });
      await audit(tx, SYSTEM, now, "suppliers.order.unknown", { type: "supplier_order", id: orderId }, { cause: "SEAL_FAILED" });
      return { outcome: "UNKNOWN", order: await view() };
    }
    if (reply?.status === "REJECTED") {
      await finishRejected(tx, deps, o, reply.reason, SYSTEM.id, "submit");
      return { outcome: "REJECTED", order: await view() };
    }
    if (failure === "NOT_SENT" && o.status === "SUBMITTING") {
      await tx.execute(sql`update supplier_orders set status = 'CREATED', submitting_since = null, updated_at = ${iso(now)}::timestamptz where id = ${orderId}`);
      await addEvent(tx, orderId, "NOT_SENT", SYSTEM.id, now);
      return { outcome: "RETRYABLE", order: await view() };
    }
    if (o.status === "SUBMITTING") {
      await tx.execute(sql`update supplier_orders set status = 'UNKNOWN', updated_at = ${iso(now)}::timestamptz where id = ${orderId}`);
      await addEvent(tx, orderId, "UNKNOWN", SYSTEM.id, now, { cause: failure ?? "ERROR" });
      await audit(tx, SYSTEM, now, "suppliers.order.unknown", { type: "supplier_order", id: orderId }, { cause: failure ?? "ERROR" });
    }
    return { outcome: "UNKNOWN", order: await view() };
  });
}

export type ReconcileOutcome =
  | { outcome: "CONFIRMED" | "REJECTED" | "RESUBMIT_ALLOWED" | "STILL_UNKNOWN" | "MANUAL_REQUIRED" }
  | { outcome: "NOT_UNKNOWN"; status: SupplierOrderStatus };

/**
 * Resolve an UNKNOWN order WITHOUT creating a duplicate purchase. Order of evidence:
 *  1. adapter.statusQuery (if the supplier offers it): CONFIRMED / REJECTED are applied; NOT_FOUND/UNKNOWN prove nothing;
 *  2. a resubmission (UNKNOWN -> CREATED with the SAME key) is allowed ONLY if the supplier documents idempotent submit;
 *  3. otherwise a human must decide (`resolveSupplierOrderManually`).
 */
export async function reconcileSupplierOrder(db: Database, deps: SupplierDeps, orderId: string): Promise<ReconcileOutcome> {
  const o = first<OrderRow & { adapter_key: string }>(
    await db.execute(sql`select o.id, o.supplier_id, o.supplier_product_id, o.order_item_ref, o.quantity, o.idempotency_key, o.status, o.external_ref, o.reject_reason, o.attempts, o.submitting_since, o.note, s.adapter_key
                           from supplier_orders o join suppliers s on s.id = o.supplier_id where o.id = ${orderId}`),
  );
  if (!o) throw new DomainError("SUPPLIER_NOT_FOUND", "supplier order not found");
  if (o.status !== "UNKNOWN") return { outcome: "NOT_UNKNOWN", status: o.status };
  const adapter: SupplierAdapter = getAdapter(deps.adapters, o.adapter_key);

  let q: QueryReply = { status: "UNKNOWN" };
  if (adapter.capabilities.statusQuery) {
    try {
      q = await withCredentials(db, deps.keys, o.supplier_id, (cred) =>
        withTimeout(adapter.queryOrder({ idempotencyKey: o.idempotency_key, ...(o.external_ref ? { externalRef: o.external_ref } : {}), credentials: cred }), deps.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS),
      );
    } catch {
      q = { status: "UNKNOWN" };
    }
  }
  let sealed: { id: string; sealed: Buffer }[] = [];
  if (q.status === "CONFIRMED") {
    try {
      if (typeof q.externalRef !== "string" || !q.externalRef) throw new Error("bad ref");
      sealed = await sealDeliverables(deps.keys, q.deliverables);
    } catch {
      q = { status: "UNKNOWN" };
    }
  }
  return withTransaction(db, async (tx): Promise<ReconcileOutcome> => {
    const now = deps.clock.now();
    const cur = first<OrderRow>(await tx.execute(sql`select ${COLS} from supplier_orders where id = ${orderId} for update`))!;
    if (cur.status !== "UNKNOWN") return { outcome: "NOT_UNKNOWN", status: cur.status };
    if (q.status === "CONFIRMED") {
      await finishConfirmed(tx, deps, cur, q.externalRef, sealed, "system:reconcile", "reconcile");
      return { outcome: "CONFIRMED" };
    }
    if (q.status === "REJECTED") {
      await finishRejected(tx, deps, cur, q.reason, "system:reconcile", "reconcile");
      return { outcome: "REJECTED" };
    }
    if (adapter.capabilities.idempotentSubmit) {
      await tx.execute(sql`update supplier_orders set status = 'CREATED', submitting_since = null, updated_at = ${iso(now)}::timestamptz where id = ${orderId}`);
      await addEvent(tx, orderId, "RESUBMIT_ALLOWED", "system:reconcile", now, { basis: "supplier documents idempotent submit" });
      return { outcome: "RESUBMIT_ALLOWED" };
    }
    await addEvent(tx, orderId, adapter.capabilities.statusQuery ? "STILL_UNKNOWN" : "MANUAL_REQUIRED", "system:reconcile", now);
    return { outcome: adapter.capabilities.statusQuery ? "STILL_UNKNOWN" : "MANUAL_REQUIRED" };
  });
}

/** Safety net for a crashed worker: SUBMITTING past its lease becomes UNKNOWN (never re-sent). SKIP LOCKED; returns how many. */
export async function sweepStuckSubmissions(db: Database, clock: Clock, opts: { leaseSeconds?: number; batchSize?: number } = {}): Promise<number> {
  return withTransaction(db, async (tx) => {
    const now = clock.now();
    const cutoff = new Date(now.getTime() - (opts.leaseSeconds ?? DEFAULT_SUBMIT_LEASE_SECONDS) * 1000);
    const ids = (await tx.execute(sql`select id from supplier_orders where status = 'SUBMITTING' and submitting_since <= ${iso(cutoff)}::timestamptz order by submitting_since limit ${Math.min(opts.batchSize ?? 50, 200)} for update skip locked`)).rows as { id: string }[];
    for (const r of ids) {
      await tx.execute(sql`update supplier_orders set status = 'UNKNOWN', updated_at = ${iso(now)}::timestamptz where id = ${r.id}`);
      await addEvent(tx, r.id, "UNKNOWN", "worker:supplier-sweeper", now, { cause: "LEASE_EXPIRED" });
      await audit(tx, SYSTEM, now, "suppliers.order.unknown", { type: "supplier_order", id: r.id }, { cause: "LEASE_EXPIRED" });
    }
    return ids.length;
  });
}

/** Human resolution of an UNKNOWN order after contacting the supplier. Sensitive; note mandatory; CONFIRMED carries no codes (manual fulfilment). */
export async function resolveSupplierOrderManually(c: SupplierAdminContext, orderId: string, d: { to: "CONFIRMED" | "REJECTED"; note: string; externalRef?: string }): Promise<void> {
  await c.authorize("suppliers.orders.resolve");
  if (d.note.trim().length < 10) throw new DomainError("SUPPLIER_INVALID", "a note of at least 10 characters is required");
  await withTransaction(c.db, async (tx) => {
    const deps: SupplierDeps = { adapters: new Map(), keys: c.keys, clock: c.clock };
    const o = first<OrderRow>(await tx.execute(sql`select ${COLS} from supplier_orders where id = ${orderId} for update`));
    if (!o) throw new DomainError("SUPPLIER_NOT_FOUND", "supplier order not found");
    if (o.status !== "UNKNOWN") throw new DomainError("SUPPLIER_INVALID", "only UNKNOWN orders can be resolved manually");
    const now = c.clock.now();
    if (d.to === "CONFIRMED") {
      await tx.execute(sql`update supplier_orders set note = ${d.note.trim()} where id = ${orderId}`);
      await finishConfirmed(tx, deps, o, d.externalRef ?? o.external_ref, [], c.actor.id, "manual"); // without a reference the note (CHECK) carries the evidence
    } else {
      await finishRejected(tx, deps, o, "OTHER", c.actor.id, "manual");
    }
    await audit(tx, c.actor, now, "suppliers.order.resolved_manually", { type: "supplier_order", id: orderId }, { to: d.to, note: d.note.trim() });
  });
}

export async function getSupplierOrder(db: Database | Tx, orderId: string): Promise<SupplierOrderView | null> {
  const r = first<OrderRow>(await db.execute(sql`select ${COLS} from supplier_orders where id = ${orderId}`));
  if (!r) return null;
  const n = Number((await db.execute(sql`select count(*)::int c from supplier_order_secrets where supplier_order_id = ${orderId}`)).rows[0]!.c);
  return toView(r, n);
}

export async function findSupplierOrderByKey(db: Database | Tx, supplierId: string, idempotencyKey: string): Promise<SupplierOrderView | null> {
  const r = first<OrderRow>(await db.execute(sql`select ${COLS} from supplier_orders where supplier_id = ${supplierId} and idempotency_key = ${idempotencyKey}`));
  return r ? toView(r) : null;
}

/**
 * The ONLY path to supplier-returned plaintext (fulfillment only — an architecture test pins the callers). The order must be CONFIRMED.
 * The access is logged and committed first; the KeyProvider call happens outside any transaction; the buffer is zeroed after `fn`.
 */
export async function withSupplierDeliverable<T>(db: Database, keys: KeyProvider, clock: Clock, req: { supplierOrderId: string; position: number; requestedBy: string }, fn: (plain: Buffer) => Promise<T> | T): Promise<T> {
  const row = await withTransaction(db, async (tx) => {
    const r = first<{ id: string; sealed: Buffer }>(
      await tx.execute(sql`select s.id, s.sealed from supplier_order_secrets s join supplier_orders o on o.id = s.supplier_order_id where s.supplier_order_id = ${req.supplierOrderId} and s.position = ${req.position} and o.status = 'CONFIRMED'`),
    );
    if (!r) throw new DomainError("SUPPLIER_NOT_FOUND", "no confirmed deliverable at this position");
    await addEvent(tx, req.supplierOrderId, "DELIVERABLE_OPENED", req.requestedBy, clock.now(), { position: req.position });
    return r;
  });
  const plain = await openSecret(keys, decodeSealed(row.sealed), secretSealCtx(row.id));
  try {
    return await fn(plain);
  } finally {
    plain.fill(0);
  }
}


/** UNKNOWN / SUBMITTING supplier orders older than `olderThanSeconds` (ageing report for reconciliation). */
export async function listAgedUnresolvedOrders(db: Database | Tx, clock: Clock, olderThanSeconds: number, limit = 100): Promise<{ id: string; status: SupplierOrderStatus; orderItemRef: string }[]> {
  const cutoff = new Date(clock.now().getTime() - olderThanSeconds * 1000);
  const r = await db.execute(sql`select id, status, order_item_ref from supplier_orders where status in ('UNKNOWN','SUBMITTING') and updated_at <= ${iso(cutoff)}::timestamptz order by updated_at limit ${Math.min(limit, 500)}`);
  return (r.rows as { id: string; status: SupplierOrderStatus; order_item_ref: string }[]).map((x) => ({ id: x.id, status: x.status, orderItemRef: x.order_item_ref }));
}
