import { sql } from "drizzle-orm";
import { withTransaction } from "@/platform/db";
import type { Tx } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { uuidv7 } from "@/platform/ids";
import { enqueueOutbox } from "@/platform/outbox";
import { conditionalTransition, setTransitionContext } from "@/platform/transitions";
import { toAuditActor } from "../domain/types";
import type { Actor } from "../domain/types";
import { asDate, auditStaff, iso, rows } from "./context";
import type { IdentityContext } from "./context";
import { authorize } from "./rbac-service";
import { revokeAllForUser } from "./session-service";

const MIN_REASON = 10;
const reasonOk = (r: string) => r.trim().length >= MIN_REASON;

interface RequestRow { id: string; target_user_id: string; requested_by: string; status: string; created_at: Date | string; approval_expires_at: Date | string | null }

async function loadForUpdate(tx: Tx, id: string): Promise<RequestRow> {
  const r = rows<RequestRow>(
    await tx.execute(sql`select id, target_user_id, requested_by, status, created_at, approval_expires_at from mfa_recovery_requests where id = ${id} for update`),
  )[0];
  if (!r) throw new DomainError("IDENTITY_NOT_FOUND", "recovery request not found");
  return r;
}

/**
 * MFA recovery is manual, restricted and audited: request -> approve (a DIFFERENT admin, mandatory reason)
 * -> complete. Requester, approver and target must be three distinct people (also enforced by CHECK
 * constraints). Nothing is deleted: the authenticator is marked REPLACED, recovery codes superseded.
 */
export async function requestMfaRecovery(ctx: IdentityContext, actor: Actor, targetUserId: string, reason: string): Promise<{ requestId: string }> {
  await authorize(ctx, actor, "identity.mfa.reset");
  if (!reasonOk(reason)) throw new DomainError("INVALID_ARGUMENT", `a reason of at least ${MIN_REASON} characters is required`);
  if (targetUserId === actor.userId) throw new DomainError("AUTH_FORBIDDEN", "cannot request recovery for yourself");
  const requestId = uuidv7(ctx.clock);
  try {
    await withTransaction(ctx.db, async (tx) => {
      const t = rows<{ kind: string }>(await tx.execute(sql`select kind from users where id = ${targetUserId}`))[0];
      if (!t) throw new DomainError("IDENTITY_NOT_FOUND", "user not found");
      if (t.kind !== "STAFF") throw new DomainError("IDENTITY_CONFLICT", "MFA recovery applies to staff only");
      await setTransitionContext(tx, { actorId: actor.userId, reason: reason.trim() });
      await tx.execute(
        sql`insert into mfa_recovery_requests (id, target_user_id, requested_by, reason, status, created_at)
            values (${requestId}, ${targetUserId}, ${actor.userId}, ${reason.trim()}, 'REQUESTED', ${iso(ctx.clock.now())}::timestamptz)`,
      );
      await auditStaff(tx, ctx, toAuditActor(actor), "identity.mfa_recovery.requested", { type: "mfa_recovery", id: requestId }, { metadata: { reason: reason.trim() } });
    });
  } catch (e) {
    if ((e as { cause?: { code?: string } }).cause?.code === "23505" || (e as { code?: string }).code === "23505") throw new DomainError("IDENTITY_CONFLICT", "an open recovery request already exists for this user");
    throw e;
  }
  return { requestId };
}

/** Lazily expire a stale request (a state change, never a deletion). Returns true if it expired. */
async function expireIfStale(tx: Tx, ctx: IdentityContext, r: RequestRow): Promise<boolean> {
  const now = ctx.clock.now().getTime();
  const limit = ctx.config.mfa.recoveryApprovalSeconds * 1000;
  const stale = r.status === "REQUESTED" ? now - asDate(r.created_at).getTime() > limit : r.status === "APPROVED" && r.approval_expires_at !== null && asDate(r.approval_expires_at).getTime() <= now;
  if (!stale) return false;
  await conditionalTransition(tx, { table: "mfa_recovery_requests", id: r.id, from: r.status, to: "EXPIRED", context: { actorId: "system:identity", reason: "expired" } });
  return true;
}

