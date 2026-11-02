import { sql } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import type { AuditActor } from "@/modules/audit";
import { getVariantSnapshot } from "@/modules/catalog";
import { getSoldCodeRef, markSold, withDeliverySecret } from "@/modules/inventory";
import type { SoldAssignment } from "@/modules/inventory";
import { createSupplierOrder, findSupplierOrderByKey, getRoutes, getSupplierOrder, reconcileSupplierOrder, submitSupplierOrder, withSupplierDeliverable } from "@/modules/suppliers";
import type { SupplierDeps } from "@/modules/suppliers";
import type { Clock } from "@/platform/clock";
import type { KeyProvider } from "@/platform/crypto";
import { decodeSealed, encodeSealed, openSecret, sealSecret } from "@/platform/crypto";
import type { Database, Tx } from "@/platform/db";
import { withTransaction } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { uuidv7 } from "@/platform/ids";
import { enqueueOutbox } from "@/platform/outbox";
import { consumeRateLimit } from "@/platform/ratelimit";
import { REVEAL_LIMIT } from "../domain/types";
import type { DisclosureState, FulfillmentMethod, TaskStatus } from "../domain/types";

const SYSTEM: AuditActor = { type: "SYSTEM", id: "system:fulfillment" };
type Ts = Date | string;
const iso = (d: Date) => d.toISOString();
const first = <T>(r: { rows: unknown[] }): T | undefined => r.rows[0] as T | undefined;
const secretCtx = (id: string) => ({ table: "delivery_secrets", rowId: id, kind: "delivery_secret" });

export interface TaskView { id: string; orderRef: string; orderItemRef: string; userRef: string; variantId: string; method: FulfillmentMethod; status: TaskStatus; assignee: string | null; attempt: number; lastError: string | null; supplierOrderId: string | null }
interface TaskRow { id: string; order_ref: string; order_item_ref: string; user_ref: string; variant_id: string; method: FulfillmentMethod; status: TaskStatus; assignee: string | null; attempt: number; last_error: string | null; supplier_order_id: string | null; updated_at?: Ts }
const COLS = sql`id, order_ref, order_item_ref, user_ref, variant_id, method, status, assignee, attempt, last_error, supplier_order_id`;
const toView = (r: TaskRow): TaskView => ({ id: r.id, orderRef: r.order_ref, orderItemRef: r.order_item_ref, userRef: r.user_ref, variantId: r.variant_id, method: r.method, status: r.status, assignee: r.assignee, attempt: r.attempt, lastError: r.last_error, supplierOrderId: r.supplier_order_id });

async function event(tx: Tx, taskId: string, type: string, actor: string, now: Date, detail?: string): Promise<void> {
  await tx.execute(sql`insert into fulfillment_events (task_id, type, detail, actor, created_at) values (${taskId}, ${type}, ${detail ?? null}, ${actor}, ${iso(now)}::timestamptz)`);
}

/**
 * Create one PENDING task per paid order item (called by orders after PAID). Idempotent per order item. `paymentRef` is the opaque
 * proof reference of the PAID order; the database-level payment gate needs the orders table and is installed in 2b-8 (recorded in
 * PHASE_2B_PLAN) — until then fulfillment trusts its single caller.
 */
export async function createTasks(tx: Tx, clock: Clock, input: { orderRef: string; userRef: string; paymentRef: string; items: readonly { orderItemRef: string; variantId: string }[] }): Promise<{ created: number; existing: number }> {
  if (!input.orderRef || !input.userRef || !input.paymentRef || input.items.length < 1 || input.items.length > 500) throw new DomainError("FULFILLMENT_INVALID", "invalid task request");
  const now = clock.now();
  let created = 0;
  for (const it of input.items) {
    if (!it.orderItemRef || it.orderItemRef.length > 200) throw new DomainError("FULFILLMENT_INVALID", "invalid order item reference");
    const v = await getVariantSnapshot(tx, it.variantId);
    if (!v) throw new DomainError("FULFILLMENT_INVALID", "variant not found");
    const id = uuidv7(clock);
    const r = await tx.execute(
      sql`insert into fulfillment_tasks (id, order_ref, order_item_ref, user_ref, variant_id, method, status, payment_ref, created_at, updated_at)
          values (${id}, ${input.orderRef}, ${it.orderItemRef}, ${input.userRef}, ${it.variantId}, ${v.fulfillmentMethod}, 'PENDING', ${input.paymentRef}, ${iso(now)}::timestamptz, ${iso(now)}::timestamptz)
          on conflict (order_item_ref) do nothing returning id`,
    );
    if (r.rows.length) {
      created++;
      await event(tx, id, "CREATED", SYSTEM.id, now, v.fulfillmentMethod);
    }
  }
  return { created, existing: input.items.length - created };
}

