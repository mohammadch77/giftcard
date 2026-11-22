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
 * ORDER SETTINGS (ADM-1, B3) — owned by the orders module. A typed, append-only version table; one column per setting.
 *  - reservation TTL: 60–3600 s (bounds enforced here AND by a DB CHECK), initial value 900 s (owner-approved B3, version 1 by migration).
 *  - A change is a NEW version (actor, reason, previous → new, audit in the SAME transaction). It affects only FUTURE checkouts: an order
 *    stores the TTL it used in its policy snapshot and a reservation's expiry is fixed at creation (D9) — nothing existing is touched.
 *  - Fail closed: if no valid version can be read, checkout is refused (ORDER_RESERVATION_TTL_NOT_CONFIGURED).
 * Not financial => one administrator with the sensitive (step-up) permission `orders.settings.manage`.
 */
export const RESERVATION_TTL_BOUNDS = { min: 60, max: 3600 } as const;

const ttlSchema = z.strictObject({ reservationTtlSeconds: z.number().int().min(RESERVATION_TTL_BOUNDS.min).max(RESERVATION_TTL_BOUNDS.max) });
export type OrderSettingValues = z.infer<typeof ttlSchema>;
export type OrderSettings = SettingVersion<OrderSettingValues>;

interface Row { version: number; reservation_ttl_seconds: number; source: "SEED" | "ADMIN" }
const notConfigured = (): DomainError => new DomainError("ORDER_RESERVATION_TTL_NOT_CONFIGURED", "the checkout reservation hold is not configured (setting B3)");

/** The ACTIVE order settings (highest version). Pass a transaction to read them consistently with the rest of checkout. */
export async function getOrderSettings(db: Database | Tx): Promise<OrderSettings> {
  const r = (await db.execute(sql`select version, reservation_ttl_seconds, source from order_settings_versions order by version desc limit 1`)).rows[0] as Row | undefined;
  if (!r) throw notConfigured();
  const parsed = ttlSchema.safeParse({ reservationTtlSeconds: r.reservation_ttl_seconds });
  if (!parsed.success) throw notConfigured(); // a stored value outside the bounds is never used
  return { version: r.version, values: parsed.data, source: r.source };
}

export interface OrderSettingsAdmin { db: Database; clock: Clock; actor: AuditActor; authorize(permission: string): Promise<void> }

export async function getOrderSettingsAdmin(c: Pick<OrderSettingsAdmin, "db" | "authorize">): Promise<OrderSettings> {
  await c.authorize("orders.settings.read");
  return getOrderSettings(c.db);
}

