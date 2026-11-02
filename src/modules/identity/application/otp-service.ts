import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { fingerprint } from "@/platform/crypto";
import { withTransaction } from "@/platform/db";
import type { Tx } from "@/platform/db";
import { DomainError, isDomainError } from "@/platform/errors";
import { uuidv7 } from "@/platform/ids";
import { consumeRateLimit } from "@/platform/ratelimit";
import { setTransitionContext } from "@/platform/transitions";
import { tryNormalizePhone } from "../domain/phone";
import { generateOtpCode } from "../domain/tokens";
import type { RequestOtpResult, SecurityContext, UserKind, VerifyOtpResult } from "../domain/types";
import { asDate, auditStaff, iso, lockKey, rows, sha256hex } from "./context";
import type { IdentityContext } from "./context";
import { createSession } from "./session-service";

const PURPOSE = "otp.login";
const DIGITS = /[۰-۹٠-٩]/g;
const otpMessage = (code: string, ttlSeconds: number) => `کد ورود شما: ${code}\nاعتبار: ${Math.round(ttlSeconds / 60)} دقیقه\nاین کد را به کسی ندهید.`;

function normalizeCodeInput(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 20) return null;
  const v = raw.normalize("NFKC").replace(DIGITS, (c) => String(c.charCodeAt(0) >= 0x06f0 ? c.charCodeAt(0) - 0x06f0 : c.charCodeAt(0) - 0x0660)).replace(/\s/g, "");
  return /^\d{6}$/.test(v) ? v : null;
}

/**
 * Step 1 — create a challenge and send it. The SMS is sent AFTER the challenge transaction commits
 * (never inside it). Outcomes of the provider are handled explicitly:
 *   ACCEPTED -> PENDING→SENT.  REJECTED (definitive) -> PENDING→FAILED: the challenge can never verify,
 *   resend is allowed immediately.  Thrown error (outcome unknown) -> challenge stays PENDING & verifiable,
 *   normal cooldown applies to a resend (which supersedes it).  The plaintext code exists only in memory.
 * The response never depends on whether the phone already has an account (no enumeration).
 */