async function completeTask(tx: Tx, clock: Clock, taskId: string, actor: string, detail: string): Promise<void> {
  const now = clock.now();
  const t = first<{ status: TaskStatus; order_item_ref: string }>(await tx.execute(sql`select status, order_item_ref from fulfillment_tasks where id = ${taskId} for update`))!;
  if (t.status === "COMPLETED") return;
  if (t.status === "PENDING") await tx.execute(sql`update fulfillment_tasks set status = 'PROCESSING', updated_at = ${iso(now)}::timestamptz where id = ${taskId}`);
  if (t.status === "FAILED") await tx.execute(sql`update fulfillment_tasks set status = 'PROCESSING', updated_at = ${iso(now)}::timestamptz where id = ${taskId}`);
  await tx.execute(sql`update fulfillment_tasks set status = 'COMPLETED', completed_at = ${iso(now)}::timestamptz, last_error = null, updated_at = ${iso(now)}::timestamptz where id = ${taskId}`);
  await event(tx, taskId, "DELIVERED", actor, now, detail);
  await enqueueOutbox(tx, { eventType: "fulfillment.delivered", aggregateType: "order_item", aggregateId: t.order_item_ref, payload: { taskId, orderItemRef: t.order_item_ref } }, clock);
  await recordAudit(tx, { actor: actor.startsWith("system:") ? SYSTEM : { type: "ADMIN", id: actor }, action: "fulfillment.task.completed", entity: { type: "fulfillment_task", id: taskId }, metadata: { via: detail }, occurredAt: now });
}

/**
 * Deliver inventory-backed items of a CONSUMED reservation: marks the reservation's stock SOLD (inventory.markSold — it refuses anything
 * but a CONSUMED reservation, so an expired/late one can never be delivered) and records one delivery per AUTO_CODE item. `assignments`
 * must cover EVERY line of the reservation (counted/manual lines included); only AUTO_CODE tasks get a code delivery here. Idempotent.
 */
export async function deliverAutoCodes(tx: Tx, clock: Clock, input: { reservationId: string; assignments: readonly SoldAssignment[] }): Promise<{ delivered: number; replay: boolean }> {
  const refs = input.assignments.map((a) => a.orderItemRef);
  if (refs.length < 1) throw new DomainError("FULFILLMENT_INVALID", "no assignments");
  const tasks = (await tx.execute(sql`select ${COLS} from fulfillment_tasks where order_item_ref in (${sql.join(refs.map((r) => sql`${r}`), sql`, `)}) order by order_item_ref for update`)).rows as unknown as TaskRow[];
  if (tasks.length !== refs.length) throw new DomainError("FULFILLMENT_INVALID", "every assigned order item needs a fulfilment task");
  const sold = await markSold(tx, clock, { reservationId: input.reservationId, assignments: input.assignments });
  const now = clock.now();
  let delivered = 0;
  for (const t of tasks) {
    if (t.method !== "AUTO_CODE" || t.status === "COMPLETED") continue;
    const codeId = await getSoldCodeRef(tx, t.order_item_ref);
    if (!codeId) throw new DomainError("FULFILLMENT_INVALID", "no sold code for this order item");
    await tx.execute(sql`insert into deliveries (id, order_item_ref, user_ref, kind, code_ref, delivered_at) values (${uuidv7(clock)}, ${t.order_item_ref}, ${t.user_ref}, 'INVENTORY_CODE', ${codeId}, ${iso(now)}::timestamptz) on conflict (order_item_ref) do nothing`);
    await completeTask(tx, clock, t.id, SYSTEM.id, "inventory code");
    delivered++;
  }
  return { delivered, replay: sold.replay };
}