/** Change the reservation TTL. Audited with old and new value in the same transaction; affects future checkouts only. */
export async function setReservationTtl(c: OrderSettingsAdmin, input: { reservationTtlSeconds: number; reason: string }): Promise<{ version: number; previousVersion: number }> {
  await c.authorize("orders.settings.manage");
  const values = parseSetting(ttlSchema, { reservationTtlSeconds: input.reservationTtlSeconds });
  const reason = requireReason(input.reason);
  return withTransaction(c.db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('order_settings_versions', 0))`); // serialises version numbering
    const cur = await getOrderSettings(tx);
    if (cur.values.reservationTtlSeconds === values.reservationTtlSeconds) throw new DomainError("SETTINGS_INVALID", "the reservation TTL already has this value");
    const version = cur.version + 1;
    const id = uuidv7(c.clock);
    await tx.execute(sql`insert into order_settings_versions (id, version, reservation_ttl_seconds, source, previous_version, changed_by, reason, created_at)
      values (${id}, ${version}, ${values.reservationTtlSeconds}, 'ADMIN', ${cur.version}, ${c.actor.id}, ${reason}, ${c.clock.now().toISOString()}::timestamptz)`);
    await recordAudit(tx, {
      actor: c.actor, action: "orders.settings.reservation_ttl_changed", entity: { type: "order_settings", id },
      before: { version: cur.version, reservationTtlSeconds: cur.values.reservationTtlSeconds }, after: { version, reservationTtlSeconds: values.reservationTtlSeconds },
      metadata: { reason }, occurredAt: c.clock.now(),
    });
    return { version, previousVersion: cur.version };
  });
}

// ------------------------------------------------------------------ refund approval thresholds (B10)

export const REFUND_THRESHOLD_BOUNDS = { minFloorRial: 0, maxCeilingRial: 1_000_000_000_000 } as const;

const refundThresholdSchema = z.strictObject({
  requiresTier2AboveRial: z.number().int().min(REFUND_THRESHOLD_BOUNDS.minFloorRial).max(REFUND_THRESHOLD_BOUNDS.maxCeilingRial).multipleOf(10),
  autoApprovalAllowed: z.literal(false).default(false),
});
export type RefundThresholdValues = z.infer<typeof refundThresholdSchema>;
export type RefundThresholds = SettingVersion<RefundThresholdValues>;

interface RefundThresholdRow { id: string; requires_tier2_above_rial: string | number; auto_approval_allowed: boolean; source: "SEED" | "ADMIN"; approved_seq: number }
const refundThresholdNotConfigured = (): DomainError => new DomainError("REFUND_THRESHOLDS_NOT_CONFIGURED", "refund approval thresholds are not configured (setting B10)");

/** The ACTIVE refund approval thresholds. Pass a transaction to read them consistently with refund evaluation. */
export async function getRefundThresholds(db: Database | Tx): Promise<RefundThresholds> {
  const r = (await db.execute(sql`select id, requires_tier2_above_rial, auto_approval_allowed, source, approved_seq from refund_threshold_versions where status = 'APPROVED' order by approved_seq desc limit 1`)).rows[0] as RefundThresholdRow | undefined;
  if (!r) throw refundThresholdNotConfigured();
  const parsed = refundThresholdSchema.safeParse({ requiresTier2AboveRial: Number(r.requires_tier2_above_rial), autoApprovalAllowed: r.auto_approval_allowed });
  if (!parsed.success) throw refundThresholdNotConfigured();
  return { version: r.approved_seq, values: parsed.data, source: r.source };
}

export async function getRefundThresholdsAdmin(c: Pick<OrderSettingsAdmin, "db" | "authorize">): Promise<RefundThresholds> {
  await c.authorize("orders.settings.thresholds.read");
  return getRefundThresholds(c.db);
}

const REFUND_THRESHOLD_LOCK = sql`select pg_advisory_xact_lock(hashtextextended('refund_threshold_versions', 0))`;

/** Request new refund approval thresholds (does NOT change anything until a DIFFERENT administrator approves). */
export async function requestRefundThresholdChange(c: OrderSettingsAdmin, input: { requiresTier2AboveRial: number; reason: string }): Promise<{ requestId: string; baseVersion: number }> {
  await c.authorize("orders.settings.thresholds.request");
  const values = parseSetting(refundThresholdSchema, { requiresTier2AboveRial: input.requiresTier2AboveRial, autoApprovalAllowed: false });
  const reason = requireReason(input.reason);
  return withTransaction(c.db, async (tx) => {
    await tx.execute(REFUND_THRESHOLD_LOCK);
    const cur = await getRefundThresholds(tx);
    if (cur.values.requiresTier2AboveRial === values.requiresTier2AboveRial) throw new DomainError("SETTINGS_INVALID", "the requested threshold equals the active threshold");
    const id = uuidv7(c.clock);
    await tx.execute(sql`insert into refund_threshold_versions (id, requires_tier2_above_rial, auto_approval_allowed, source, status, base_seq, requested_by, reason, created_at)
      values (${id}, ${values.requiresTier2AboveRial}, false, 'ADMIN', 'REQUESTED', ${cur.version}, ${c.actor.id}, ${reason}, ${c.clock.now().toISOString()}::timestamptz)`);
    await recordAudit(tx, {
      actor: c.actor, action: "orders.settings.thresholds_requested", entity: { type: "refund_threshold_version", id },
      before: { version: cur.version, ...cur.values }, after: { ...values }, metadata: { reason, baseVersion: cur.version }, occurredAt: c.clock.now(),
    });
    return { requestId: id, baseVersion: cur.version };
  });
}

/** Approve (activates a new version) or reject a request. The decider must be a different administrator than the requester. */
export async function decideRefundThresholdChange(c: OrderSettingsAdmin, requestId: string, decision: { approve: boolean; reason: string }): Promise<{ status: "APPROVED" | "REJECTED"; version?: number }> {
  await c.authorize("orders.settings.thresholds.approve");
  const reason = requireReason(decision.reason);
  return withTransaction(c.db, async (tx) => {
    await tx.execute(REFUND_THRESHOLD_LOCK);
    const r = (await tx.execute(sql`select id, requires_tier2_above_rial, auto_approval_allowed, status, base_seq, requested_by from refund_threshold_versions where id = ${requestId} for update`)).rows[0] as
      | { id: string; requires_tier2_above_rial: string | number; auto_approval_allowed: boolean; status: string; base_seq: number | null; requested_by: string }
      | undefined;
    if (!r) throw new DomainError("REFUND_NOT_FOUND", "threshold request not found");
    if (r.status !== "REQUESTED") throw new DomainError("SETTINGS_INVALID", "this threshold request was already decided");
    if (r.requested_by === c.actor.id) throw new DomainError("SETTINGS_INVALID", "a second administrator must decide this request (two-person rule)");
    const cur = await getRefundThresholds(tx);
    const at = c.clock.now().toISOString();
    const next = { requiresTier2AboveRial: Number(r.requires_tier2_above_rial), autoApprovalAllowed: false };
    if (!decision.approve) {
      await tx.execute(sql`update refund_threshold_versions set status = 'REJECTED', decided_by = ${c.actor.id}, decision_reason = ${reason}, decided_at = ${at}::timestamptz where id = ${requestId}`);
      await recordAudit(tx, { actor: c.actor, action: "orders.settings.thresholds_rejected", entity: { type: "refund_threshold_version", id: requestId }, before: { version: cur.version, ...cur.values }, after: next, metadata: { reason }, occurredAt: c.clock.now() });
      return { status: "REJECTED" as const };
    }
    if (r.base_seq !== cur.version) throw new DomainError("SETTINGS_STALE", "the active threshold changed since this request was made; request again");
    const version = cur.version + 1;
    await tx.execute(sql`update refund_threshold_versions set status = 'APPROVED', approved_seq = ${version}, decided_by = ${c.actor.id}, decision_reason = ${reason}, decided_at = ${at}::timestamptz where id = ${requestId}`);
    await recordAudit(tx, { actor: c.actor, action: "orders.settings.thresholds_approved", entity: { type: "refund_threshold_version", id: requestId }, before: { version: cur.version, ...cur.values }, after: { version, ...next }, metadata: { reason }, occurredAt: c.clock.now() });
    return { status: "APPROVED" as const, version };
  });
}
