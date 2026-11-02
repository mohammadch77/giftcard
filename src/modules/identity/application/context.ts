import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import type { AuditActor } from "@/modules/audit";
import type { Clock } from "@/platform/clock";
import type { KeyProvider } from "@/platform/crypto";
import type { Database, Tx } from "@/platform/db";
import type { SmsProvider } from "@/platform/sms";
import type { IdentityConfig } from "../domain/config";
import type { PermissionCatalog } from "../domain/permissions";

/** Tiny bounded LRU (Map keeps insertion order). Bounded so a flood of users cannot grow memory. */
export class BoundedCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly max: number) {}
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }
  get size(): number {
    return this.map.size;
  }
}

export interface IdentityContext {
  db: Database;
  clock: Clock;
  keys: KeyProvider;
  sms: SmsProvider;
  config: IdentityConfig;
  catalog: PermissionCatalog;
  /** key `${userId}:${authzVersion}` -> permission keys. A changed authz_version is a different key. */
  permissionCache: BoundedCache<string, ReadonlySet<string>>;
  issuer: string;
}

export const sha256hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
export const iso = (d: Date): string => d.toISOString();

/** Advisory transaction lock on a logical key (serialises e.g. first-signup for one phone). */
export async function lockKey(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export function auditStaff(tx: Tx, ctx: IdentityContext, actor: AuditActor, action: string, entity: { type: string; id: string }, extra: { before?: unknown; after?: unknown; metadata?: unknown } = {}): Promise<number> {
  return recordAudit(tx, { actor, action, entity, ...extra, occurredAt: ctx.clock.now() });
}

/** Drizzle's raw `execute` returns timestamptz as text ("2026-06-01 10:00:00.123456+00"); normalise to Date. */
export function asDate(v: Date | string): Date;
export function asDate(v: Date | string | null): Date | null;
export function asDate(v: Date | string | null): Date | null {
  if (v === null) return null;
  if (v instanceof Date) return v;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(v);
  if (!m) throw new Error("unparseable timestamp");
  const frac = (m[3] ?? ".000").slice(0, 4).padEnd(4, "0");
  let tz = m[4] ?? "Z";
  if (/^[+-]\d{2}$/.test(tz)) tz += ":00";
  else if (/^[+-]\d{4}$/.test(tz)) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`;
  return new Date(`${m[1]}T${m[2]}${frac}${tz}`);
}

export function rows<T>(result: { rows: unknown[] }): T[] {
  return result.rows as T[];
}
