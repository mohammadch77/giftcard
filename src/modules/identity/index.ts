/**
 * Module: identity — mobile-OTP authentication, sessions, RBAC, staff MFA (TOTP), step-up, recovery.
 * PUBLIC API of this module: the only file other code may import (enforced by dependency-cruiser).
 * Tables are private (infra/schema.ts); other modules receive an `Actor` and call `authorize`.
 */
export const MODULE_NAME = "identity" as const;
export { createIdentity } from "./application/identity";
export type { Identity, IdentityDeps } from "./application/identity";
export { bootstrapFirstOwner } from "./application/user-service";
export type { UserSummary } from "./application/user-service";
export type { MfaResult } from "./application/mfa-service";
export { PermissionCatalog, IDENTITY_PERMISSIONS, SYSTEM_ROLES } from "./domain/permissions";
export type { PermissionDef } from "./domain/permissions";
export { DEFAULT_IDENTITY_CONFIG } from "./domain/config";
export type { IdentityConfig } from "./domain/config";
export { normalizePhone, tryNormalizePhone, maskPhone } from "./domain/phone";
export { toAuditActor } from "./domain/types";
export type { Actor, MfaState, RequestOtpResult, SecurityContext, SessionGrant, UserKind, UserStatus, VerifyOtpResult } from "./domain/types";
