import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/modules/audit";
import type { AuditActor } from "@/modules/audit";
import type { Clock } from "@/platform/clock";
import type { Database, Tx } from "@/platform/db";
import { withTransaction } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { uuidv7 } from "@/platform/ids";
import { parseSetting, requireReason } from "@/platform/settings";
import type { SettingVersion } from "@/platform/settings";

/**
 * WALLET LIMITS (ADM-1, B5) — owned by the wallet module. Typed, versioned, TWO-PERSON (financial setting):
 *   a change is REQUESTED by one administrator and APPROVED/REJECTED by a different one (also a DB CHECK that cannot be configured away).
 *   Only APPROVED versions have effect; the active one is the highest approved_seq. Integer Rial only; min <= max per top-up <= daily maximum.
 *   Bounds are enforced here AND in the database. A request made against an older active version is stale and cannot be approved.
 *   Changes affect only top-ups started AFTER approval: each top-up records the limits version it was validated against and is never re-validated.
 *   Fail closed: with no readable approved version, top-ups are refused (WALLET_LIMITS_NOT_CONFIGURED).
 * The daily window (Asia/Tehran calendar day) is a fixed business rule, not a setting.
 */
export const TOPUP_LIMIT_BOUNDS = { minFloorRial: 10, maxCeilingRial: 1_000_000_000_000, dailyCeilingRial: 10_000_000_000_000 } as const;
export const TOPUP_DAILY_TIMEZONE = "Asia/Tehran" as const;

const rialField = (ceiling: number) => z.number().int().min(TOPUP_LIMIT_BOUNDS.minFloorRial).max(ceiling).multipleOf(10);
const limitsSchema = z
  .strictObject({ minRial: rialField(TOPUP_LIMIT_BOUNDS.maxCeilingRial), maxRial: rialField(TOPUP_LIMIT_BOUNDS.maxCeilingRial), dailyMaxRial: rialField(TOPUP_LIMIT_BOUNDS.dailyCeilingRial) })
  .refine((v) => v.minRial <= v.maxRial && v.maxRial <= v.dailyMaxRial, { message: "limits must satisfy minimum <= maximum per top-up <= daily maximum" });
export type TopUpLimitValues = z.infer<typeof limitsSchema>;
export type TopUpLimits = SettingVersion<TopUpLimitValues>;

interface Row { id: string; min_rial: string | number; max_rial: string | number; daily_max_rial: string | number; source: "SEED" | "ADMIN"; approved_seq: number }
const notConfigured = (): DomainError => new DomainError("WALLET_LIMITS_NOT_CONFIGURED", "wallet top-up limits are not configured (setting B5)");

/** The ACTIVE top-up limits. Pass a transaction to read them consistently with the rest of the top-up. */
export async function getTopUpLimits(db: Database | Tx): Promise<TopUpLimits> {
  const r = (await db.execute(sql`select id, min_rial, max_rial, daily_max_rial, source, approved_seq from wallet_limit_versions where status = 'APPROVED' order by approved_seq desc limit 1`)).rows[0] as Row | undefined;
  if (!r) throw notConfigured();
  const parsed = limitsSchema.safeParse({ minRial: Number(r.min_rial), maxRial: Number(r.max_rial), dailyMaxRial: Number(r.daily_max_rial) });
  if (!parsed.success) throw notConfigured(); // stored values that violate the bounds are never used
  return { version: r.approved_seq, values: parsed.data, source: r.source };
}

export interface WalletSettingsAdmin { db: Database; clock: Clock; actor: AuditActor; authorize(permission: string): Promise<void> }

export async function getTopUpLimitsAdmin(c: Pick<WalletSettingsAdmin, "db" | "authorize">): Promise<TopUpLimits> {
  await c.authorize("wallet.settings.read");
  return getTopUpLimits(c.db);
}

const LOCK = sql`select pg_advisory_xact_lock(hashtextextended('wallet_limit_versions', 0))`;

/** Request new limits (does NOT change anything until a DIFFERENT administrator approves). */
export async function requestLimitChange(c: WalletSettingsAdmin, input: { minRial: number; maxRial: number; dailyMaxRial: number; reason: string }): Promise<{ requestId: string; baseVersion: number }> {
  await c.authorize("wallet.settings.request");
  const values = parseSetting(limitsSchema, { minRial: input.minRial, maxRial: input.maxRial, dailyMaxRial: input.dailyMaxRial });
  const reason = requireReason(input.reason);
  return withTransaction(c.db, async (tx) => {
    await tx.execute(LOCK);
    const cur = await getTopUpLimits(tx);
    if (cur.values.minRial === values.minRial && cur.values.maxRial === values.maxRial && cur.values.dailyMaxRial === values.dailyMaxRial) throw new DomainError("SETTINGS_INVALID", "the requested limits equal the active limits");
    const id = uuidv7(c.clock);
    await tx.execute(sql`insert into wallet_limit_versions (id, min_rial, max_rial, daily_max_rial, source, status, base_seq, requested_by, reason, created_at)
      values (${id}, ${values.minRial}, ${values.maxRial}, ${values.dailyMaxRial}, 'ADMIN', 'REQUESTED', ${cur.version}, ${c.actor.id}, ${reason}, ${c.clock.now().toISOString()}::timestamptz)`);
    await recordAudit(tx, {
      actor: c.actor, action: "wallet.settings.limits_requested", entity: { type: "wallet_limit_version", id },
      before: { version: cur.version, ...cur.values }, after: { ...values }, metadata: { reason, baseVersion: cur.version }, occurredAt: c.clock.now(),
    });
    return { requestId: id, baseVersion: cur.version };
  });
}

