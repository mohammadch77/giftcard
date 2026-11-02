import { sql } from "drizzle-orm";
import { bigint, boolean, check, customType, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Identity tables — private to the identity module (no other module may import this file).
 * Cross-module FKs (none needed here) would be created in SQL (P-1). Secrets are never stored in the
 * clear: OTP codes and recovery codes as keyed HMACs, session tokens as SHA-256 of 256-bit randoms,
 * the TOTP secret as an AES-256-GCM envelope. Business invariants are enforced by triggers in 0011.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    /** Bumped by triggers whenever the user's roles/permissions change (cache invalidation key). */
    authzVersion: bigint("authz_version", { mode: "number" }).notNull().default(0),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [check("users_kind_valid", sql`${t.kind} in ('CUSTOMER','STAFF')`), check("users_status_valid", sql`${t.status} in ('ACTIVE','SUSPENDED','CLOSED')`)],
);

export const userStatusHistory = pgTable("user_status_history", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  entityId: uuid("entity_id").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  actorId: text("actor_id"),
  reason: text("reason"),
  occurredAt: ts("occurred_at").notNull(),
});

export const userIdentities = pgTable(
  "user_identities",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id),
    type: text("type").notNull(),
    value: text("value").notNull(),
    isPrimary: boolean("is_primary").notNull().default(true),
    verifiedAt: ts("verified_at"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check("user_identities_type_valid", sql`${t.type} in ('PHONE')`),
    check("user_identities_phone_e164", sql`${t.type} <> 'PHONE' or ${t.value} ~ '^\\+989[0-9]{9}$'`),
    uniqueIndex("user_identities_type_value_uq").on(t.type, t.value),
    uniqueIndex("user_identities_primary_uq").on(t.userId, t.type).where(sql`${t.isPrimary}`),
  ],
);

export const otpChallenges = pgTable(
  "otp_challenges",
  {
    id: uuid("id").primaryKey(),
    purpose: text("purpose").notNull().default("LOGIN"),
    phone: text("phone").notNull(),
    codeDigest: bytea("code_digest").notNull(),
    hmacVersion: integer("hmac_version").notNull(),
    status: text("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull(),
    createdAt: ts("created_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
    sentAt: ts("sent_at"),
    consumedAt: ts("consumed_at"),
  },
  (t) => [
    check("otp_challenges_status_valid", sql`${t.status} in ('PENDING','SENT','CONSUMED','SUPERSEDED','FAILED','LOCKED')`),
    check("otp_challenges_phone_e164", sql`${t.phone} ~ '^\\+989[0-9]{9}$'`),
    check("otp_challenges_digest_len", sql`octet_length(${t.codeDigest}) = 32`),
    check("otp_challenges_attempts", sql`${t.attempts} >= 0 and ${t.maxAttempts} between 1 and 10`),
    // At most ONE verifiable challenge per phone: makes "latest code wins" a database guarantee.
    uniqueIndex("otp_challenges_active_phone_uq").on(t.phone).where(sql`${t.status} in ('PENDING','SENT')`),
    index("otp_challenges_phone_created_idx").on(t.phone, t.createdAt.desc()),
    index("otp_challenges_expires_idx").on(t.expiresAt),
  ],
);

export const userSessions = pgTable(
  "user_sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id),
    /** SHA-256 of the 256-bit random token. The token itself is never stored. */
    tokenDigest: bytea("token_digest").notNull(),
    createdAt: ts("created_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull(),
    idleSeconds: integer("idle_seconds").notNull(),
    idleExpiresAt: ts("idle_expires_at").notNull(),
    absoluteExpiresAt: ts("absolute_expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    revokedReason: text("revoked_reason"),
    mfaVerifiedAt: ts("mfa_verified_at"),
    mfaMethod: text("mfa_method"),
    stepUpAt: ts("step_up_at"),
    ipPrefix: text("ip_prefix"),
    userAgent: text("user_agent"),
  },
  (t) => [
    check("user_sessions_digest_len", sql`octet_length(${t.tokenDigest}) = 32`),
    check("user_sessions_mfa_method", sql`${t.mfaMethod} is null or ${t.mfaMethod} in ('TOTP','RECOVERY_CODE')`),
    check("user_sessions_expiry_order", sql`${t.absoluteExpiresAt} > ${t.createdAt}`),
    uniqueIndex("user_sessions_token_digest_uq").on(t.tokenDigest),
    index("user_sessions_user_active_idx").on(t.userId).where(sql`${t.revokedAt} is null`),
  ],
);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [uniqueIndex("roles_name_uq").on(t.name), check("roles_name_format", sql`${t.name} ~ '^[a-z][a-z0-9_]{1,62}$'`)],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    id: uuid("id").primaryKey(),
    roleId: uuid("role_id").notNull().references(() => roles.id),
    permission: text("permission").notNull(),
    grantedBy: uuid("granted_by").references(() => users.id),
    grantedAt: ts("granted_at").notNull(),
    revokedAt: ts("revoked_at"),
    revokedBy: uuid("revoked_by").references(() => users.id),
  },
  (t) => [
    check("role_permissions_format", sql`${t.permission} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*){1,3}$'`),
    uniqueIndex("role_permissions_active_uq").on(t.roleId, t.permission).where(sql`${t.revokedAt} is null`),
  ],
);

export const userRoles = pgTable(
  "user_roles",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id),
    roleId: uuid("role_id").notNull().references(() => roles.id),
    /** NULL only for the operator bootstrap of the first owner. */
    grantedBy: uuid("granted_by").references(() => users.id),
    grantedAt: ts("granted_at").notNull(),
    revokedAt: ts("revoked_at"),
    revokedBy: uuid("revoked_by").references(() => users.id),
  },
  (t) => [
    check("user_roles_no_self_grant", sql`${t.grantedBy} is null or ${t.grantedBy} <> ${t.userId}`),
    uniqueIndex("user_roles_active_uq").on(t.userId, t.roleId).where(sql`${t.revokedAt} is null`),
    index("user_roles_role_active_idx").on(t.roleId).where(sql`${t.revokedAt} is null`),
  ],
);

