import { sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { withTransaction } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { uuidv7 } from "@/platform/ids";
import { generateSessionToken, isWellFormedSessionToken, sessionTokenDigest } from "../domain/tokens";
import { toAuditActor } from "../domain/types";
import type { Actor, SecurityContext, SessionGrant, UserKind } from "../domain/types";
import { asDate, auditStaff, iso, rows } from "./context";
import type { IdentityContext } from "./context";

type Ts = Date | string;
interface SessionRow {
  id: string; user_id: string; created_at: Ts; last_seen_at: Ts; idle_seconds: number; idle_expires_at: Ts; absolute_expires_at: Ts;
  revoked_at: Ts | null; mfa_verified_at: Ts | null; step_up_at: Ts | null; kind: UserKind; status: string; authz_version: string | number;
}

/** Insert a session row; returns the grant (the token is available ONLY here). */
export async function createSession(tx: Tx, ctx: IdentityContext, p: { userId: string; kind: UserKind; sec?: SecurityContext | undefined }): Promise<Omit<SessionGrant, "mfaState">> {
  const now = ctx.clock.now();
  const policy = p.kind === "STAFF" ? ctx.config.session.staff : ctx.config.session.customer;
  const token = generateSessionToken();
  const id = uuidv7(ctx.clock);
  const absolute = new Date(now.getTime() + policy.absoluteSeconds * 1000);
  const idleExp = new Date(Math.min(absolute.getTime(), now.getTime() + policy.idleSeconds * 1000));
  await tx.execute(
    sql`insert into user_sessions (id, user_id, token_digest, created_at, last_seen_at, idle_seconds, idle_expires_at, absolute_expires_at, ip_prefix, user_agent)
        values (${id}, ${p.userId}, ${sessionTokenDigest(token)}, ${iso(now)}::timestamptz, ${iso(now)}::timestamptz, ${policy.idleSeconds},
                ${iso(idleExp)}::timestamptz, ${iso(absolute)}::timestamptz, ${p.sec?.ipPrefix?.slice(0, 64) ?? null}, ${p.sec?.userAgent?.slice(0, 200) ?? null})`,
  );
  return { token, sessionId: id, userId: p.userId, kind: p.kind, expiresAt: absolute };
}

/**
 * Authenticate a bearer token with ONE indexed query (unique token_digest -> users PK). Returns null for
 * unknown/revoked/expired sessions and for non-ACTIVE users. last_seen_at is refreshed at most once per
 * touchIntervalSeconds (conditional UPDATE), so a hot session does not write on every request.
 */
export async function authenticate(ctx: IdentityContext, token: unknown): Promise<Actor | null> {
  if (!isWellFormedSessionToken(token)) return null;
  const now = ctx.clock.now();
  const raw = rows<SessionRow>(
    await ctx.db.execute(
      sql`select s.id, s.user_id, s.created_at, s.last_seen_at, s.idle_seconds, s.idle_expires_at, s.absolute_expires_at, s.revoked_at,
                 s.mfa_verified_at, s.step_up_at, u.kind, u.status, u.authz_version
            from user_sessions s join users u on u.id = s.user_id
           where s.token_digest = ${sessionTokenDigest(token)}`,
    ),
  )[0];
  if (!raw || raw.revoked_at || raw.status !== "ACTIVE") return null;
  const r = { ...raw, created_at: asDate(raw.created_at), last_seen_at: asDate(raw.last_seen_at), idle_expires_at: asDate(raw.idle_expires_at), absolute_expires_at: asDate(raw.absolute_expires_at), mfa_verified_at: asDate(raw.mfa_verified_at), step_up_at: asDate(raw.step_up_at) };
  if (r.idle_expires_at.getTime() <= now.getTime() || r.absolute_expires_at.getTime() <= now.getTime()) return null;
  if (now.getTime() - r.last_seen_at.getTime() >= ctx.config.session.touchIntervalSeconds * 1000) {
    const idleExp = new Date(Math.min(r.absolute_expires_at.getTime(), now.getTime() + r.idle_seconds * 1000));
    await ctx.db.execute(
      sql`update user_sessions set last_seen_at = ${iso(now)}::timestamptz, idle_expires_at = ${iso(idleExp)}::timestamptz
           where id = ${r.id} and revoked_at is null`,
    );
  }
  return {
    userId: r.user_id, kind: r.kind, sessionId: r.id, authzVersion: Number(r.authz_version),
    sessionCreatedAt: r.created_at, mfaVerifiedAt: r.mfa_verified_at, stepUpAt: r.step_up_at,
  };
}

/** Revoke every active session of a user (optionally keeping one). Returns the number revoked. */
export async function revokeAllForUser(tx: Tx, ctx: IdentityContext, userId: string, reason: string, exceptSessionId?: string): Promise<number> {
  const res = await tx.execute(
    sql`update user_sessions set revoked_at = ${iso(ctx.clock.now())}::timestamptz, revoked_reason = ${reason}
         where user_id = ${userId} and revoked_at is null ${exceptSessionId ? sql`and id <> ${exceptSessionId}` : sql``}
         returning id`,
  );
  return res.rows.length;
}

/** Logout = revoke the presented session. Idempotent; unknown tokens are a silent no-op. */
export async function logout(ctx: IdentityContext, token: unknown): Promise<void> {
  if (!isWellFormedSessionToken(token)) return;
  await withTransaction(ctx.db, async (tx) => {
    const r = rows<{ id: string; user_id: string; kind: UserKind }>(
      await tx.execute(
        sql`update user_sessions s set revoked_at = ${iso(ctx.clock.now())}::timestamptz, revoked_reason = 'LOGOUT'
             where s.token_digest = ${sessionTokenDigest(token)} and s.revoked_at is null
         returning s.id, s.user_id, (select kind from users u where u.id = s.user_id) as kind`,
      ),
    )[0];
    if (r?.kind === "STAFF") await auditStaff(tx, ctx, { type: "ADMIN", id: r.user_id }, "identity.session.logout", { type: "user", id: r.user_id });
  });
}

/**
 * Revoke all sessions of `userId`. Own sessions: any authenticated actor (optionally keeping the current
 * one). Another user's sessions: requires identity.sessions.revoke (checked by the caller facade through
 * `authorize`, passed in as `authorized`).
 */
export async function revokeSessionsOf(ctx: IdentityContext, actor: Actor, userId: string, opts: { keepCurrent?: boolean; targetKind: UserKind }): Promise<number> {
  return withTransaction(ctx.db, async (tx) => {
    const n = await revokeAllForUser(tx, ctx, userId, userId === actor.userId ? "LOGOUT_ALL" : "ADMIN_REVOKE", opts.keepCurrent && userId === actor.userId ? actor.sessionId : undefined);
    // Customers: security events only (this is one). Staff: everything.
    await auditStaff(tx, ctx, toAuditActor(actor), "identity.sessions.revoked", { type: "user", id: userId }, { metadata: { count: n, self: userId === actor.userId } });
    return n;
  });
}

/** Replace the session token digest (fixation defence on privilege change). Returns the new token. */
export async function rotateSessionToken(tx: Tx, sessionId: string): Promise<string> {
  const token = generateSessionToken();
  const res = await tx.execute(sql`update user_sessions set token_digest = ${sessionTokenDigest(token)} where id = ${sessionId} and revoked_at is null returning id`);
  if (res.rows.length !== 1) throw new DomainError("AUTH_UNAUTHENTICATED", "session is no longer valid");
  return token;
}
