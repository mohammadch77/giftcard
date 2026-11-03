import { sql } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import type { AuditActor } from "@/modules/audit";
import { getVariantSnapshot } from "@/modules/catalog";
import type { VariantUsageProbe } from "@/modules/catalog";
import type { Clock } from "@/platform/clock";
import type { KeyProvider } from "@/platform/crypto";
import { encodeSealed, fingerprint, fingerprintsAllVersions, normalizeCode, sealSecret } from "@/platform/crypto";
import type { Database, Tx } from "@/platform/db";
import { withTransaction } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { uuidv7 } from "@/platform/ids";
import { setTransitionContext } from "@/platform/transitions";
import { ADMIN_CODE_TRANSITIONS, MAX_SECRET_LENGTH, importInput, parse } from "../domain/rules";
import type { CodeStatus } from "../domain/rules";
import { availability } from "./reservations";
import type { Availability } from "./reservations";
import { addMovements, first, iso } from "./shared";

export interface InventoryAdminContext {
  db: Database;
  clock: Clock;
  keys: KeyProvider;
  actor: AuditActor;
  authorize(permission: string): Promise<void>;
}

const FP_PURPOSE = "inventory.code";
const secretKind = (k: "CODE" | "ACCOUNT") => (k === "ACCOUNT" ? "account_credential" : "code");
const PG: Record<string, string> = { "23514": "violates an inventory rule", "40P01": "conflict, retry", PT001: "invalid status transition" };
function translate(e: unknown): never {
  const code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
  if (code === "23514") throw new DomainError("INVENTORY_INSUFFICIENT", "quantity would become negative", { cause: e });
  if (code && PG[code]) throw new DomainError("INVENTORY_INVALID", PG[code]!, { cause: e });
  throw e;
}

export interface ImportResult { batchId: string; imported: number; duplicates: number; invalid: number; /** Codes skipped because their supplier expiry had already passed. */ expired: number }

/**
 * Import pre-loaded codes/accounts for an AUTO_CODE variant. Codes are normalised, fingerprinted (keyed HMAC) and sealed
 * (AES-256-GCM envelope) BEFORE the transaction — KeyProvider calls never run inside a DB transaction. Duplicates
 * (in the file or already in stock, under ANY pepper version) are skipped and only COUNTED. Plaintext codes are never
 * logged, audited, returned or placed in error messages. Fails closed when no KeyProvider is configured (D8).
 */
