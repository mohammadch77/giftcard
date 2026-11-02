import { sql } from "drizzle-orm";
import type { Database, Tx } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { redact } from "@/platform/logging";
import type { AuditEntry, AuditRecord } from "../domain/types";

const ACTION_RE = /^[a-z][a-z0-9_.]{1,79}$/;
const ENTITY_TYPE_RE = /^[a-z][a-z0-9_]{1,63}$/;
const ACTOR_TYPES = new Set(["USER", "ADMIN", "SYSTEM", "WORKER"]);
const MAX_JSON_BYTES = 64 * 1024;

function sanitize(value: unknown, what: string): string | null {
  if (value === undefined) return null;
  const cleaned = redact(value); // sensitive keys / token-like strings are removed before storage
  const json = JSON.stringify(cleaned);
  if (json === undefined) return null;
  if (Buffer.byteLength(json, "utf8") > MAX_JSON_BYTES) {
    throw new DomainError("AUDIT_INVALID", `${what} is too large for an audit record`);
  }
  return json;
}

/**
 * Append one audit record INSIDE the caller's transaction (so the record commits or rolls back with the
 * audited change). Returns the audit id. The table is append-only at the database level.
 */
export async function recordAudit(tx: Tx, entry: AuditEntry): Promise<number> {
  if (!ACTOR_TYPES.has(entry.actor.type) || entry.actor.id.length < 1 || entry.actor.id.length > 200) {
    throw new DomainError("AUDIT_INVALID", "invalid audit actor");
  }
  if (!ACTION_RE.test(entry.action)) throw new DomainError("AUDIT_INVALID", "invalid audit action");
  if (!ENTITY_TYPE_RE.test(entry.entity.type) || entry.entity.id.length < 1 || entry.entity.id.length > 200) {
    throw new DomainError("AUDIT_INVALID", "invalid audit entity");
  }
  const before = sanitize(entry.before, "before");
  const after = sanitize(entry.after, "after");
  const metadata = sanitize(entry.metadata, "metadata");

  const result = await tx.execute(
    sql`insert into audit_logs (occurred_at, actor_type, actor_id, action, entity_type, entity_id, request_id, before, after, metadata)
        values (${entry.occurredAt.toISOString()}::timestamptz, ${entry.actor.type}, ${entry.actor.id}, ${entry.action},
                ${entry.entity.type}, ${entry.entity.id}, ${entry.requestId ?? null},
                ${before}::jsonb, ${after}::jsonb, ${metadata}::jsonb)
        returning id`,
  );
  return Number((result.rows[0] as { id: string | number }).id);
}

export interface AuditQuery {
  entityType?: string;
  entityId?: string;
  actorId?: string;
  action?: string;
  limit?: number;
}

/** Read audit records (newest last). Intended for admin views and tests. */
export async function listAudit(db: Database | Tx, q: AuditQuery = {}): Promise<AuditRecord[]> {
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
  const result = await db.execute(
    sql`select id, occurred_at, actor_type, actor_id, action, entity_type, entity_id, request_id, before, after, metadata
          from audit_logs
         where (${q.entityType ?? null}::text is null or entity_type = ${q.entityType ?? null})
           and (${q.entityId ?? null}::text is null or entity_id = ${q.entityId ?? null})
           and (${q.actorId ?? null}::text is null or actor_id = ${q.actorId ?? null})
           and (${q.action ?? null}::text is null or action = ${q.action ?? null})
         order by id desc limit ${limit}`,
  );
  return (result.rows as Record<string, unknown>[])
    .map((r) => ({
      id: Number(r.id),
      occurredAt: new Date(r.occurred_at as string | Date),
      actorType: r.actor_type as AuditRecord["actorType"],
      actorId: r.actor_id as string,
      action: r.action as string,
      entityType: r.entity_type as string,
      entityId: r.entity_id as string,
      requestId: (r.request_id as string | null) ?? null,
      before: r.before,
      after: r.after,
      metadata: r.metadata,
    }))
    .reverse();
}
