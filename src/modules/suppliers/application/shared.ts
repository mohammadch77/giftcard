import { sql } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import type { AuditActor } from "@/modules/audit";
import type { Clock } from "@/platform/clock";
import type { KeyProvider } from "@/platform/crypto";
import { decodeSealed, openSecret } from "@/platform/crypto";
import type { Database, Tx } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { redact } from "@/platform/logging";
import type { SupplierAdapterRegistry, SupplierCredentials } from "@/platform/supplier-adapter";
import { credentialsSchema } from "../domain/rules";

export type Ts = Date | string;
export const iso = (d: Date): string => d.toISOString();
export const first = <T>(r: { rows: unknown[] }): T | undefined => r.rows[0] as T | undefined;
export const toDate = (v: Ts): Date => (v instanceof Date ? v : new Date(v.replace(" ", "T").replace(/(\.\d{3})\d*/, "$1").replace(/([+-]\d{2})$/, "$1:00")));
export const SYSTEM: AuditActor = { type: "SYSTEM", id: "system:suppliers" };

export interface SupplierDeps { adapters: SupplierAdapterRegistry; keys: KeyProvider; clock: Clock; submitTimeoutMs?: number; leaseSeconds?: number }

export const credSealCtx = (id: string) => ({ table: "supplier_credentials", rowId: id, kind: "supplier_credential" });
export const secretSealCtx = (id: string) => ({ table: "supplier_order_secrets", rowId: id, kind: "supplier_deliverable" });

/**
 * Decrypt the ACTIVE credentials for the duration of `fn` only (outside any transaction — this may call the KeyProvider).
 * Credentials are never returned, logged or stored in plaintext; the buffer is zeroed afterwards.
 */
export async function withCredentials<T>(db: Database | Tx, keys: KeyProvider, supplierId: string, fn: (c: SupplierCredentials) => Promise<T>): Promise<T> {
  const row = first<{ id: string; sealed: Buffer }>(await db.execute(sql`select id, sealed from supplier_credentials where supplier_id = ${supplierId} and status = 'ACTIVE'`));
  if (!row) throw new DomainError("SUPPLIER_INVALID", "supplier has no credentials");
  const plain = await openSecret(keys, decodeSealed(row.sealed), credSealCtx(row.id));
  try {
    const parsed = credentialsSchema.safeParse(JSON.parse(plain.toString("utf8")));
    if (!parsed.success) throw new DomainError("SUPPLIER_INVALID", "stored credentials are malformed");
    return await fn(Object.freeze({ ...parsed.data }));
  } finally {
    plain.fill(0);
  }
}

export async function addEvent(tx: Tx, orderId: string, type: string, actor: string, now: Date, detail?: unknown): Promise<void> {
  await tx.execute(sql`insert into supplier_order_events (supplier_order_id, type, detail, actor, created_at) values (${orderId}, ${type}, ${detail === undefined ? null : JSON.stringify(redact(detail))}::jsonb, ${actor}, ${iso(now)}::timestamptz)`);
}

export const audit = (tx: Tx, actor: AuditActor, now: Date, action: string, entity: { type: string; id: string }, metadata?: unknown) =>
  recordAudit(tx, { actor, action, entity, ...(metadata === undefined ? {} : { metadata }), occurredAt: now });

/** Classification used for operations logging/metadata: names only, never messages (they may carry payloads). */
export function classifyError(e: unknown): "TIMEOUT" | "NOT_SENT" | "ERROR" {
  const name = (e as { name?: string } | null)?.name;
  if (name === "SupplierTimeout") return "TIMEOUT";
  if (name === "SupplierNotSentError") return "NOT_SENT";
  return "ERROR";
}