export async function importCodes(c: InventoryAdminContext, variantId: string, raw: unknown): Promise<ImportResult> {
  await c.authorize("inventory.codes.import");
  const input = parse(importInput, raw);
  const v = await getVariantSnapshot(c.db, variantId);
  if (!v) throw new DomainError("CATALOG_NOT_FOUND", "variant not found");
  if (v.fulfillmentMethod !== "AUTO_CODE") throw new DomainError("INVENTORY_INVALID", "codes can only be imported for AUTO_CODE variants");

  type Prepared = { id: string; fp: Buffer; version: number; sealed: Buffer; expiresAt: Date | null };
  const seen = new Set<string>();
  const prepared: Prepared[] = [];
  const importedAt = c.clock.now();
  let invalid = 0;
  let duplicates = 0;
  let expiredOnImport = 0;
  for (const entry of input.codes) {
    const code = typeof entry === "string" ? entry : entry.code;
    const expiresAt = (typeof entry === "string" ? undefined : entry.expiresAt) ?? input.expiresAt ?? null;
    if (code.length === 0 || code.length > MAX_SECRET_LENGTH) { invalid++; continue; }
    if (expiresAt !== null && expiresAt.getTime() <= importedAt.getTime()) { expiredOnImport++; continue; } // OPS-2: expired stock is never admitted
    let norm: string;
    try {
      norm = input.payloadKind === "ACCOUNT" ? code : normalizeCode(code);
    } catch {
      invalid++;
      continue;
    }
    if (seen.has(norm)) { duplicates++; continue; }
    seen.add(norm);
    const id = uuidv7(c.clock);
    const fp = await fingerprint(c.keys, FP_PURPOSE, norm);
    prepared.push({ id, fp: fp.digest, version: fp.hmacVersion, sealed: Buffer.alloc(0), expiresAt });
    prepared[prepared.length - 1]!.sealed = encodeSealed(await sealSecret(c.keys, norm, { table: "digital_codes", rowId: id, kind: secretKind(input.payloadKind) }));
  }
  // Duplicates already in stock under ANY pepper version (a pepper rotation must not hide them).
  const norms = [...seen];
  const allFps = await Promise.all(norms.map((n) => fingerprintsAllVersions(c.keys, FP_PURPOSE, n)));
  const known = new Set<string>();
  for (let i = 0; i < allFps.length; i += 200) {
    const pairs = allFps.slice(i, i + 200).flat();
    const hit = await c.db.execute(sql`select hmac_version, code_fp from digital_codes where (hmac_version, code_fp) in (${sql.join(pairs.map((f) => sql`(${f.hmacVersion}, ${f.digest})`), sql`, `)})`);
    for (const r of hit.rows as { hmac_version: number; code_fp: Buffer }[]) known.add(`${r.hmac_version}:${Buffer.from(r.code_fp).toString("hex")}`);
  }
  const fresh: Prepared[] = [];
  prepared.forEach((p, idx) => {
    const dup = allFps[idx]!.some((f) => known.has(`${f.hmacVersion}:${f.digest.toString("hex")}`));
    if (dup) duplicates++;
    else fresh.push(p);
  });
  prepared.length = 0;
  prepared.push(...fresh);

  const batchId = uuidv7(c.clock);
  try {
    return await withTransaction(c.db, async (tx) => {
      const now = importedAt;
      let imported = 0;
      const moves: { variantId: string; codeId: string; type: string; qtyDelta: number }[] = [];
      await setTransitionContext(tx, { actorId: c.actor.id, reason: "import" });
      await tx.execute(sql`insert into inventory_batches (id, variant_id, code_count, note, expires_at, created_by, created_at) values (${batchId}, ${variantId}, ${prepared.length}, ${input.note ?? null}, ${input.expiresAt ? iso(input.expiresAt) : null}::timestamptz, ${c.actor.id}, ${iso(now)}::timestamptz)`);
      for (let i = 0; i < prepared.length; i += 200) {
        const chunk = prepared.slice(i, i + 200);
        const ins = await tx.execute(
          sql`insert into digital_codes (id, variant_id, batch_id, code_fp, hmac_version, sealed, payload_kind, status, expires_at, created_at, updated_at) values ${sql.join(
            chunk.map((p) => sql`(${p.id}::uuid, ${variantId}::uuid, ${batchId}::uuid, ${p.fp}, ${p.version}, ${p.sealed}, ${input.payloadKind}, 'AVAILABLE', ${p.expiresAt ? iso(p.expiresAt) : null}::timestamptz, ${iso(now)}::timestamptz, ${iso(now)}::timestamptz)`),
            sql`, `,
          )} on conflict (hmac_version, code_fp) do nothing returning id`,
        );
        const ok = new Set((ins.rows as { id: string }[]).map((r) => r.id));
        imported += ok.size;
        duplicates += chunk.length - ok.size;
        for (const id of ok) moves.push({ variantId, codeId: id, type: "IMPORT", qtyDelta: 1 });
      }
      await addMovements(tx, moves, c.actor.id, now);
      // code_count / duplicate_count are final facts of this batch: set once via duplicate_count column grant; count via insert order.
      await tx.execute(sql`update inventory_batches set duplicate_count = ${duplicates} where id = ${batchId}`);
      await recordAudit(tx, { actor: c.actor, action: "inventory.codes.imported", entity: { type: "inventory_batch", id: batchId }, metadata: { imported, duplicates, invalid, expired: expiredOnImport, payloadKind: input.payloadKind, batchExpiresAt: input.expiresAt ? iso(input.expiresAt) : null }, occurredAt: now });
      return { batchId, imported, duplicates, invalid, expired: expiredOnImport };
    });
  } catch (e) {
    return translate(e);
  }
}