// ------------------------------------------------------------------ supplier path

export interface FulfillDeps extends SupplierDeps { db: Database }
export type SupplierFulfillOutcome =
  | { outcome: "COMPLETED" }
  | { outcome: "AWAITING_RECONCILIATION" | "RETRYABLE" | "MANUAL_REQUIRED" | "NO_ROUTE" | "NOT_APPLICABLE"; status: TaskStatus };

/**
 * Fulfil a SUPPLIER_API task through its routes in priority order. SAFETY: a route whose order is UNKNOWN/SUBMITTING stops everything
 * (`AWAITING_RECONCILIATION`) — a second supplier is NEVER tried while the first outcome is ambiguous, so one customer item cannot be
 * purchased twice. Only an explicit REJECTED moves on to the next route. Idempotent: re-running resumes where the item stands.
 */
export async function fulfillSupplierTask(deps: FulfillDeps, taskId: string): Promise<SupplierFulfillOutcome> {
  const db = deps.db;
  let t = first<TaskRow>(await db.execute(sql`select ${COLS} from fulfillment_tasks where id = ${taskId}`));
  if (!t) throw new DomainError("FULFILLMENT_NOT_FOUND", "task not found");
  if (t.method !== "SUPPLIER_API" || t.status === "COMPLETED" || t.status === "CANCELLED") return { outcome: "NOT_APPLICABLE", status: t.status };
  const routes = (await getRoutes(db, t.variant_id)).filter((r) => r.available);
  if (routes.length === 0) {
    await markFailed(db, deps.clock, t, "no available supplier route");
    return { outcome: "NO_ROUTE", status: "FAILED" };
  }
  await withTransaction(db, async (tx) => {
    const now = deps.clock.now();
    const r = await tx.execute(sql`update fulfillment_tasks set status = 'PROCESSING', attempt = attempt + 1, updated_at = ${iso(now)}::timestamptz where id = ${taskId} and status in ('PENDING','FAILED','PROCESSING') returning id`);
    if (r.rows.length) await event(tx, taskId, "SUPPLIER_STARTED", SYSTEM.id, now);
  });
  for (const route of routes) {
    const key = `fulfil:${t.order_item_ref}:${route.supplierProductId}`;
    const existing = await findSupplierOrderByKey(db, route.supplierId, key);
    let orderId: string;
    if (!existing) {
      orderId = (await withTransaction(db, (tx) => createSupplierOrder(tx, deps.clock, { supplierProductId: route.supplierProductId, orderItemRef: t!.order_item_ref, quantity: 1, idempotencyKey: key }))).order.id;
    } else {
      orderId = existing.id;
      if (existing.status === "REJECTED") continue;
      if (existing.status === "UNKNOWN" || existing.status === "SUBMITTING") {
        if (existing.status === "UNKNOWN") {
          const rec = await reconcileSupplierOrder(db, deps, existing.id);
          if (rec.outcome === "REJECTED") continue;
          if (rec.outcome !== "CONFIRMED" && rec.outcome !== "RESUBMIT_ALLOWED") return { outcome: "AWAITING_RECONCILIATION", status: "PROCESSING" };
        } else {
          return { outcome: "AWAITING_RECONCILIATION", status: "PROCESSING" };
        }
      }
    }
    await withTransaction(db, (tx) => tx.execute(sql`update fulfillment_tasks set supplier_order_id = ${orderId} where id = ${taskId}`));
    let cur = (await findSupplierOrderByKey(db, route.supplierId, key))!;
    if (cur.status === "CREATED") {
      const sub = await submitSupplierOrder(db, deps, orderId);
      if (sub.outcome === "RETRYABLE" || sub.outcome === "NOT_SUBMITTABLE") return { outcome: "RETRYABLE", status: "PROCESSING" };
      cur = (await findSupplierOrderByKey(db, route.supplierId, key))!;
    }
    // Decide ONLY from the order's settled state; anything not settled (SUBMITTING by someone else, UNKNOWN) stops here.
    if (cur.status === "REJECTED") continue;
    if (cur.status !== "CONFIRMED") return { outcome: "AWAITING_RECONCILIATION", status: "PROCESSING" };
    return finalizeSupplierDelivery(deps, taskId, orderId);
  }
  t = first<TaskRow>(await db.execute(sql`select ${COLS} from fulfillment_tasks where id = ${taskId}`))!;
  await markFailed(db, deps.clock, t, "all supplier routes rejected");
  return { outcome: "NO_ROUTE", status: "FAILED" };
}

