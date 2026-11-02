import { sql } from "drizzle-orm";
import { decodeSealed, encodeSealed, fingerprint, fingerprintsAllVersions, openSecret, sealSecret } from "@/platform/crypto";
import type { Tx } from "@/platform/db";
import { withTransaction } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { uuidv7 } from "@/platform/ids";
import { consumeRateLimit } from "@/platform/ratelimit";
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from "../domain/totp";
import { generateRecoveryCode, normalizeRecoveryCode } from "../domain/tokens";
import { toAuditActor } from "../domain/types";
import type { Actor } from "../domain/types";
import { auditStaff, iso, lockKey, rows } from "./context";
import type { IdentityContext } from "./context";
import { rotateSessionToken } from "./session-service";

const RC_PURPOSE = "mfa.recovery_code";
const sealCtx = (id: string) => ({ table: "admin_totp", rowId: id, kind: "totp_secret" });

function requireStaff(actor: Actor): void {
  if (actor.kind !== "STAFF") throw new DomainError("AUTH_FORBIDDEN", "MFA applies to staff accounts only");
}
const fresh = (ctx: IdentityContext, actor: Actor): boolean =>
  !!actor.stepUpAt && ctx.clock.now().getTime() - actor.stepUpAt.getTime() <= ctx.config.stepUpSeconds * 1000;

export type MfaResult =
  | { status: "OK"; /** present only when the session token was rotated (first MFA completion) — the caller must replace its token */ newToken?: string }
  | { status: "INVALID" }
  | { status: "RATE_LIMITED"; retryAfterSeconds: number }
  | { status: "NOT_ENROLLED" };

/** Mark the session MFA-complete + stepped-up; rotate the token on the FIRST completion (session-fixation defence). */
async function completeOnSession(tx: Tx, ctx: IdentityContext, actor: Actor, method: "TOTP" | "RECOVERY_CODE"): Promise<string | undefined> {
  const now = iso(ctx.clock.now());
  const res = await tx.execute(
    sql`update user_sessions set mfa_verified_at = coalesce(mfa_verified_at, ${now}::timestamptz), mfa_method = coalesce(mfa_method, ${method}), step_up_at = ${now}::timestamptz
         where id = ${actor.sessionId} and revoked_at is null returning id`,
  );
  if (res.rows.length !== 1) throw new DomainError("AUTH_UNAUTHENTICATED", "session is no longer valid");
  return actor.mfaVerifiedAt ? undefined : rotateSessionToken(tx, actor.sessionId);
}

async function newRecoveryBatch(ctx: IdentityContext): Promise<{ codes: string[]; rows: { code: string; digest: Buffer; version: number }[] }> {
  const codes = Array.from({ length: ctx.config.mfa.recoveryCodeCount }, generateRecoveryCode);
  const fps = await Promise.all(codes.map((c) => fingerprint(ctx.keys, RC_PURPOSE, normalizeRecoveryCode(c)!)));
  return { codes, rows: codes.map((code, i) => ({ code, digest: fps[i]!.digest, version: fps[i]!.hmacVersion })) };
}

async function storeRecoveryBatch(tx: Tx, ctx: IdentityContext, userId: string, batch: { digest: Buffer; version: number }[]): Promise<void> {
  await lockKey(tx, `identity:recovery:${userId}`); // concurrent regenerations serialise: exactly one live batch
  const now = iso(ctx.clock.now());
  await tx.execute(sql`update admin_recovery_codes set superseded_at = ${now}::timestamptz where user_id = ${userId} and used_at is null and superseded_at is null`);
  const batchId = uuidv7(ctx.clock);
  for (const r of batch) {
    await tx.execute(
      sql`insert into admin_recovery_codes (id, user_id, batch_id, code_digest, hmac_version, created_at)
          values (${uuidv7(ctx.clock)}, ${userId}, ${batchId}, ${r.digest}, ${r.version}, ${now}::timestamptz)`,
    );
  }
}

/**
 * Start TOTP enrolment. First enrolment is allowed from a restricted (OTP-only) session that is recent;
 * REPLACING an active authenticator requires a fresh step-up. Requires a configured KeyProvider (fails
 * closed otherwise — so production cannot enrol until D8 + SEC-KAT are done).
 */