export async function requestOtp(ctx: IdentityContext, rawPhone: string, sec: SecurityContext = {}): Promise<RequestOtpResult> {
  const phone = tryNormalizePhone(rawPhone);
  if (!phone) throw new DomainError("PHONE_INVALID", "not a valid Iranian mobile number");
  const { otp } = ctx.config;
  const now = ctx.clock.now();
  const h = sha256hex(phone);

  // Exact cooldown from the newest non-failed challenge (a definitively failed send does not block a resend).
  const lastRaw = rows<{ created_at: Date | string | null }>(
    await ctx.db.execute(sql`select max(created_at) as created_at from otp_challenges where phone = ${phone} and status <> 'FAILED'`),
  )[0]?.created_at;
  const last = lastRaw ? asDate(lastRaw) : null;
  if (last) {
    const wait = Math.ceil((last.getTime() + otp.cooldownSeconds * 1000 - now.getTime()) / 1000);
    if (wait > 0) return { status: "RATE_LIMITED", retryAfterSeconds: wait };
  }
  const limits = [
    { bucket: `otp:h:${h}`, limit: otp.sendsPerHour, windowSeconds: 3600 },
    ...(sec.clientKey ? [{ bucket: `otp:c:${sha256hex(sec.clientKey)}`, limit: otp.clientSendsPerHour, windowSeconds: 3600 }] : []),
    { bucket: "otp:global", limit: otp.globalSendsPerHour, windowSeconds: 3600 },
  ];
  for (const rule of limits) {
    const r = await consumeRateLimit(ctx.db, rule, ctx.clock); // own committed statement (survives rollbacks)
    if (!r.allowed) return { status: "RATE_LIMITED", retryAfterSeconds: r.retryAfterSeconds };
  }

  const code = generateOtpCode(otp.digits);
  // Keyed hash (6 digits are brute-forceable if unkeyed). Fails closed when no KeyProvider is configured.
  const fp = await fingerprint(ctx.keys, PURPOSE, `${phone}|${code}`);
  const id = uuidv7(ctx.clock);
  const expiresAt = new Date(now.getTime() + otp.ttlSeconds * 1000);

  try {
    await withTransaction(ctx.db, async (tx) => {
      await tx.execute(sql`update otp_challenges set status = 'SUPERSEDED' where phone = ${phone} and status in ('PENDING','SENT')`);
      await tx.execute(
        sql`insert into otp_challenges (id, phone, code_digest, hmac_version, status, attempts, max_attempts, created_at, expires_at)
            values (${id}, ${phone}, ${fp.digest}, ${fp.hmacVersion}, 'PENDING', 0, ${otp.maxAttempts}, ${iso(now)}::timestamptz, ${iso(expiresAt)}::timestamptz)`,
      );
    });
  } catch (e) {
    if ((e as { code?: string; cause?: { code?: string } }).code === "23505" || (e as { cause?: { code?: string } }).cause?.code === "23505") {
      return { status: "RATE_LIMITED", retryAfterSeconds: otp.cooldownSeconds }; // a concurrent request won the single active slot
    }
    throw e;
  }

  // ---- outside any DB transaction ----
  let outcome: "ACCEPTED" | "REJECTED" | "UNKNOWN" = "UNKNOWN";
  let configError: DomainError | null = null;
  try {
    outcome = (await ctx.sms.send({ to: phone, text: otpMessage(code, otp.ttlSeconds) })).status;
  } catch (e) {
    if (isDomainError(e, "SMS_PROVIDER_NOT_CONFIGURED")) {
      outcome = "REJECTED";
      configError = e;
    }
  }
  if (outcome === "ACCEPTED") {
    await ctx.db.execute(sql`update otp_challenges set status = 'SENT', sent_at = ${iso(ctx.clock.now())}::timestamptz where id = ${id} and status = 'PENDING'`);
  } else if (outcome === "REJECTED") {
    await ctx.db.execute(sql`update otp_challenges set status = 'FAILED' where id = ${id} and status = 'PENDING'`);
    if (configError) throw configError; // operator-visible misconfiguration, fail loudly
    return { status: "DELIVERY_FAILED", resendAfterSeconds: 0 };
  }
  return { status: "SENT", expiresAt, resendAfterSeconds: otp.cooldownSeconds };
}

interface ChallengeRow { id: string; code_digest: Buffer; hmac_version: number; expires_at: Date | string }

/**
 * Step 2 — verify. Concurrency-safe: the attempt counter is incremented by one conditional UPDATE that
 * also takes the row lock; verifiers of one challenge therefore serialise, and only the first correct one
 * can move the row to CONSUMED. All "no" outcomes are indistinguishable to the caller.
 */
