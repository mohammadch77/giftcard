import { sql } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import type { Clock } from "@/platform/clock";
import type { Database, Tx } from "@/platform/db";
import { withTransaction } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { uuidv7 } from "@/platform/ids";
import { conditionalTransition, setTransitionContext } from "@/platform/transitions";
import { maskPhone, normalizePhone } from "../domain/phone";
import { toAuditActor } from "../domain/types";
import type { Actor, UserKind, UserStatus } from "../domain/types";
import { asDate, auditStaff, iso, lockKey, rows } from "./context";
import type { IdentityContext } from "./context";
import { authorize, checkPermission } from "./rbac-service";
import { revokeAllForUser } from "./session-service";

const OWNER_ROLE = "owner";

async function insertStaff(tx: Tx, clock: Clock, phone: string, actorId: string, reason: string): Promise<string> {
  const now = iso(clock.now());
  const userId = uuidv7(clock);
  await setTransitionContext(tx, { actorId, reason });
  await tx.execute(sql`insert into users (id, kind, status, authz_version, created_at, updated_at) values (${userId}, 'STAFF', 'ACTIVE', 0, ${now}::timestamptz, ${now}::timestamptz)`);
  await tx.execute(
    sql`insert into user_identities (id, user_id, type, value, is_primary, verified_at, created_at)
        values (${uuidv7(clock)}, ${userId}, 'PHONE', ${phone}, true, null, ${now}::timestamptz)`,
  );
  return userId;
}

/** Staff accounts are created ONLY here (or by the bootstrap): a phone number alone never makes someone staff. */
export async function createStaff(ctx: IdentityContext, actor: Actor, rawPhone: string): Promise<{ userId: string }> {
  await authorize(ctx, actor, "identity.staff.manage");
  const phone = normalizePhone(rawPhone);
  return withTransaction(ctx.db, async (tx) => {
    await lockKey(tx, `identity:phone:${phone}`);
    const exists = await tx.execute(sql`select 1 from user_identities where type = 'PHONE' and value = ${phone}`);
    if (exists.rows.length) throw new DomainError("IDENTITY_CONFLICT", "this phone number is already registered");
    const userId = await insertStaff(tx, ctx.clock, phone, actor.userId, "staff created");
    await auditStaff(tx, ctx, toAuditActor(actor), "identity.staff.created", { type: "user", id: userId });
    return { userId };
  });
}

/**
 * Operator bootstrap of the FIRST owner (run by `npm run identity:bootstrap-owner`, not reachable over HTTP).
 * No default credential exists: the owner must still log in with OTP and enrol TOTP. Refuses to run when an
 * active owner already exists, so it can't be used later as a back door.
 */
export async function bootstrapFirstOwner(db: Database, clock: Clock, rawPhone: string): Promise<{ userId: string }> {
  const phone = normalizePhone(rawPhone);
  return withTransaction(db, async (tx) => {
    await lockKey(tx, "identity:owners");
    const owner = await tx.execute(
      sql`select 1 from user_roles ur join roles r on r.id = ur.role_id
           where r.name = ${OWNER_ROLE} and ur.revoked_at is null limit 1`,
    );
    if (owner.rows.length) throw new DomainError("IDENTITY_CONFLICT", "an owner already exists; bootstrap is disabled");
    await lockKey(tx, `identity:phone:${phone}`);
    const existing = rows<{ id: string; kind: UserKind }>(
      await tx.execute(sql`select u.id, u.kind from user_identities i join users u on u.id = i.user_id where i.type = 'PHONE' and i.value = ${phone}`),
    )[0];
    if (existing && existing.kind !== "STAFF") throw new DomainError("IDENTITY_CONFLICT", "phone belongs to a customer account");
    const userId = existing?.id ?? (await insertStaff(tx, clock, phone, "system:bootstrap", "first owner"));
    await tx.execute(
      sql`insert into user_roles (id, user_id, role_id, granted_by, granted_at)
          select ${uuidv7(clock)}, ${userId}, r.id, null, ${iso(clock.now())}::timestamptz from roles r where r.name = ${OWNER_ROLE}`,
    );
    await recordAudit(tx, { actor: { type: "SYSTEM", id: "system:bootstrap" }, action: "identity.owner.bootstrapped", entity: { type: "user", id: userId }, occurredAt: clock.now() });
    return { userId };
  });
}