/** Approve (activates a new version) or reject a request. The decider must be a different administrator than the requester. */
export async function decideLimitChange(c: WalletSettingsAdmin, requestId: string, decision: { approve: boolean; reason: string }): Promise<{ status: "APPROVED" | "REJECTED"; version?: number }> {
  await c.authorize("wallet.settings.approve");
  const reason = requireReason(decision.reason);
  return withTransaction(c.db, async (tx) => {
    await tx.execute(LOCK);
    const r = (await tx.execute(sql`select id, min_rial, max_rial, daily_max_rial, status, base_seq, requested_by from wallet_limit_versions where id = ${requestId} for update`)).rows[0] as
      | { id: string; min_rial: string | number; max_rial: string | number; daily_max_rial: string | number; status: string; base_seq: number | null; requested_by: string }
      | undefined;
    if (!r) throw new DomainError("WALLET_NOT_FOUND", "limit request not found");
    if (r.status !== "REQUESTED") throw new DomainError("SETTINGS_INVALID", "this limit request was already decided");
    if (r.requested_by === c.actor.id) throw new DomainError("SETTINGS_INVALID", "a second administrator must decide this request (two-person rule)");
    const cur = await getTopUpLimits(tx);
    const at = c.clock.now().toISOString();
    const next = { minRial: Number(r.min_rial), maxRial: Number(r.max_rial), dailyMaxRial: Number(r.daily_max_rial) };
    if (!decision.approve) {
      await tx.execute(sql`update wallet_limit_versions set status = 'REJECTED', decided_by = ${c.actor.id}, decision_reason = ${reason}, decided_at = ${at}::timestamptz where id = ${requestId}`);
      await recordAudit(tx, { actor: c.actor, action: "wallet.settings.limits_rejected", entity: { type: "wallet_limit_version", id: requestId }, before: { version: cur.version, ...cur.values }, after: next, metadata: { reason }, occurredAt: c.clock.now() });
      return { status: "REJECTED" as const };
    }
    if (r.base_seq !== cur.version) throw new DomainError("SETTINGS_STALE", "the active limits changed since this request was made; request again");
    const version = cur.version + 1;
    await tx.execute(sql`update wallet_limit_versions set status = 'APPROVED', approved_seq = ${version}, decided_by = ${c.actor.id}, decision_reason = ${reason}, decided_at = ${at}::timestamptz where id = ${requestId}`);
    await recordAudit(tx, { actor: c.actor, action: "wallet.settings.limits_approved", entity: { type: "wallet_limit_version", id: requestId }, before: { version: cur.version, ...cur.values }, after: { version, ...next }, metadata: { reason }, occurredAt: c.clock.now() });
    return { status: "APPROVED" as const, version };
  });
}

/**
 * Sum of the user's top-ups that count against the daily limit inside the Asia/Tehran calendar day containing `now`: REQUESTED (in flight) and
 * COMPLETED ones, counted on the day they were STARTED; FAILED ones free their allowance. Must be called under the per-user top-up lock.
 */
export async function dailyTopUpTotal(tx: Tx, userId: string, now: Date): Promise<number> {
  const at = now.toISOString();
  const r = await tx.execute(sql`select coalesce(sum(amount), 0) as used from wallet_topups
    where user_ref = ${userId} and status in ('REQUESTED', 'COMPLETED')
      and created_at >= date_trunc('day', ${at}::timestamptz, ${TOPUP_DAILY_TIMEZONE})
      and created_at <  date_trunc('day', ${at}::timestamptz, ${TOPUP_DAILY_TIMEZONE}) + interval '24 hours'`);
  return Number((r.rows[0] as { used: string | number }).used);
}

/** Start and end (exclusive) of the Asia/Tehran calendar day containing `now`. */
export async function tehranDayWindow(db: Database | Tx, now: Date): Promise<{ start: Date; end: Date }> {
  const at = now.toISOString();
  const r = (await db.execute(sql`select extract(epoch from date_trunc('day', ${at}::timestamptz, ${TOPUP_DAILY_TIMEZONE}))::bigint as s,
    extract(epoch from date_trunc('day', ${at}::timestamptz, ${TOPUP_DAILY_TIMEZONE}) + interval '24 hours')::bigint as e`)).rows[0] as { s: string | number; e: string | number };
  return { start: new Date(Number(r.s) * 1000), end: new Date(Number(r.e) * 1000) };
}