export async function verifyOtp(ctx: IdentityContext, rawPhone: string, rawCode: string, sec: SecurityContext = {}): Promise<VerifyOtpResult> {
  const phone = tryNormalizePhone(rawPhone);
  const code = normalizeCodeInput(rawCode);
  if (!phone || !code) return { status: "INVALID" };
  const now = ctx.clock.now();

  const rl = await consumeRateLimit(ctx.db, { bucket: `otp:v:${sha256hex(phone)}`, limit: ctx.config.otp.verifiesPerHour, windowSeconds: 3600 }, ctx.clock);
  if (!rl.allowed) return { status: "RATE_LIMITED", retryAfterSeconds: rl.retryAfterSeconds };

  const ch = rows<ChallengeRow>(
    await ctx.db.execute(sql`select id, code_digest, hmac_version, expires_at from otp_challenges where phone = ${phone} and status in ('PENDING','SENT')`),
  )[0];
  if (!ch || asDate(ch.expires_at).getTime() <= now.getTime()) return { status: "INVALID" };

  // HMAC outside the transaction (a remote KeyProvider must not hold a DB transaction open).
  const supplied = (await fingerprint(ctx.keys, PURPOSE, `${phone}|${code}`, ch.hmac_version)).digest;

  return withTransaction(ctx.db, async (tx): Promise<VerifyOtpResult> => {
    const a = rows<{ attempts: number; max_attempts: number; code_digest: Buffer }>(
      await tx.execute(
        sql`update otp_challenges set attempts = attempts + 1
             where id = ${ch.id} and status in ('PENDING','SENT') and expires_at > ${iso(now)}::timestamptz and attempts < max_attempts
         returning attempts, max_attempts, code_digest`,
      ),
    )[0];
    if (!a) return { status: "INVALID" };

    const ok = a.code_digest.length === supplied.length && timingSafeEqual(a.code_digest, supplied);
    if (!ok) {
      if (a.attempts >= a.max_attempts) await tx.execute(sql`update otp_challenges set status = 'LOCKED' where id = ${ch.id} and status in ('PENDING','SENT')`);
      return { status: "INVALID" };
    }
    await tx.execute(sql`update otp_challenges set status = 'CONSUMED', consumed_at = ${iso(now)}::timestamptz where id = ${ch.id} and status in ('PENDING','SENT')`);

    const user = await findOrCreateUserByPhone(tx, ctx, phone);
    if (user.status !== "ACTIVE") return { status: "INVALID" };
    const grant = await createSession(tx, ctx, { userId: user.id, kind: user.kind, sec });
    let mfaState: "NOT_REQUIRED" | "ENROLL_REQUIRED" | "TOTP_REQUIRED" = "NOT_REQUIRED";
    if (user.kind === "STAFF") {
      const has = await tx.execute(sql`select 1 from admin_totp where user_id = ${user.id} and status = 'ACTIVE'`);
      mfaState = has.rows.length ? "TOTP_REQUIRED" : "ENROLL_REQUIRED";
      await auditStaff(tx, ctx, { type: "ADMIN", id: user.id }, "identity.session.created", { type: "user", id: user.id }, { metadata: { mfaState, factor: "OTP" } });
    }
    return { status: "OK", newUser: user.created, session: { ...grant, mfaState } };
  });
}

interface UserLookup { id: string; kind: UserKind; status: string; created: boolean }

/** Customer self-registration happens here (OTP proves phone ownership). Staff are never created here. */
async function findOrCreateUserByPhone(tx: Tx, ctx: IdentityContext, phone: string): Promise<UserLookup> {
  await lockKey(tx, `identity:phone:${phone}`);
  const found = rows<{ id: string; kind: UserKind; status: string; identity_id: string; verified_at: Date | null }>(
    await tx.execute(
      sql`select u.id, u.kind, u.status, i.id as identity_id, i.verified_at
            from user_identities i join users u on u.id = i.user_id where i.type = 'PHONE' and i.value = ${phone}`,
    ),
  )[0];
  const now = ctx.clock.now();
  if (found) {
    if (!found.verified_at) await tx.execute(sql`update user_identities set verified_at = ${iso(now)}::timestamptz where id = ${found.identity_id}`);
    return { id: found.id, kind: found.kind, status: found.status, created: false };
  }
  const userId = uuidv7(ctx.clock);
  await setTransitionContext(tx, { actorId: "system:identity", reason: "otp signup" });
  await tx.execute(sql`insert into users (id, kind, status, authz_version, created_at, updated_at) values (${userId}, 'CUSTOMER', 'ACTIVE', 0, ${iso(now)}::timestamptz, ${iso(now)}::timestamptz)`);
  await tx.execute(
    sql`insert into user_identities (id, user_id, type, value, is_primary, verified_at, created_at)
        values (${uuidv7(ctx.clock)}, ${userId}, 'PHONE', ${phone}, true, ${iso(now)}::timestamptz, ${iso(now)}::timestamptz)`,
  );
  await auditStaff(tx, ctx, { type: "USER", id: userId }, "identity.user.registered", { type: "user", id: userId });
  return { id: userId, kind: "CUSTOMER", status: "ACTIVE", created: true };
}
