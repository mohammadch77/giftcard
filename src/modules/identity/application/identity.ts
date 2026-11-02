import type { Clock } from "@/platform/clock";
import { systemClock } from "@/platform/clock";
import type { KeyProvider } from "@/platform/crypto";
import type { Database } from "@/platform/db";
import type { SmsProvider } from "@/platform/sms";
import { DEFAULT_IDENTITY_CONFIG } from "../domain/config";
import type { IdentityConfig } from "../domain/config";
import { PermissionCatalog } from "../domain/permissions";
import type { Actor, SecurityContext } from "../domain/types";
import { BoundedCache } from "./context";
import type { IdentityContext } from "./context";
import * as mfa from "./mfa-service";
import * as otp from "./otp-service";
import * as rbac from "./rbac-service";
import * as recovery from "./recovery-service";
import * as sessions from "./session-service";
import * as users from "./user-service";

export interface IdentityDeps {
  db: Database;
  keys: KeyProvider;
  sms: SmsProvider;
  clock?: Clock;
  config?: Partial<{ [K in keyof IdentityConfig]: IdentityConfig[K] extends object ? Partial<IdentityConfig[K]> : IdentityConfig[K] }>;
  /** Shared catalog; other modules' permissions are registered on it at the composition root. */
  catalog?: PermissionCatalog;
  /** Shown in authenticator apps. */
  issuer?: string;
}

/**
 * The ONLY entry point other code uses. Everything else in this module (tables, services) is private.
 * Authentication (`authenticate`) costs one indexed query; authorisation is centralised in `authorize`.
 */
export function createIdentity(deps: IdentityDeps) {
  const base = DEFAULT_IDENTITY_CONFIG;
  const o = deps.config ?? {};
  const config: IdentityConfig = {
    otp: { ...base.otp, ...o.otp },
    session: { staff: { ...base.session.staff, ...o.session?.staff }, customer: { ...base.session.customer, ...o.session?.customer }, touchIntervalSeconds: o.session?.touchIntervalSeconds ?? base.session.touchIntervalSeconds },
    stepUpSeconds: o.stepUpSeconds ?? base.stepUpSeconds,
    mfa: { ...base.mfa, ...o.mfa },
    permissionCacheSize: o.permissionCacheSize ?? base.permissionCacheSize,
  };
  const ctx: IdentityContext = {
    db: deps.db, clock: deps.clock ?? systemClock, keys: deps.keys, sms: deps.sms, config,
    catalog: deps.catalog ?? new PermissionCatalog(), permissionCache: new BoundedCache(config.permissionCacheSize), issuer: deps.issuer ?? "Giftcard",
  };

  return {
    catalog: ctx.catalog,
    // --- first factor
    requestOtp: (phone: string, sec?: SecurityContext) => otp.requestOtp(ctx, phone, sec),
    verifyOtp: (phone: string, code: string, sec?: SecurityContext) => otp.verifyOtp(ctx, phone, code, sec),
    // --- sessions
    authenticate: (token: unknown) => sessions.authenticate(ctx, token),
    logout: (token: unknown) => sessions.logout(ctx, token),
    revokeOwnSessions: (actor: Actor, opts: { keepCurrent?: boolean } = {}) => sessions.revokeSessionsOf(ctx, actor, actor.userId, { ...opts, targetKind: actor.kind }),
    revokeSessionsOfUser: async (actor: Actor, userId: string) => {
      await rbac.authorize(ctx, actor, "identity.sessions.revoke");
      return sessions.revokeSessionsOf(ctx, actor, userId, { targetKind: "STAFF" });
    },
    // --- authorisation
    authorize: (actor: Actor, permission: string) => rbac.authorize(ctx, actor, permission),
    can: async (actor: Actor, permission: string) => (await rbac.checkPermission(ctx, actor, permission)) === "ALLOW",
    grantRole: (actor: Actor, userId: string, role: string) => rbac.grantRole(ctx, actor, userId, role),
    revokeRole: (actor: Actor, userId: string, role: string) => rbac.revokeRole(ctx, actor, userId, role),
    grantRolePermission: (actor: Actor, role: string, permission: string) => rbac.grantRolePermission(ctx, actor, role, permission),
    revokeRolePermission: (actor: Actor, role: string, permission: string) => rbac.revokeRolePermission(ctx, actor, role, permission),
    // --- staff & users
    createStaff: (actor: Actor, phone: string) => users.createStaff(ctx, actor, phone),
    setUserStatus: (actor: Actor, userId: string, status: "ACTIVE" | "SUSPENDED" | "CLOSED", reason: string) => users.setUserStatus(ctx, actor, userId, status, reason),
    getUserSummary: (actor: Actor, userId: string) => users.getUserSummary(ctx, actor, userId),
    // --- MFA (staff)
    beginTotpEnrollment: (actor: Actor) => mfa.beginTotpEnrollment(ctx, actor),
    confirmTotpEnrollment: (actor: Actor, code: string) => mfa.confirmTotpEnrollment(ctx, actor, code),
    verifyTotp: (actor: Actor, code: string) => mfa.verifyTotpCode(ctx, actor, code),
    verifyRecoveryCode: (actor: Actor, code: string) => mfa.verifyRecoveryCode(ctx, actor, code),
    regenerateRecoveryCodes: (actor: Actor) => mfa.regenerateRecoveryCodes(ctx, actor),
    // --- MFA recovery (admin-assisted)
    requestMfaRecovery: (actor: Actor, targetUserId: string, reason: string) => recovery.requestMfaRecovery(ctx, actor, targetUserId, reason),
    approveMfaRecovery: (actor: Actor, requestId: string, reason: string) => recovery.approveMfaRecovery(ctx, actor, requestId, reason),
    rejectMfaRecovery: (actor: Actor, requestId: string, reason: string) => recovery.rejectMfaRecovery(ctx, actor, requestId, reason),
    completeMfaRecovery: (actor: Actor, requestId: string) => recovery.completeMfaRecovery(ctx, actor, requestId),
  };
}

export type Identity = ReturnType<typeof createIdentity>;
