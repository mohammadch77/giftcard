import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { getVariantSnapshot } from "@/modules/catalog";
import type { Clock } from "@/platform/clock";
import type { KeyProvider } from "@/platform/crypto";
import { decodeSealed, openSecret } from "@/platform/crypto";
import type { Database, Tx } from "@/platform/db";
import { withTransaction } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { uuidv7 } from "@/platform/ids";
import { DEFAULT_RESERVATION_TTL_SECONDS, parse, reserveInput } from "../domain/rules";
import type { ReservationStatus } from "../domain/rules";
import { addMovements, first, iso } from "./shared";
import type { MovementRow, Ts } from "./shared";

const SYSTEM = "system:inventory";
const toDate = (v: Ts): Date => (v instanceof Date ? v : new Date(v.replace(" ", "T").replace(/(\.\d{3})\d*/, "$1").replace(/([+-]\d{2})$/, "$1:00")));

export interface ReservationView { reservationId: string; status: ReservationStatus; expiresAt: Date; replay: boolean }

function requestHash(i: { orderRef: string; ttl: number; lines: { variantId: string; quantity: number }[] }): Buffer {
  return createHash("sha256").update(JSON.stringify([i.orderRef, i.ttl, i.lines.map((l) => [l.variantId, l.quantity])])).digest();
}

/** Return the held stock of a reservation to the pool. Only an ACTIVE reservation can be unwound; returns false otherwise. */
async function unwind(tx: Tx, reservationId: string, to: "RELEASED" | "EXPIRED", now: Date, actor: string, reason: string): Promise<boolean> {
  const closed = await tx.execute(sql`update inventory_reservations set status = ${to}, closed_at = ${iso(now)}::timestamptz where id = ${reservationId} and status = 'ACTIVE' returning id`);
  if (closed.rows.length !== 1) return false;
  const type = to === "EXPIRED" ? "EXPIRE" : "RELEASE";
  const codes = (
    await tx.execute(
      sql`update digital_codes set status = 'AVAILABLE', reservation_id = null, reserved_until = null, updated_at = ${iso(now)}::timestamptz
           where reservation_id = ${reservationId} and status = 'RESERVED' returning id, variant_id`,
    )
  ).rows as { id: string; variant_id: string }[];
  const moves: MovementRow[] = codes.map((c) => ({ variantId: c.variant_id, codeId: c.id, reservationId, type, qtyDelta: 1, reason }));
  const counted = (await tx.execute(sql`select variant_id, quantity from inventory_reservation_lines where reservation_id = ${reservationId} and kind = 'COUNTED' order by variant_id`)).rows as { variant_id: string; quantity: number }[];
  for (const l of counted) {
    await tx.execute(sql`update stock_counters set available = available + ${l.quantity}, reserved = reserved - ${l.quantity}, updated_at = ${iso(now)}::timestamptz where variant_id = ${l.variant_id}`);
    moves.push({ variantId: l.variant_id, reservationId, type, qtyDelta: l.quantity, reason });
  }
  await addMovements(tx, moves, actor, now);
  return true;
}

/** Expire lapsed ACTIVE reservations that hold stock of `variantId` (used when a reserve finds too little). SKIP LOCKED: never waits. */
async function sweepForVariant(tx: Tx, variantId: string, now: Date): Promise<void> {
  const ids = (
    await tx.execute(
      sql`select r.id from inventory_reservations r
           where r.status = 'ACTIVE' and r.expires_at <= ${iso(now)}::timestamptz
             and exists (select 1 from inventory_reservation_lines l where l.reservation_id = r.id and l.variant_id = ${variantId})
           order by r.expires_at limit 50 for update of r skip locked`,
    )
  ).rows as { id: string }[];
  for (const r of ids) await unwind(tx, r.id, "EXPIRED", now, SYSTEM, "lapsed");
}