export const adminTotp = pgTable(
  "admin_totp",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id),
    status: text("status").notNull().default("PENDING"),
    /** encodeSealed(AES-256-GCM envelope, AAD = (admin_totp, id, totp_secret)). */
    secretSealed: bytea("secret_sealed").notNull(),
    lastUsedStep: bigint("last_used_step", { mode: "number" }),
    createdAt: ts("created_at").notNull(),
    confirmedAt: ts("confirmed_at"),
    replacedAt: ts("replaced_at"),
  },
  (t) => [
    check("admin_totp_status_valid", sql`${t.status} in ('PENDING','ACTIVE','REPLACED')`),
    uniqueIndex("admin_totp_active_uq").on(t.userId).where(sql`${t.status} = 'ACTIVE'`),
    uniqueIndex("admin_totp_pending_uq").on(t.userId).where(sql`${t.status} = 'PENDING'`),
  ],
);

export const adminRecoveryCodes = pgTable(
  "admin_recovery_codes",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id),
    batchId: uuid("batch_id").notNull(),
    codeDigest: bytea("code_digest").notNull(),
    hmacVersion: integer("hmac_version").notNull(),
    createdAt: ts("created_at").notNull(),
    usedAt: ts("used_at"),
    supersededAt: ts("superseded_at"),
  },
  (t) => [
    check("admin_recovery_codes_digest_len", sql`octet_length(${t.codeDigest}) = 32`),
    uniqueIndex("admin_recovery_codes_digest_uq").on(t.hmacVersion, t.codeDigest),
    index("admin_recovery_codes_user_open_idx").on(t.userId).where(sql`${t.usedAt} is null and ${t.supersededAt} is null`),
  ],
);

export const mfaRecoveryRequests = pgTable(
  "mfa_recovery_requests",
  {
    id: uuid("id").primaryKey(),
    targetUserId: uuid("target_user_id").notNull().references(() => users.id),
    requestedBy: uuid("requested_by").notNull().references(() => users.id),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("REQUESTED"),
    createdAt: ts("created_at").notNull(),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvalReason: text("approval_reason"),
    approvedAt: ts("approved_at"),
    approvalExpiresAt: ts("approval_expires_at"),
    completedBy: uuid("completed_by").references(() => users.id),
    completedAt: ts("completed_at"),
  },
  (t) => [
    check("mfa_recovery_status_valid", sql`${t.status} in ('REQUESTED','APPROVED','COMPLETED','REJECTED','EXPIRED')`),
    check("mfa_recovery_reason_len", sql`char_length(btrim(${t.reason})) >= 10`),
    check("mfa_recovery_not_self_requested", sql`${t.requestedBy} <> ${t.targetUserId}`),
    check("mfa_recovery_independent_approver", sql`${t.approvedBy} is null or (${t.approvedBy} <> ${t.requestedBy} and ${t.approvedBy} <> ${t.targetUserId})`),
    check("mfa_recovery_approval_reason", sql`${t.approvedBy} is null or char_length(btrim(coalesce(${t.approvalReason}, ''))) >= 10`),
    check("mfa_recovery_approved_fields", sql`${t.status} not in ('APPROVED','COMPLETED') or (${t.approvedBy} is not null and ${t.approvedAt} is not null and ${t.approvalExpiresAt} is not null)`),
    check("mfa_recovery_completed_fields", sql`${t.status} <> 'COMPLETED' or (${t.completedBy} is not null and ${t.completedAt} is not null)`),
    uniqueIndex("mfa_recovery_open_uq").on(t.targetUserId).where(sql`${t.status} in ('REQUESTED','APPROVED')`),
  ],
);

export const mfaRecoveryHistory = pgTable("mfa_recovery_history", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  entityId: uuid("entity_id").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  actorId: text("actor_id"),
  reason: text("reason"),
  occurredAt: ts("occurred_at").notNull(),
});