/** Void / quarantine / release-from-quarantine a single code. Mandatory reason; audited; movement recorded. */
export async function setCodeStatus(c: InventoryAdminContext, codeId: string, to: CodeStatus, reason: string): Promise<void> {
  await c.authorize("inventory.codes.manage");
  if (reason.trim().length < 5) throw new DomainError("INVENTORY_INVALID", "a reason is required");
  try {
    await withTransaction(c.db, async (tx) => {
      const cur = first<{ status: CodeStatus; variant_id: string }>(await tx.execute(sql`select status, variant_id from digital_codes where id = ${codeId} for update`));
      if (!cur) throw new DomainError("INVENTORY_NOT_FOUND", "code not found");
      if (!ADMIN_CODE_TRANSITIONS[cur.status]?.includes(to)) throw new DomainError("INVENTORY_INVALID", `cannot move a code from ${cur.status} to ${to}`);
      const now = c.clock.now();
      await tx.execute(sql`update digital_codes set status = ${to}, updated_at = ${iso(now)}::timestamptz where id = ${codeId}`);
      const wasAvailable = cur.status === "AVAILABLE", toAvailable = to === "AVAILABLE";
      const type = to === "VOID" ? "VOID" : to === "QUARANTINED" ? "QUARANTINE" : "UNQUARANTINE";
      await addMovements(tx, [{ variantId: cur.variant_id, codeId, type, qtyDelta: wasAvailable ? -1 : toAvailable ? 1 : 0, reason: reason.trim() }], c.actor.id, now);
      await recordAudit(tx, { actor: c.actor, action: "inventory.code.status_changed", entity: { type: "digital_code", id: codeId }, before: { status: cur.status }, after: { status: to }, metadata: { reason: reason.trim() }, occurredAt: now });
    });
  } catch (e) {
    translate(e);
  }
}

/** Adjust manually managed (counted, MANUAL-fulfilment) stock. Never below zero; reason mandatory; audited. */
export async function adjustStock(c: InventoryAdminContext, variantId: string, delta: number, reason: string): Promise<{ available: number }> {
  await c.authorize("inventory.stock.adjust");
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100_000) throw new DomainError("INVENTORY_INVALID", "delta must be a non-zero integer (|delta| <= 100000)");
  if (reason.trim().length < 5) throw new DomainError("INVENTORY_INVALID", "a reason is required");
  const v = await getVariantSnapshot(c.db, variantId);
  if (!v) throw new DomainError("CATALOG_NOT_FOUND", "variant not found");
  if (v.fulfillmentMethod !== "MANUAL") throw new DomainError("INVENTORY_INVALID", "only MANUAL variants have counted stock");
  try {
    return await withTransaction(c.db, async (tx: Tx) => {
      const now = c.clock.now();
      // Two steps on purpose: PostgreSQL checks the CHECK constraint on the proposed INSERT tuple BEFORE it resolves ON CONFLICT, so a single upsert with a
      // negative delta could never succeed. The UPDATE below enforces `available >= 0` on the real result (a shortfall rolls the whole transaction back).
      await tx.execute(sql`insert into stock_counters (variant_id, available, reserved, updated_at) values (${variantId}, 0, 0, ${iso(now)}::timestamptz) on conflict (variant_id) do nothing`);
      const r = first<{ available: number }>(
        await tx.execute(sql`update stock_counters set available = available + ${delta}, updated_at = ${iso(now)}::timestamptz where variant_id = ${variantId} returning available`),
      )!;
      await addMovements(tx, [{ variantId, type: "ADJUST", qtyDelta: delta, reason: reason.trim() }], c.actor.id, now);
      await recordAudit(tx, { actor: c.actor, action: "inventory.stock.adjusted", entity: { type: "stock_counter", id: variantId }, after: { delta, available: r.available }, metadata: { reason: reason.trim() }, occurredAt: now });
      return { available: r.available };
    });
  } catch (e) {
    return translate(e);
  }
}

/** Stock levels for admins. Counts only — never code values. */
export async function getStock(c: InventoryAdminContext, variantIds: readonly string[]): Promise<Availability[]> {
  await c.authorize("inventory.stock.read");
  return availability(c.db, variantIds, c.clock.now());
}