async function markFailed(db: Database, clock: Clock, t: TaskRow, reason: string): Promise<void> {
  await withTransaction(db, async (tx) => {
    const now = clock.now();
    if (t.status === "PENDING") await tx.execute(sql`update fulfillment_tasks set status = 'PROCESSING', updated_at = ${iso(now)}::timestamptz where id = ${t.id} and status = 'PENDING'`);
    const r = await tx.execute(sql`update fulfillment_tasks set status = 'FAILED', last_error = ${reason}, updated_at = ${iso(now)}::timestamptz where id = ${t.id} and status in ('PROCESSING')  returning id`);
    if (r.rows.length) await event(tx, t.id, "FAILED", SYSTEM.id, now, reason);
  });
}

/** CONFIRMED supplier order -> delivery. Re-seals the supplier-returned data into delivery_secrets (outside any transaction) and completes the task. */
async function finalizeSupplierDelivery(deps: FulfillDeps, taskId: string, supplierOrderId: string): Promise<SupplierFulfillOutcome> {
  const db = deps.db;
  const t = first<TaskRow>(await db.execute(sql`select ${COLS} from fulfillment_tasks where id = ${taskId}`))!;
  if (t.status === "COMPLETED") return { outcome: "COMPLETED" };
  const has = (await getSupplierOrder(db, supplierOrderId))?.deliverableCount ?? 0;
  if (has < 1) {
    // Confirmed but no data came back (supplier does not return codes, or a human resolved it): a person must deliver.
    await markFailed(db, deps.clock, t, "supplier confirmed without delivered data; manual delivery required");
    return { outcome: "MANUAL_REQUIRED", status: "FAILED" };
  }
  const deliveryId = uuidv7(deps.clock);
  const secretId = uuidv7(deps.clock); // the envelope's AAD binds it to THIS delivery_secrets row
  const sealed = await withSupplierDeliverable(db, deps.keys, deps.clock, { supplierOrderId, position: 0, requestedBy: SYSTEM.id }, async (plain) =>
    encodeSealed(await sealSecret(deps.keys, plain, secretCtx(secretId))),
  );
  await withTransaction(db, async (tx) => {
    const now = deps.clock.now();
    const ins = await tx.execute(sql`insert into deliveries (id, order_item_ref, user_ref, kind, delivered_at) values (${deliveryId}, ${t.order_item_ref}, ${t.user_ref}, 'SUPPLIER_CODE', ${iso(now)}::timestamptz) on conflict (order_item_ref) do nothing returning id`);
    if (ins.rows.length) await tx.execute(sql`insert into delivery_secrets (id, delivery_id, sealed, created_at) values (${secretId}, ${deliveryId}, ${sealed}, ${iso(now)}::timestamptz)`);
    await completeTask(tx, deps.clock, taskId, SYSTEM.id, "supplier code");
  });
  return { outcome: "COMPLETED" };
}

// ------------------------------------------------------------------ manual path

export interface FulfillmentAdminContext { db: Database; clock: Clock; keys: KeyProvider; actor: AuditActor; authorize(permission: string): Promise<void> }