export async function approveMfaRecovery(ctx: IdentityContext, actor: Actor, requestId: string, reason: string): Promise<void> {
  await authorize(ctx, actor, "identity.mfa.reset");
  if (!reasonOk(reason)) throw new DomainError("INVALID_ARGUMENT", `a reason of at least ${MIN_REASON} characters is required`);
  const expired = await withTransaction(ctx.db, async (tx) => {
    const r = await loadForUpdate(tx, requestId);
    if (r.status !== "REQUESTED") throw new DomainError("MFA_STATE_INVALID", "request is not awaiting approval");
    if (actor.userId === r.requested_by || actor.userId === r.target_user_id) throw new DomainError("AUTH_FORBIDDEN", "an independent second administrator must approve");
    if (await expireIfStale(tx, ctx, r)) return true;
    const now = ctx.clock.now();
    await setTransitionContext(tx, { actorId: actor.userId, reason: reason.trim() });
    await tx.execute(
      sql`update mfa_recovery_requests set status = 'APPROVED', approved_by = ${actor.userId}, approval_reason = ${reason.trim()},
             approved_at = ${iso(now)}::timestamptz, approval_expires_at = ${iso(new Date(now.getTime() + ctx.config.mfa.recoveryApprovalSeconds * 1000))}::timestamptz
           where id = ${requestId} and status = 'REQUESTED'`,
    );
    await auditStaff(tx, ctx, toAuditActor(actor), "identity.mfa_recovery.approved", { type: "mfa_recovery", id: requestId }, { metadata: { reason: reason.trim() } });
    return false;
  });
  if (expired) throw new DomainError("MFA_STATE_INVALID", "request has expired");
}

export async function rejectMfaRecovery(ctx: IdentityContext, actor: Actor, requestId: string, reason: string): Promise<void> {
  await authorize(ctx, actor, "identity.mfa.reset");
  if (!reasonOk(reason)) throw new DomainError("INVALID_ARGUMENT", `a reason of at least ${MIN_REASON} characters is required`);
  await withTransaction(ctx.db, async (tx) => {
    const r = await loadForUpdate(tx, requestId);
    if (r.status !== "REQUESTED" && r.status !== "APPROVED") throw new DomainError("MFA_STATE_INVALID", "request is already closed");
    if (actor.userId === r.target_user_id) throw new DomainError("AUTH_FORBIDDEN", "the target cannot decide their own request");
    await conditionalTransition(tx, { table: "mfa_recovery_requests", id: requestId, from: r.status, to: "REJECTED", context: { actorId: actor.userId, reason: reason.trim() } });
    await auditStaff(tx, ctx, toAuditActor(actor), "identity.mfa_recovery.rejected", { type: "mfa_recovery", id: requestId }, { metadata: { reason: reason.trim() } });
  });
}

/** Apply an APPROVED request: retire the authenticator + unused recovery codes, revoke every session of the target. */
export async function completeMfaRecovery(ctx: IdentityContext, actor: Actor, requestId: string): Promise<void> {
  await authorize(ctx, actor, "identity.mfa.reset");
  const expired = await withTransaction(ctx.db, async (tx) => {
    const r = await loadForUpdate(tx, requestId);
    if (r.status !== "APPROVED") throw new DomainError("MFA_STATE_INVALID", "request is not approved");
    if (actor.userId === r.target_user_id) throw new DomainError("AUTH_FORBIDDEN", "the target cannot complete their own recovery");
    if (await expireIfStale(tx, ctx, r)) return true;
    const now = iso(ctx.clock.now());
    await setTransitionContext(tx, { actorId: actor.userId, reason: "mfa recovery completed" });
    await tx.execute(sql`update mfa_recovery_requests set status = 'COMPLETED', completed_by = ${actor.userId}, completed_at = ${now}::timestamptz where id = ${requestId} and status = 'APPROVED'`);
    await tx.execute(sql`update admin_totp set status = 'REPLACED', replaced_at = ${now}::timestamptz where user_id = ${r.target_user_id} and status in ('ACTIVE','PENDING')`);
    await tx.execute(sql`update admin_recovery_codes set superseded_at = ${now}::timestamptz where user_id = ${r.target_user_id} and used_at is null and superseded_at is null`);
    const revoked = await revokeAllForUser(tx, ctx, r.target_user_id, "MFA_RECOVERY");
    await enqueueOutbox(tx, { eventType: "identity.mfa_recovery.completed", aggregateType: "user", aggregateId: r.target_user_id, payload: { requestId } }, ctx.clock);
    await auditStaff(tx, ctx, toAuditActor(actor), "identity.mfa_recovery.completed", { type: "mfa_recovery", id: requestId }, { metadata: { revokedSessions: revoked } });
    return false;
  });
  if (expired) throw new DomainError("MFA_STATE_INVALID", "approval has expired");
}