export async function beginTotpEnrollment(ctx: IdentityContext, actor: Actor): Promise<{ secretBase32: string; otpauthUri: string }> {
  requireStaff(actor);
  const rl = await consumeRateLimit(ctx.db, { bucket: `totp:enroll:${actor.userId}`, limit: 10, windowSeconds: 3600 }, ctx.clock);
  if (!rl.allowed) throw new DomainError("AUTH_FORBIDDEN", "too many enrolment attempts");
  const hasActive = (await ctx.db.execute(sql`select 1 from admin_totp where user_id = ${actor.userId} and status = 'ACTIVE'`)).rows.length > 0;
  if (hasActive) {
    if (!fresh(ctx, actor)) throw new DomainError("AUTH_STEP_UP_REQUIRED", "recent re-authentication is required to replace the authenticator");
  } else if (ctx.clock.now().getTime() - actor.sessionCreatedAt.getTime() > ctx.config.mfa.enrollmentSessionMaxAgeSeconds * 1000) {
    throw new DomainError("AUTH_STEP_UP_REQUIRED", "log in again to enrol an authenticator");
  }
  const secret = generateTotpSecret();
  const id = uuidv7(ctx.clock);
  try {
    const sealed = encodeSealed(await sealSecret(ctx.keys, secret, sealCtx(id)));
    await withTransaction(ctx.db, async (tx) => {
      await tx.execute(sql`update admin_totp set status = 'REPLACED', replaced_at = ${iso(ctx.clock.now())}::timestamptz where user_id = ${actor.userId} and status = 'PENDING'`);
      await tx.execute(sql`insert into admin_totp (id, user_id, status, secret_sealed, created_at) values (${id}, ${actor.userId}, 'PENDING', ${sealed}, ${iso(ctx.clock.now())}::timestamptz)`);
      await auditStaff(tx, ctx, toAuditActor(actor), "identity.mfa.enrollment_started", { type: "user", id: actor.userId });
    });
    const secretBase32 = base32Encode(secret);
    return { secretBase32, otpauthUri: otpauthUri({ issuer: ctx.issuer, account: actor.userId, secretBase32 }) };
  } finally {
    secret.fill(0);
  }
}

/** Confirm enrolment with a code from the authenticator. Issues the one-time recovery codes. */
export async function confirmTotpEnrollment(ctx: IdentityContext, actor: Actor, rawCode: string): Promise<MfaResult & { recoveryCodes?: string[] }> {
  requireStaff(actor);
  const rl = await consumeRateLimit(ctx.db, { bucket: `totp:v:${actor.userId}`, limit: ctx.config.mfa.totpAttemptsPer5Min, windowSeconds: 300 }, ctx.clock);
  if (!rl.allowed) return { status: "RATE_LIMITED", retryAfterSeconds: rl.retryAfterSeconds };
  const p = rows<{ id: string; secret_sealed: Buffer }>(await ctx.db.execute(sql`select id, secret_sealed from admin_totp where user_id = ${actor.userId} and status = 'PENDING'`))[0];
  if (!p) return { status: "NOT_ENROLLED" };
  const secret = await openSecret(ctx.keys, decodeSealed(p.secret_sealed), sealCtx(p.id));
  let step: number | null;
  try {
    step = verifyTotp(secret, rawCode.replace(/\s/g, ""), ctx.clock.now());
  } finally {
    secret.fill(0);
  }
  if (step === null) return { status: "INVALID" };
  const batch = await newRecoveryBatch(ctx);

  return withTransaction(ctx.db, async (tx) => {
    const now = iso(ctx.clock.now());
    await tx.execute(sql`update admin_totp set status = 'REPLACED', replaced_at = ${now}::timestamptz where user_id = ${actor.userId} and status = 'ACTIVE'`);
    const done = await tx.execute(
      sql`update admin_totp set status = 'ACTIVE', confirmed_at = ${now}::timestamptz, last_used_step = ${step} where id = ${p.id} and status = 'PENDING' returning id`,
    );
    if (done.rows.length !== 1) throw new DomainError("MFA_STATE_INVALID", "enrolment was already completed"); // concurrent confirm: roll back (restores the replaced one)
    await storeRecoveryBatch(tx, ctx, actor.userId, batch.rows);
    const newToken = await completeOnSession(tx, ctx, actor, "TOTP");
    await auditStaff(tx, ctx, toAuditActor(actor), "identity.mfa.enrolled", { type: "user", id: actor.userId }, { metadata: { recoveryCodes: batch.codes.length } });
    return { status: "OK" as const, ...(newToken ? { newToken } : {}), recoveryCodes: batch.codes };
  }).catch((e: unknown) => {
    if (e instanceof DomainError && e.code === "MFA_STATE_INVALID") return { status: "INVALID" as const };
    throw e;
  });
}