/** Pick up a manual task (or take over a FAILED one as manual fallback). Exactly one admin wins a race. */
export async function claimManualTask(c: FulfillmentAdminContext, taskId: string): Promise<TaskView> {
  await c.authorize("fulfillment.manual.claim");
  return withTransaction(c.db, async (tx) => {
    const now = c.clock.now();
    const r = await tx.execute(
      sql`update fulfillment_tasks set status = 'PROCESSING', assignee = ${c.actor.id}, attempt = attempt + 1, updated_at = ${iso(now)}::timestamptz
           where id = ${taskId} and ((method = 'MANUAL' and status = 'PENDING') or status = 'FAILED') returning ${COLS}`,
    );
    if (!r.rows.length) throw new DomainError("FULFILLMENT_INVALID", "task is not available for manual pickup");
    await event(tx, taskId, "CLAIMED", c.actor.id, now);
    await recordAudit(tx, { actor: c.actor, action: "fulfillment.task.claimed", entity: { type: "fulfillment_task", id: taskId }, occurredAt: now });
    return toView(r.rows[0] as unknown as TaskRow);
  });
}

/** Enter the credentials/secret for a claimed task. Only the assignee can complete; the secret is sealed BEFORE the transaction and never audited. */
export async function completeManualTask(c: FulfillmentAdminContext, taskId: string, secret: string): Promise<void> {
  await c.authorize("fulfillment.manual.complete");
  if (typeof secret !== "string" || secret.length < 1 || secret.length > 4096) throw new DomainError("FULFILLMENT_INVALID", "invalid secret");
  const t = first<TaskRow>(await c.db.execute(sql`select ${COLS} from fulfillment_tasks where id = ${taskId}`));
  if (!t) throw new DomainError("FULFILLMENT_NOT_FOUND", "task not found");
  if (t.status !== "PROCESSING" || t.assignee !== c.actor.id) throw new DomainError("FULFILLMENT_INVALID", "only the assignee of a task in progress can complete it");
  const deliveryId = uuidv7(c.clock);
  const secretId = uuidv7(c.clock);
  const sealed = encodeSealed(await sealSecret(c.keys, secret, secretCtx(secretId)));
  await withTransaction(c.db, async (tx) => {
    const now = c.clock.now();
    const cur = first<{ status: TaskStatus; assignee: string | null }>(await tx.execute(sql`select status, assignee from fulfillment_tasks where id = ${taskId} for update`))!;
    if (cur.status !== "PROCESSING" || cur.assignee !== c.actor.id) throw new DomainError("FULFILLMENT_INVALID", "task changed concurrently");
    await tx.execute(sql`insert into deliveries (id, order_item_ref, user_ref, kind, delivered_at) values (${deliveryId}, ${t.order_item_ref}, ${t.user_ref}, 'MANUAL_CREDENTIAL', ${iso(now)}::timestamptz)`);
    await tx.execute(sql`insert into delivery_secrets (id, delivery_id, sealed, created_at) values (${secretId}, ${deliveryId}, ${sealed}, ${iso(now)}::timestamptz)`);
    await completeTask(tx, c.clock, taskId, c.actor.id, "manual credential");
  });
}

export async function getTask(db: Database | Tx, taskId: string): Promise<TaskView | null> {
  const r = first<TaskRow>(await db.execute(sql`select ${COLS} from fulfillment_tasks where id = ${taskId}`));
  return r ? toView(r) : null;
}

export async function listTasksAdmin(c: FulfillmentAdminContext, opts: { status?: TaskStatus; limit?: number } = {}): Promise<TaskView[]> {
  await c.authorize("fulfillment.tasks.read");
  const r = await c.db.execute(sql`select ${COLS} from fulfillment_tasks ${opts.status ? sql`where status = ${opts.status}` : sql``} order by created_at limit ${Math.min(opts.limit ?? 50, 200)}`);
  return (r.rows as unknown as TaskRow[]).map(toView);
}

// ------------------------------------------------------------------ delivery access

export async function deliveryStatus(db: Database | Tx, orderItemRef: string): Promise<{ deliveryId: string | null; state: DisclosureState; revealCount: number }> {
  const d = first<{ id: string; first_revealed_by_type: string | null; reveal_count: number }>(await db.execute(sql`select id, first_revealed_by_type, reveal_count from deliveries where order_item_ref = ${orderItemRef}`));
  if (!d) return { deliveryId: null, state: "NOT_DELIVERED", revealCount: 0 };
  const state: DisclosureState = d.reveal_count === 0 ? "DELIVERED_UNREVEALED" : d.first_revealed_by_type === "CUSTOMER" ? "REVEALED_BY_CUSTOMER" : "REVEALED_BY_ADMIN_ONLY";
  return { deliveryId: d.id, state, revealCount: d.reveal_count };
}

