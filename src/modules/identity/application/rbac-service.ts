import { sql } from "drizzle-orm";
import { withTransaction } from "@/platform/db";
import type { Tx } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { uuidv7 } from "@/platform/ids";
import { toAuditActor } from "../domain/types";
import type { Actor } from "../domain/types";
import { auditStaff, iso, lockKey, rows } from "./context";
import type { IdentityContext } from "./context";

export type PermissionVerdict = "ALLOW" | "DENY" | "MFA_REQUIRED" | "STEP_UP_REQUIRED";

/** One query per (user, authz_version); cached in a bounded LRU. A role change bumps authz_version in the DB. */
export async function loadPermissions(ctx: IdentityContext, userId: string, authzVersion: number): Promise<ReadonlySet<string>> {
  const key = `${userId}:${authzVersion}`;
  const hit = ctx.permissionCache.get(key);
  if (hit) return hit;
  const r = rows<{ permission: string }>(
    await ctx.db.execute(
      sql`select distinct rp.permission
            from user_roles ur join role_permissions rp on rp.role_id = ur.role_id
           where ur.user_id = ${userId} and ur.revoked_at is null and rp.revoked_at is null`,
    ),
  );
  // Only permissions currently registered in the catalog count: unknown keys are denied.
  const set = new Set(r.map((x) => x.permission).filter((p) => ctx.catalog.has(p)));
  ctx.permissionCache.set(key, set);
  return set;
}

/** Central decision. Deny by default; staff need completed MFA; sensitive permissions need a fresh step-up. */
export async function checkPermission(ctx: IdentityContext, actor: Actor, permission: string): Promise<PermissionVerdict> {
  const def = ctx.catalog.get(permission);
  if (!def || actor.kind !== "STAFF") return "DENY";
  if (!actor.mfaVerifiedAt) return "MFA_REQUIRED";
  const perms = await loadPermissions(ctx, actor.userId, actor.authzVersion);
  if (!perms.has(permission)) return "DENY";
  if (def.sensitive) {
    const fresh = actor.stepUpAt && ctx.clock.now().getTime() - actor.stepUpAt.getTime() <= ctx.config.stepUpSeconds * 1000;
    if (!fresh) return "STEP_UP_REQUIRED";
  }
  return "ALLOW";
}

export async function authorize(ctx: IdentityContext, actor: Actor, permission: string): Promise<void> {
  const v = await checkPermission(ctx, actor, permission);
  if (v === "ALLOW") return;
  if (v === "MFA_REQUIRED") throw new DomainError("AUTH_MFA_REQUIRED", "multi-factor authentication is required");
  if (v === "STEP_UP_REQUIRED") throw new DomainError("AUTH_STEP_UP_REQUIRED", "recent re-authentication is required");
  throw new DomainError("AUTH_FORBIDDEN", "not permitted");
}

type Executor = Pick<Tx, "execute">;

interface RoleRow { id: string; name: string }

async function roleByName(tx: Executor, name: string): Promise<RoleRow> {
  const r = rows<RoleRow>(await tx.execute(sql`select id, name from roles where name = ${name}`))[0];
  if (!r) throw new DomainError("IDENTITY_NOT_FOUND", "role not found");
  return r;
}

async function activePermissionsOfRole(tx: Executor, roleId: string): Promise<string[]> {
  return rows<{ permission: string }>(await tx.execute(sql`select permission from role_permissions where role_id = ${roleId} and revoked_at is null`)).map((x) => x.permission);
}

async function actorHoldsRole(tx: Executor, userId: string, roleId: string): Promise<boolean> {
  return (await tx.execute(sql`select 1 from user_roles where user_id = ${userId} and role_id = ${roleId} and revoked_at is null`)).rows.length > 0;
}

/**
 * Grant a role to a STAFF user. Rules: identity.roles.manage (sensitive => step-up); never to oneself;
 * the actor must already hold every permission the role carries (no privilege escalation through roles).
 */