async function allocateCodes(tx: Tx, variantId: string, qty: number, reservationId: string, until: Date, now: Date): Promise<string[]> {
  const rows = (
    await tx.execute(
      sql`with picked as (
            select id from digital_codes where variant_id = ${variantId} and status = 'AVAILABLE' order by id limit ${qty} for update skip locked)
          update digital_codes c set status = 'RESERVED', reservation_id = ${reservationId}, reserved_until = ${iso(until)}::timestamptz, updated_at = ${iso(now)}::timestamptz
            from picked where c.id = picked.id returning c.id`,
    )
  ).rows as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Atomically reserve stock for an order. All-or-nothing (a savepoint is rolled back on any shortage, so the
 * caller's transaction stays usable) and IDEMPOTENT per `reservationKey`: a repeat returns the existing
 * reservation and never takes more stock; the same key with different content is an IDEMPOTENCY_CONFLICT.
 * Itemised stock uses `FOR UPDATE SKIP LOCKED` (concurrent buyers take different codes, nobody queues);
 * counted stock uses one conditional UPDATE. The TTL is fixed at creation and is never extended (D9).
 * Runs entirely in the database: no external call.
 */
export async function reserve(tx: Tx, clock: Clock, raw: unknown): Promise<ReservationView> {
  const i = parse(reserveInput, raw);
  const now = clock.now();
  const ttl = i.ttlSeconds ?? DEFAULT_RESERVATION_TTL_SECONDS;
  const lines = [...i.lines].sort((a, b) => (a.variantId < b.variantId ? -1 : 1)); // fixed lock order
  if (new Set(lines.map((l) => l.variantId)).size !== lines.length) throw new DomainError("INVENTORY_INVALID", "duplicate variant in reservation");
  const hash = requestHash({ orderRef: i.orderRef, ttl, lines });
  const expiresAt = new Date(now.getTime() + ttl * 1000);

  return tx.transaction(async (sp): Promise<ReservationView> => {
    const id = uuidv7(clock);
    const ins = await sp.execute(
      sql`insert into inventory_reservations (id, reservation_key, order_ref, request_hash, status, created_at, expires_at)
          values (${id}, ${i.reservationKey}, ${i.orderRef}, ${hash}, 'ACTIVE', ${iso(now)}::timestamptz, ${iso(expiresAt)}::timestamptz)
          on conflict (reservation_key) do nothing returning id`,
    );
    if (ins.rows.length === 0) {
      const ex = first<{ id: string; status: ReservationStatus; expires_at: Ts; request_hash: Buffer }>(
        await sp.execute(sql`select id, status, expires_at, request_hash from inventory_reservations where reservation_key = ${i.reservationKey}`),
      )!;
      if (!Buffer.from(ex.request_hash).equals(hash)) throw new DomainError("IDEMPOTENCY_CONFLICT", "reservation key was used with different content");
      return { reservationId: ex.id, status: ex.status, expiresAt: toDate(ex.expires_at), replay: true };
    }
    for (const l of lines) {
      const v = await getVariantSnapshot(sp, l.variantId);
      if (!v) throw new DomainError("CATALOG_NOT_FOUND", "variant not found");
      if (!v.sellable) throw new DomainError("CATALOG_NOT_SELLABLE", "variant is not available for sale");
      if (v.fulfillmentMethod === "SUPPLIER_API") throw new DomainError("INVENTORY_NOT_MANAGED", "supplier-backed variants have no stock here");
      const kind = v.fulfillmentMethod === "AUTO_CODE" ? "ITEMISED" : "COUNTED";
      await sp.execute(sql`insert into inventory_reservation_lines (id, reservation_id, variant_id, kind, quantity) values (${uuidv7(clock)}, ${id}, ${l.variantId}, ${kind}, ${l.quantity})`);
      if (kind === "ITEMISED") {
        let got = await allocateCodes(sp, l.variantId, l.quantity, id, expiresAt, now);
        if (got.length < l.quantity) {
          // Lapsed reservations may be hiding stock: sweep them (SKIP LOCKED) and take what is still missing.
          await sweepForVariant(sp, l.variantId, now);
          got = got.concat(await allocateCodes(sp, l.variantId, l.quantity - got.length, id, expiresAt, now));
        }
        if (got.length < l.quantity) throw new DomainError("INVENTORY_INSUFFICIENT", "not enough stock");
        await addMovements(sp, got.map((codeId) => ({ variantId: l.variantId, codeId, reservationId: id, type: "RESERVE", qtyDelta: -1 })), SYSTEM, now);
      } else {
        const upd = async () =>
          (await sp.execute(sql`update stock_counters set available = available - ${l.quantity}, reserved = reserved + ${l.quantity}, updated_at = ${iso(now)}::timestamptz where variant_id = ${l.variantId} and available >= ${l.quantity} returning variant_id`)).rows.length === 1;
        if (!(await upd())) {
          await sweepForVariant(sp, l.variantId, now);
          if (!(await upd())) throw new DomainError("INVENTORY_INSUFFICIENT", "not enough stock");
        }
        await addMovements(sp, [{ variantId: l.variantId, reservationId: id, type: "RESERVE", qtyDelta: -l.quantity }], SYSTEM, now);
      }
    }
    return { reservationId: id, status: "ACTIVE", expiresAt, replay: false };
  });
}

/** Release an ACTIVE reservation (customer left, checkout failed). Idempotent: false when it was no longer ACTIVE. */
export async function release(tx: Tx, clock: Clock, reservationId: string, reason: string): Promise<boolean> {
  return unwind(tx, reservationId, "RELEASED", clock.now(), SYSTEM, reason.slice(0, 200));
}

export type ConsumeOutcome = { outcome: "CONSUMED"; replay: boolean } | { outcome: "LATE"; status: ReservationStatus };

/**
 * Payment verified: consume the reservation iff it is still ACTIVE and strictly before expiry (D9). Nothing extends
 * the expiry. Anything else is LATE: the caller (orders, 2b-8) routes it to the manual hold path — a lapsed
 * reservation is never used for delivery. The row lock arbitrates against the sweeper: exactly one of them wins.
 */
export async function consume(tx: Tx, clock: Clock, reservationId: string): Promise<ConsumeOutcome> {
  const now = clock.now();
  const ok = await tx.execute(sql`update inventory_reservations set status = 'CONSUMED', consumed_at = ${iso(now)}::timestamptz where id = ${reservationId} and status = 'ACTIVE' and expires_at > ${iso(now)}::timestamptz returning id`);
  if (ok.rows.length === 1) return { outcome: "CONSUMED", replay: false };
  const cur = first<{ status: ReservationStatus }>(await tx.execute(sql`select status from inventory_reservations where id = ${reservationId}`));
  if (!cur) throw new DomainError("INVENTORY_NOT_FOUND", "reservation not found");
  return cur.status === "CONSUMED" ? { outcome: "CONSUMED", replay: true } : { outcome: "LATE", status: cur.status };
}

export interface SoldAssignment { variantId: string; /** Opaque, unique per delivered unit. */ orderItemRef: string }

/** Turn a CONSUMED reservation into sales: one assignment per unit. Idempotent (a fully sold reservation is a no-op replay). */
export async function markSold(tx: Tx, clock: Clock, p: { reservationId: string; assignments: readonly SoldAssignment[] }): Promise<{ replay: boolean; sold: number }> {
  const now = clock.now();
  const r = first<{ status: ReservationStatus }>(await tx.execute(sql`select status from inventory_reservations where id = ${p.reservationId} for update`));
  if (!r) throw new DomainError("INVENTORY_NOT_FOUND", "reservation not found");
  if (r.status !== "CONSUMED") throw new DomainError("INVENTORY_INVALID", "only a consumed reservation can be sold");
  const lines = (await tx.execute(sql`select variant_id, kind, quantity, sold_at from inventory_reservation_lines where reservation_id = ${p.reservationId} order by variant_id`)).rows as { variant_id: string; kind: string; quantity: number; sold_at: Ts | null }[];
  if (lines.every((l) => l.sold_at !== null)) return { replay: true, sold: 0 };
  if (lines.some((l) => l.sold_at !== null)) throw new DomainError("INVENTORY_INVALID", "reservation is partially sold");
  const byVariant = new Map<string, string[]>();
  for (const a of p.assignments) byVariant.set(a.variantId, [...(byVariant.get(a.variantId) ?? []), a.orderItemRef]);
  if (new Set(p.assignments.map((a) => a.orderItemRef)).size !== p.assignments.length) throw new DomainError("INVENTORY_INVALID", "duplicate order item reference");
  for (const l of lines) if ((byVariant.get(l.variant_id)?.length ?? 0) !== l.quantity) throw new DomainError("INVENTORY_INVALID", "assignments must match reserved quantities exactly");
  if (byVariant.size !== lines.length) throw new DomainError("INVENTORY_INVALID", "assignment for a variant that was not reserved");

  const moves: MovementRow[] = [];
  let sold = 0;
  for (const l of lines) {
    const refs = byVariant.get(l.variant_id)!;
    if (l.kind === "ITEMISED") {
      const ids = (await tx.execute(sql`select id from digital_codes where reservation_id = ${p.reservationId} and variant_id = ${l.variant_id} and status = 'RESERVED' order by id for update`)).rows as { id: string }[];
      if (ids.length !== l.quantity) throw new DomainError("INVENTORY_INVALID", "reserved codes do not match the reservation");
      for (let k = 0; k < ids.length; k++) {
        await tx.execute(sql`update digital_codes set status = 'SOLD', order_item_ref = ${refs[k]!}, sold_at = ${iso(now)}::timestamptz, updated_at = ${iso(now)}::timestamptz where id = ${ids[k]!.id}`);
        moves.push({ variantId: l.variant_id, codeId: ids[k]!.id, reservationId: p.reservationId, type: "SELL", qtyDelta: 0, orderItemRef: refs[k]! });
      }
    } else {
      await tx.execute(sql`update stock_counters set reserved = reserved - ${l.quantity}, updated_at = ${iso(now)}::timestamptz where variant_id = ${l.variant_id}`);
      moves.push({ variantId: l.variant_id, reservationId: p.reservationId, type: "SELL", qtyDelta: 0, reason: `units: ${l.quantity}` });
    }
    sold += l.quantity;
    await tx.execute(sql`update inventory_reservation_lines set sold_at = ${iso(now)}::timestamptz where reservation_id = ${p.reservationId} and variant_id = ${l.variant_id}`);
  }
  await addMovements(tx, moves, SYSTEM, now);
  return { replay: false, sold };
}

/**
 * Worker entry point: expire lapsed reservations in small batches (SKIP LOCKED; safe to run from many workers).
 * Pure database work. Returns how many reservations were expired.
 */
export async function sweepExpired(db: Database, clock: Clock, opts: { batchSize?: number } = {}): Promise<number> {
  const batch = Math.min(Math.max(opts.batchSize ?? 100, 1), 500);
  return withTransaction(db, async (tx) => {
    const now = clock.now();
    const ids = (await tx.execute(sql`select id from inventory_reservations where status = 'ACTIVE' and expires_at <= ${iso(now)}::timestamptz order by expires_at limit ${batch} for update skip locked`)).rows as { id: string }[];
    let n = 0;
    for (const r of ids) if (await unwind(tx, r.id, "EXPIRED", now, "worker:inventory-sweeper", "lapsed")) n++;
    return n;
  });
}

export interface DeliveryRequest { codeId: string; orderItemRef: string; requestedBy: string; purpose: string }

/**
 * The ONLY path to a plaintext code. Callable by the fulfilment step (arch test pins that). The code must be SOLD to
 * exactly this order item (so a lapsed/unsold reservation can never be delivered). Disclosure is logged and committed
 * BEFORE the secret is opened; the KeyProvider call happens outside any DB transaction; the buffer is zeroed after `fn`.
 */
export async function withDeliverySecret<T>(db: Database, keys: KeyProvider, clock: Clock, req: DeliveryRequest, fn: (plaintext: Buffer) => Promise<T> | T): Promise<T> {
  const row = await withTransaction(db, async (tx) => {
    const c = first<{ sealed: Buffer; id: string }>(
      await tx.execute(sql`select id, sealed from digital_codes where id = ${req.codeId} and status = 'SOLD' and order_item_ref = ${req.orderItemRef}`),
    );
    if (!c) throw new DomainError("INVENTORY_NOT_FOUND", "no sold code for this order item");
    await tx.execute(sql`insert into code_access_log (code_id, order_item_ref, requested_by, purpose, accessed_at) values (${req.codeId}, ${req.orderItemRef}, ${req.requestedBy}, ${req.purpose.slice(0, 100)}, ${iso(clock.now())}::timestamptz)`);
    return c;
  });
  const kind = (await db.execute(sql`select payload_kind from digital_codes where id = ${row.id}`)).rows[0] as { payload_kind: string };
  const plain = await openSecret(keys, decodeSealed(row.sealed), { table: "digital_codes", rowId: row.id, kind: kind.payload_kind === "ACCOUNT" ? "account_credential" : "code" });
  try {
    return await fn(plain);
  } finally {
    plain.fill(0);
  }
}

export interface Availability { variantId: string; itemisedAvailable: number; itemisedReserved: number; countedAvailable: number; countedReserved: number }

export async function availability(db: Database | Tx, variantIds: readonly string[]): Promise<Availability[]> {
  if (variantIds.length === 0 || variantIds.length > 100) throw new DomainError("INVENTORY_INVALID", "1..100 variant ids expected");
  const list = sql.join(variantIds.map((v) => sql`${v}::uuid`), sql`, `);
  const r = await db.execute(
    sql`select v.id as variant_id,
          (select count(*) from digital_codes c where c.variant_id = v.id and c.status = 'AVAILABLE')::int as ia,
          (select count(*) from digital_codes c where c.variant_id = v.id and c.status = 'RESERVED')::int as ir,
          coalesce((select available from stock_counters s where s.variant_id = v.id), 0) as ca,
          coalesce((select reserved from stock_counters s where s.variant_id = v.id), 0) as cr
        from (select unnest(array[${list}]::uuid[]) as id) v`,
  );
  return (r.rows as { variant_id: string; ia: number; ir: number; ca: number; cr: number }[]).map((x) => ({
    variantId: x.variant_id, itemisedAvailable: x.ia, itemisedReserved: x.ir, countedAvailable: Number(x.ca), countedReserved: Number(x.cr),
  }));
}

export interface IntegrityFinding { check: string; detail: string }

/** Read-only consistency report (empty = healthy). Intended for tests, the worker and admin tooling. */
export async function verifyInventory(db: Database | Tx): Promise<IntegrityFinding[]> {
  const out: IntegrityFinding[] = [];
  const q = async (check: string, query: ReturnType<typeof sql>) => {
    for (const row of (await db.execute(query)).rows as { d: string }[]) out.push({ check, detail: row.d });
  };
  await q("reserved_code_without_open_reservation", sql`select c.id::text as d from digital_codes c join inventory_reservations r on r.id = c.reservation_id where c.status = 'RESERVED' and r.status not in ('ACTIVE','CONSUMED')`);
  await q("sold_code_without_consumed_reservation", sql`select c.id::text as d from digital_codes c join inventory_reservations r on r.id = c.reservation_id where c.status = 'SOLD' and r.status <> 'CONSUMED'`);
  await q("itemised_line_vs_codes", sql`select l.id::text as d from inventory_reservation_lines l join inventory_reservations r on r.id = l.reservation_id
      where l.kind = 'ITEMISED' and r.status in ('ACTIVE','CONSUMED')
        and (select count(*) from digital_codes c where c.reservation_id = r.id and c.variant_id = l.variant_id and c.status in ('RESERVED','SOLD')) <> l.quantity`);
  await q("closed_reservation_still_holds_codes", sql`select r.id::text as d from inventory_reservations r where r.status in ('RELEASED','EXPIRED') and exists (select 1 from digital_codes c where c.reservation_id = r.id)`);
  await q("counted_reserved_vs_lines", sql`select s.variant_id::text as d from stock_counters s
      where s.reserved <> coalesce((select sum(l.quantity) from inventory_reservation_lines l join inventory_reservations r on r.id = l.reservation_id
                                     where l.variant_id = s.variant_id and l.kind = 'COUNTED' and l.sold_at is null and r.status in ('ACTIVE','CONSUMED')), 0)`);
  await q("itemised_movements_vs_available", sql`select v.variant_id::text as d from (select variant_id, sum(qty_delta) s from inventory_movements where code_id is not null group by variant_id) v
      where v.s <> (select count(*) from digital_codes c where c.variant_id = v.variant_id and c.status = 'AVAILABLE')`);
  return out;
}

/** Which sold code backs an order item (for fulfilment to record the delivery). Returns the opaque code id only — never any secret. */
export async function getSoldCodeRef(db: Database | Tx, orderItemRef: string): Promise<string | null> {
  const r = first<{ id: string }>(await db.execute(sql`select id from digital_codes where order_item_ref = ${orderItemRef} and status = 'SOLD'`));
  return r?.id ?? null;
}