export interface RevealRequest {
  deliveryId: string;
  actor: { type: "CUSTOMER" | "ADMIN"; id: string };
  /** For ADMIN: binds identity's authorize('fulfillment.codes.reveal'). Customers are checked by ownership instead. */
  authorize?: () => Promise<void>;
}

/**
 * Reveal a delivered secret to its owner (or, with permission, an administrator). Order of events:
 *  rate limit -> ownership/permission -> TX: append secret_access_log + bump counters (COMMITTED) -> open the secret (KeyProvider call,
 *  no transaction open) -> hand the plaintext to `fn` -> zero it. If the log write fails, nothing is opened or returned.
 * A delivery of another user is indistinguishable from a missing one (IDOR-safe).
 */
export async function withRevealedSecret<T>(deps: { db: Database; keys: KeyProvider; clock: Clock }, req: RevealRequest, fn: (plain: Buffer) => Promise<T> | T): Promise<T> {
  const { db } = deps;
  const rl = await consumeRateLimit(db, { bucket: `reveal:${req.actor.type}:${req.actor.id}`, ...REVEAL_LIMIT }, deps.clock);
  if (!rl.allowed) throw new DomainError("FULFILLMENT_INVALID", "too many reveal attempts");
  const d = first<{ id: string; order_item_ref: string; user_ref: string; kind: string; code_ref: string | null }>(
    await db.execute(sql`select id, order_item_ref, user_ref, kind, code_ref from deliveries where id = ${req.deliveryId}`),
  );
  if (req.actor.type === "CUSTOMER") {
    if (!d || d.user_ref !== req.actor.id) throw new DomainError("FULFILLMENT_NOT_FOUND", "delivery not found");
  } else {
    if (!req.authorize) throw new DomainError("FULFILLMENT_INVALID", "administrator access needs an authorisation check");
    await req.authorize();
    if (!d) throw new DomainError("FULFILLMENT_NOT_FOUND", "delivery not found");
  }
  await withTransaction(db, async (tx) => {
    const now = iso(deps.clock.now());
    await tx.execute(sql`insert into secret_access_log (delivery_id, actor_type, actor_id, action, created_at) values (${d.id}, ${req.actor.type}, ${req.actor.id}, ${req.actor.type === "ADMIN" ? "ADMIN_REVEAL" : "REVEAL"}, ${now}::timestamptz)`);
    await tx.execute(
      sql`update deliveries set reveal_count = reveal_count + 1, first_revealed_at = coalesce(first_revealed_at, ${now}::timestamptz), first_revealed_by_type = coalesce(first_revealed_by_type, ${req.actor.type}), last_revealed_at = ${now}::timestamptz where id = ${d.id}`,
    );
  }); // committed here: no plaintext has been touched yet

  if (d.kind === "INVENTORY_CODE") {
    return withDeliverySecret(db, deps.keys, deps.clock, { codeId: d.code_ref!, orderItemRef: d.order_item_ref, requestedBy: `${req.actor.type.toLowerCase()}:${req.actor.id}`, purpose: "reveal" }, fn);
  }
  const s = first<{ id: string; sealed: Buffer }>(await db.execute(sql`select id, sealed from delivery_secrets where delivery_id = ${d.id}`));
  if (!s) throw new DomainError("FULFILLMENT_NOT_FOUND", "delivery has no stored secret");
  const plain = await openSecret(deps.keys, decodeSealed(s.sealed), secretCtx(s.id));
  try {
    return await fn(plain);
  } finally {
    plain.fill(0);
  }
}

/** Tasks of one order (read-only view for orders to derive its fulfilment status). */
export async function listTasksForOrder(db: Database | Tx, orderRef: string): Promise<TaskView[]> {
  const r = await db.execute(sql`select ${COLS} from fulfillment_tasks where order_ref = ${orderRef} order by order_item_ref`);
  return (r.rows as unknown as TaskRow[]).map(toView);
}