export async function grantRole(ctx: IdentityContext, actor: Actor, targetUserId: string, roleName: string): Promise<void> {
  await authorize(ctx, actor, "identity.roles.manage");
  if (targetUserId === actor.userId) throw new DomainError("AUTH_FORBIDDEN", "self-promotion is not allowed");
  const mine = await loadPermissions(ctx, actor.userId, actor.authzVersion);
  await withTransaction(ctx.db, async (tx) => {
    const role = await roleByName(tx, roleName);
    // Only registered permissions are meaningful: unknown keys stored in role data are inert.
    const perms = (await activePermissionsOfRole(tx, role.id)).filter((p) => ctx.catalog.has(p));
    if (perms.some((p) => !mine.has(p))) throw new DomainError("AUTH_FORBIDDEN", "cannot grant a role with permissions you do not hold");
    const target = rows<{ kind: string }>(await tx.execute(sql`select kind from users where id = ${targetUserId}`))[0];
    if (!target) throw new DomainError("IDENTITY_NOT_FOUND", "user not found");
    if (target.kind !== "STAFF") throw new DomainError("IDENTITY_CONFLICT", "roles can only be granted to staff");
    const res = await tx.execute(
      sql`insert into user_roles (id, user_id, role_id, granted_by, granted_at) values (${uuidv7(ctx.clock)}, ${targetUserId}, ${role.id}, ${actor.userId}, ${iso(ctx.clock.now())}::timestamptz)
          on conflict (user_id, role_id) where revoked_at is null do nothing returning id`,
    );
    if (res.rows.length === 1) {
      await auditStaff(tx, ctx, toAuditActor(actor), "identity.role.granted", { type: "user", id: targetUserId }, { after: { role: role.name, permissions: perms } });
    }
  });
}

export async function revokeRole(ctx: IdentityContext, actor: Actor, targetUserId: string, roleName: string): Promise<void> {
  await authorize(ctx, actor, "identity.roles.manage");
  if (targetUserId === actor.userId) throw new DomainError("AUTH_FORBIDDEN", "cannot change your own roles");
  await withTransaction(ctx.db, async (tx) => {
    const role = await roleByName(tx, roleName);
    if (role.name === "owner") {
      await lockKey(tx, "identity:owners");
      const others = await tx.execute(
        sql`select 1 from user_roles ur join users u on u.id = ur.user_id
             where ur.role_id = ${role.id} and ur.revoked_at is null and u.status = 'ACTIVE' and ur.user_id <> ${targetUserId}`,
      );
      if (others.rows.length === 0) throw new DomainError("IDENTITY_CONFLICT", "cannot remove the last active owner");
    }
    const res = await tx.execute(
      sql`update user_roles set revoked_at = ${iso(ctx.clock.now())}::timestamptz, revoked_by = ${actor.userId}
           where user_id = ${targetUserId} and role_id = ${role.id} and revoked_at is null returning id`,
    );
    if (res.rows.length === 1) await auditStaff(tx, ctx, toAuditActor(actor), "identity.role.revoked", { type: "user", id: targetUserId }, { before: { role: role.name } });
  });
}

/** Add a permission to a role. The permission must be registered, the actor must hold it, and must not hold the role. */
export async function grantRolePermission(ctx: IdentityContext, actor: Actor, roleName: string, permission: string): Promise<void> {
  await authorize(ctx, actor, "identity.roles.manage");
  if (!ctx.catalog.has(permission)) throw new DomainError("INVALID_ARGUMENT", "permission is not registered");
  const mine = await loadPermissions(ctx, actor.userId, actor.authzVersion);
  if (!mine.has(permission)) throw new DomainError("AUTH_FORBIDDEN", "cannot grant a permission you do not hold");
  await withTransaction(ctx.db, async (tx) => {
    const role = await roleByName(tx, roleName);
    if (await actorHoldsRole(tx, actor.userId, role.id)) throw new DomainError("AUTH_FORBIDDEN", "cannot modify a role you hold");
    const res = await tx.execute(
      sql`insert into role_permissions (id, role_id, permission, granted_by, granted_at) values (${uuidv7(ctx.clock)}, ${role.id}, ${permission}, ${actor.userId}, ${iso(ctx.clock.now())}::timestamptz)
          on conflict (role_id, permission) where revoked_at is null do nothing returning id`,
    );
    if (res.rows.length === 1) await auditStaff(tx, ctx, toAuditActor(actor), "identity.role.permission_granted", { type: "role", id: role.name }, { after: { permission } });
  });
}

export async function revokeRolePermission(ctx: IdentityContext, actor: Actor, roleName: string, permission: string): Promise<void> {
  await authorize(ctx, actor, "identity.roles.manage");
  await withTransaction(ctx.db, async (tx) => {
    const role = await roleByName(tx, roleName);
    if (await actorHoldsRole(tx, actor.userId, role.id)) throw new DomainError("AUTH_FORBIDDEN", "cannot modify a role you hold");
    const res = await tx.execute(
      sql`update role_permissions set revoked_at = ${iso(ctx.clock.now())}::timestamptz, revoked_by = ${actor.userId}
           where role_id = ${role.id} and permission = ${permission} and revoked_at is null returning id`,
    );
    if (res.rows.length === 1) await auditStaff(tx, ctx, toAuditActor(actor), "identity.role.permission_revoked", { type: "role", id: role.name }, { before: { permission } });
  });
}