/** Second factor at login AND step-up for sensitive operations (same operation). Replay-safe. */
export async function verifyTotpCode(ctx: IdentityContext, actor: Actor, rawCode: string): Promise<MfaResult> {
  requireStaff(actor);
  const rl = await consumeRateLimit(ctx.db, { bucket: `totp:v:${actor.userId}`, limit: ctx.config.mfa.totpAttemptsPer5Min, windowSeconds: 300 }, ctx.clock);
  if (!rl.allowed) return { status: "RATE_LIMITED", retryAfterSeconds: rl.retryAfterSeconds };
  const a = rows<{ id: string; secret_sealed: Buffer }>(await ctx.db.execute(sql`select id, secret_sealed from admin_totp where user_id = ${actor.userId} and status = 'ACTIVE'`))[0];
  if (!a) return { status: "NOT_ENROLLED" };
  const secret = await openSecret(ctx.keys, decodeSealed(a.secret_sealed), sealCtx(a.id));
  let step: number | null;
  try {
    step = verifyTotp(secret, rawCode.replace(/\s/g, ""), ctx.clock.now());
  } finally {
    secret.fill(0);
  }
  if (step === null) {
    await withTransaction(ctx.db, (tx) => auditStaff(tx, ctx, toAuditActor(actor), "identity.mfa.failed", { type: "user", id: actor.userId }, { metadata: { method: "TOTP", reason: "wrong_code" } }));
    return { status: "INVALID" };
  }
  return withTransaction(ctx.db, async (tx): Promise<MfaResult> => {
    // Replay guard: a time step can be consumed once; the conditional UPDATE is the arbiter under concurrency.
    const used = await tx.execute(
      sql`update admin_totp set last_used_step = ${step} where id = ${a.id} and status = 'ACTIVE' and (last_used_step is null or last_used_step < ${step}) returning id`,
    );
    if (used.rows.length !== 1) return { status: "INVALID" };
    const newToken = await completeOnSession(tx, ctx, actor, "TOTP");
    await auditStaff(tx, ctx, toAuditActor(actor), actor.mfaVerifiedAt ? "identity.mfa.step_up" : "identity.mfa.verified", { type: "user", id: actor.userId }, { metadata: { method: "TOTP" } });
    return { status: "OK", ...(newToken ? { newToken } : {}) };
  });
}

/** One-time recovery code: completes MFA for this session (e.g. lost device). The single-use is a conditional UPDATE. */
export async function verifyRecoveryCode(ctx: IdentityContext, actor: Actor, rawCode: string): Promise<MfaResult & { remaining?: number }> {
  requireStaff(actor);
  const rl = await consumeRateLimit(ctx.db, { bucket: `rc:${actor.userId}`, limit: ctx.config.mfa.recoveryAttemptsPer15Min, windowSeconds: 900 }, ctx.clock);
  if (!rl.allowed) return { status: "RATE_LIMITED", retryAfterSeconds: rl.retryAfterSeconds };
  const norm = normalizeRecoveryCode(rawCode);
  if (!norm) return { status: "INVALID" };
  const fps = await fingerprintsAllVersions(ctx.keys, RC_PURPOSE, norm);
  return withTransaction(ctx.db, async (tx) => {
    const cond = sql.join(fps.map((f) => sql`(hmac_version = ${f.hmacVersion} and code_digest = ${f.digest})`), sql` or `);
    const used = await tx.execute(
      sql`update admin_recovery_codes set used_at = ${iso(ctx.clock.now())}::timestamptz
           where user_id = ${actor.userId} and used_at is null and superseded_at is null and (${cond}) returning id`,
    );
    if (used.rows.length !== 1) {
      await auditStaff(tx, ctx, toAuditActor(actor), "identity.mfa.failed", { type: "user", id: actor.userId }, { metadata: { method: "RECOVERY_CODE", reason: "wrong_code" } });
      return { status: "INVALID" as const };
    }
    const newToken = await completeOnSession(tx, ctx, actor, "RECOVERY_CODE");
    const remaining = Number((await tx.execute(sql`select count(*) c from admin_recovery_codes where user_id = ${actor.userId} and used_at is null and superseded_at is null`)).rows[0]!.c);
    await auditStaff(tx, ctx, toAuditActor(actor), "identity.mfa.recovery_code_used", { type: "user", id: actor.userId }, { metadata: { remaining } });
    return { status: "OK" as const, remaining, ...(newToken ? { newToken } : {}) };
  });
}

/** Replace the whole recovery-code set (old unused codes stop working). Needs a fresh step-up. */
export async function regenerateRecoveryCodes(ctx: IdentityContext, actor: Actor): Promise<string[]> {
  requireStaff(actor);
  if (!fresh(ctx, actor)) throw new DomainError("AUTH_STEP_UP_REQUIRED", "recent re-authentication is required");
  const active = await ctx.db.execute(sql`select 1 from admin_totp where user_id = ${actor.userId} and status = 'ACTIVE'`);
  if (!active.rows.length) throw new DomainError("MFA_STATE_INVALID", "no active authenticator");
  const batch = await newRecoveryBatch(ctx);
  await withTransaction(ctx.db, async (tx) => {
    await storeRecoveryBatch(tx, ctx, actor.userId, batch.rows);
    await auditStaff(tx, ctx, toAuditActor(actor), "identity.mfa.recovery_codes_regenerated", { type: "user", id: actor.userId }, { metadata: { count: batch.codes.length } });
  });
  return batch.codes;
}