/** Suspend / reactivate / close. Never yourself; never the last active owner. Revokes sessions when leaving ACTIVE. */
export async function setUserStatus(ctx: IdentityContext, actor: Actor, userId: string, to: UserStatus, reason: string): Promise<void> {
  await authorize(ctx, actor, "identity.users.suspend");
  if (userId === actor.userId) throw new DomainError("AUTH_FORBIDDEN", "cannot change your own status");
  if (reason.trim().length < 5) throw new DomainError("INVALID_ARGUMENT", "a reason is required");
  await withTransaction(ctx.db, async (tx) => {
    await lockKey(tx, "identity:owners");
    const u = rows<{ status: UserStatus; kind: UserKind }>(await tx.execute(sql`select status, kind from users where id = ${userId} for update`))[0];
    if (!u) throw new DomainError("IDENTITY_NOT_FOUND", "user not found");
    if (to !== "ACTIVE") {
      const sole = await tx.execute(
        sql`select 1 from user_roles ur join roles r on r.id = ur.role_id where r.name = ${OWNER_ROLE} and ur.user_id = ${userId} and ur.revoked_at is null
              and not exists (select 1 from user_roles o join roles r2 on r2.id = o.role_id join users ou on ou.id = o.user_id
                               where r2.name = ${OWNER_ROLE} and o.revoked_at is null and ou.status = 'ACTIVE' and o.user_id <> ${userId})`,
      );
      if (sole.rows.length) throw new DomainError("IDENTITY_CONFLICT", "cannot deactivate the last active owner");
    }
    const moved = await conditionalTransition(tx, { table: "users", id: userId, from: u.status, to, context: { actorId: actor.userId, reason: reason.trim() } });
    if (!moved) throw new DomainError("TRANSITION_CONFLICT", "user status changed concurrently");
    await tx.execute(sql`update users set updated_at = ${iso(ctx.clock.now())}::timestamptz where id = ${userId}`);
    const revoked = to === "ACTIVE" ? 0 : await revokeAllForUser(tx, ctx, userId, `STATUS_${to}`);
    await auditStaff(tx, ctx, toAuditActor(actor), "identity.user.status_changed", { type: "user", id: userId }, { before: { status: u.status }, after: { status: to }, metadata: { reason: reason.trim(), revokedSessions: revoked } });
  });
}

export interface UserSummary { id: string; kind: UserKind; status: UserStatus; phone: string; phoneMasked: boolean; createdAt: Date }

/** Support-safe read: the phone is masked unless the actor holds identity.users.read_unmasked WITH a fresh step-up. */
export async function getUserSummary(ctx: IdentityContext, actor: Actor, userId: string): Promise<UserSummary> {
  await authorize(ctx, actor, "identity.users.read");
  const r = rows<{ id: string; kind: UserKind; status: UserStatus; created_at: Date | string; phone: string | null }>(
    await ctx.db.execute(
      sql`select u.id, u.kind, u.status, u.created_at, i.value as phone
            from users u left join user_identities i on i.user_id = u.id and i.type = 'PHONE' and i.is_primary where u.id = ${userId}`,
    ),
  )[0];
  if (!r) throw new DomainError("IDENTITY_NOT_FOUND", "user not found");
  const unmasked = (await checkPermission(ctx, actor, "identity.users.read_unmasked")) === "ALLOW";
  if (unmasked) {
    await withTransaction(ctx.db, (tx) => auditStaff(tx, ctx, toAuditActor(actor), "identity.user.viewed_unmasked", { type: "user", id: userId }));
  }
  const phone = r.phone ?? "";
  return { id: r.id, kind: r.kind, status: r.status, phone: unmasked ? phone : maskPhone(phone), phoneMasked: !unmasked, createdAt: asDate(r.created_at) };
}