export interface ExpiryRun { expired: number; byVariant: Record<string, number> }

/**
 * OPS-2 sweeper: mark stock whose supplier expiry has passed as EXPIRED (non-sellable, terminal). Safe to run from many workers at once:
 * rows are taken with FOR UPDATE SKIP LOCKED, and the set it touches (expires_at <= now) is disjoint from what a reservation may take
 * (expires_at > the reservation's end), so it never contends with checkout. Only AVAILABLE/QUARANTINED codes are expired — a RESERVED code is
 * protected by the database guard (its expiry is after the reservation ends) and a SOLD code is never touched (its expiry is information for the customer).
 * Every code gets an append-only movement (CODE_EXPIRE) and the run is audited; nothing is deleted and the stock arithmetic stays exact.
 */
export async function expireDueCodes(db: Database, clock: Clock, opts: { batchSize?: number; actor?: AuditActor } = {}): Promise<ExpiryRun> {
  const batch = Math.min(Math.max(opts.batchSize ?? 500, 1), 1000);
  const actor: AuditActor = opts.actor ?? { type: "SYSTEM", id: "worker:inventory-expiry" };
  return withTransaction(db, async (tx) => {
    const now = clock.now();
    const rows = (
      await tx.execute(
        sql`select id, variant_id, status from digital_codes
             where status in ('AVAILABLE','QUARANTINED') and expires_at is not null and expires_at <= ${iso(now)}::timestamptz
             order by expires_at, id limit ${batch} for update skip locked`,
      )
    ).rows as { id: string; variant_id: string; status: string }[];
    if (rows.length === 0) return { expired: 0, byVariant: {} };
    await setTransitionContext(tx, { actorId: actor.id, reason: "supplier expiry reached" });
    await tx.execute(sql`update digital_codes set status = 'EXPIRED', updated_at = ${iso(now)}::timestamptz where id in (${sql.join(rows.map((r) => sql`${r.id}::uuid`), sql`, `)})`);
    await addMovements(tx, rows.map((r) => ({ variantId: r.variant_id, codeId: r.id, type: "CODE_EXPIRE", qtyDelta: r.status === "AVAILABLE" ? -1 : 0, reason: "supplier expiry reached" })), actor.id, now);
    const byVariant: Record<string, number> = {};
    for (const r of rows) byVariant[r.variant_id] = (byVariant[r.variant_id] ?? 0) + 1;
    await recordAudit(tx, { actor, action: "inventory.codes.expired", entity: { type: "inventory_expiry_run", id: uuidv7(clock) }, metadata: { expired: rows.length, byVariant }, occurredAt: now });
    return { expired: rows.length, byVariant };
  });
}

/** Admin-triggered run of the same sweeper (needs inventory.codes.manage; the run is attributed to the administrator). */
export async function runCodeExpiry(c: InventoryAdminContext, opts: { batchSize?: number } = {}): Promise<ExpiryRun> {
  await c.authorize("inventory.codes.manage");
  return expireDueCodes(c.db, c.clock, { ...opts, actor: c.actor });
}

/** C-2 usage probe: open reservations and stock that depend on the variant's current fulfilment method. Read-only. */
export const inventoryVariantUsage: VariantUsageProbe = async (tx, variantId) => {
  const r = first<{ reservations: number; codes: number; counted: number }>(
    await tx.execute(
      sql`select (select count(*) from inventory_reservation_lines l join inventory_reservations r on r.id = l.reservation_id
                   where l.variant_id = ${variantId}::uuid and r.status in ('ACTIVE','CONSUMED') and l.sold_at is null)::int as reservations,
                 (select count(*) from digital_codes where variant_id = ${variantId}::uuid and status in ('AVAILABLE','RESERVED','QUARANTINED'))::int as codes,
                 (select coalesce(sum(available + reserved), 0) from stock_counters where variant_id = ${variantId}::uuid)::int as counted`,
    ),
  )!;
  return { source: "inventory", open: { openReservations: r.reservations, unsoldCodes: r.codes, countedStock: r.counted } };
};
