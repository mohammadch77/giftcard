# PHASE_2B_3_NOTES.md — Identity (implemented, CI-confirmed: commit 8c0cd6f, run #7 success)

Scope authorised as a whole (DECISIONS 2026-11-04). HTTP routes, real cookies, CSRF/Origin stay in Phase 4.

## 1. What exists
| Piece | Location |
|---|---|
| Rate limiter (PostgreSQL, atomic fixed window) | `src/platform/ratelimit`, table `rate_limit_counters` |
| `SmsProvider` port, `NullSmsProvider` (fail closed), `TestSmsProvider` (testing/), guarded factory | `src/platform/sms`, `src/platform/composition/sms-provider.ts` |
| Identity module (private tables, one public `index.ts`) | `src/modules/identity` |
| Tables + guards | migrations `0010_identity_tables.sql`, `0011_identity_guards.sql` (forward-only; `0000–0009` untouched, pinned by hash test) |
| First-owner bootstrap | `npm run identity:bootstrap-owner -- --phone 09…` |
| SEC-KAT vectors | `tests/unit/crypto-kat.test.ts` |

Public API: `createIdentity({ db, keys, sms, clock?, config?, catalog?, issuer? })` →
`requestOtp, verifyOtp, authenticate, logout, revokeOwnSessions, revokeSessionsOfUser, authorize, can, grantRole, revokeRole, grantRolePermission, revokeRolePermission, createStaff, setUserStatus, getUserSummary, beginTotpEnrollment, confirmTotpEnrollment, verifyTotp, verifyRecoveryCode, regenerateRecoveryCodes, requestMfaRecovery, approveMfaRecovery, rejectMfaRecovery, completeMfaRecovery`; plus `bootstrapFirstOwner`, `PermissionCatalog`, `toAuditActor`, phone helpers and types. Other modules receive an `Actor` and call `authorize`; they never touch identity tables (architecture test).

## 2. Data model (all new; no effect on existing data)
`users` (kind CUSTOMER|STAFF immutable; status machine ACTIVE/SUSPENDED/CLOSED with history + required actor; `authz_version` bumped only by SECURITY DEFINER triggers) · `user_identities` (E.164 CHECK, unique value, one primary) · `otp_challenges` (keyed HMAC digest, status machine, partial-unique "one verifiable challenge per phone") · `user_sessions` (SHA-256 token digest, idle/absolute expiry, MFA and step-up timestamps, set-once revocation) · `roles`, `role_permissions`, `user_roles` (soft revoke, staff-only trigger, no-self-grant CHECK) · `admin_totp` (sealed secret, status machine, `last_used_step`) · `admin_recovery_codes` (keyed digest, set-once used/superseded) · `mfa_recovery_requests` + history (state machine, CHECKs: three distinct people, reasons ≥ 10 chars) · platform `rate_limit_counters`.
Grants: every table registered; **no DELETE anywhere**, UPDATE only on named columns (e.g. the app role cannot touch `authz_version`, `kind`, expiry columns).

## 3. Flows (summary)
- **OTP:** limits (cooldown from DB, 5/h per phone, optional per-client, global) → keyed digest (fails closed without a KeyProvider) → tx: supersede + insert → commit → SMS → `SENT` / `FAILED` / stays `PENDING` (unknown). Verify: per-phone limit → one conditional `attempts+1` UPDATE (row lock serialises verifiers) → constant-time compare → `CONSUMED` → find/create user under an advisory lock → session. Every negative outcome is the same `INVALID`.
- **Sessions:** 256-bit random token, digest stored. `authenticate` = 1 indexed query (session ⨝ user), `last_seen_at` touched at most once per 60 s. Staff sessions start without MFA; TOTP or recovery code completes MFA and **rotates the token**.
- **RBAC:** permissions are code (`PermissionCatalog`, module-owned, no wildcards); roles are data. `authorize` order: unknown/customer → deny; no MFA → `AUTH_MFA_REQUIRED`; missing permission → `AUTH_FORBIDDEN`; sensitive and no step-up in the last 5 min → `AUTH_STEP_UP_REQUIRED`. Permission sets are cached in a bounded LRU keyed by `(userId, authz_version)`; any role change bumps the version in the database, so revocation applies on the next request.
- **Escalation rules:** no self grant/revoke; an actor can grant only roles whose permissions they all hold; cannot modify a role they hold; the last active owner cannot be demoted or suspended.
- **TOTP:** RFC 6238 (SHA-1, 6 digits, 30 s, ±1 step), 160-bit secret sealed with the envelope (AAD = table, row, kind), replay blocked by a conditional `last_used_step` update, 10 attempts / 5 min. First enrolment needs a login ≤ 15 min old; replacing an authenticator needs step-up.
- **Recovery codes:** 10 × 80-bit codes, shown once, stored as keyed digests, single use by conditional UPDATE, 5 attempts / 15 min, regeneration (step-up) supersedes the old set under a per-user lock.
- **MFA recovery:** request → approve (different admin, reason) → complete; each step needs `identity.mfa.reset` + step-up; requests/approvals expire after 24 h; completion retires the authenticator and codes (status changes, no deletes), revokes all sessions, enqueues `identity.mfa_recovery.completed` (outbox) for the future notifications module.

## 4. Operations
- **Bootstrap:** `npm run identity:bootstrap-owner -- --phone 09123456789` with the migrator database URL. Creates one STAFF user + `owner` role, prints only the user id, refuses if an owner exists. The owner then logs in by OTP and enrols TOTP. No default credential exists.
- **Locked-out last owner (break-glass, offline):** requires direct database access by the operator and is itself an incident: (1) record the incident; (2) as the migrator role run `UPDATE admin_totp SET status='REPLACED', replaced_at=now() WHERE user_id=… AND status='ACTIVE'` and `UPDATE user_sessions SET revoked_at=now(), revoked_reason='BREAK_GLASS' WHERE user_id=… AND revoked_at IS NULL`; (3) insert an `audit_logs` row describing who/why; (4) the owner re-enrols at next login. No application path exists on purpose.
- **Production:** `KEY_PROVIDER=none` and `SMS_PROVIDER=none` fail closed — OTP requests throw `KEY_PROVIDER_NOT_CONFIGURED` / `SMS_PROVIDER_NOT_CONFIGURED` and TOTP cannot be enrolled. This is deliberate until D8 + SEC-KAT on a real provider and X2.

## 5. Tests (real PostgreSQL, least-privilege app role)
Unit: phone, TOTP (RFC 6238/4226/4648 vectors), tokens, catalog/roles, SMS factory, SEC-KAT. DB: OTP/SMS failure modes, sessions, grants/triggers, RBAC, step-up matrix, TOTP, recovery codes, MFA recovery, audit/secret hygiene. Concurrency: limiter, 50 parallel OTP verifies, wrong-guess flood, TOTP replay, recovery code single use, logout race. Regression/architecture: migration hashes `0000–0009`, public-export baselines (audit, ledger, platform), identity data ownership, dependency matrix.

## 6. Retention (unresolved, RET-1)
Nothing is deleted or purged (P-7). Sessions, challenges, counters, recovery requests and audit rows grow unbounded until a retention policy is decided. Indexes keep lookups constant-time (unique digest, partial active indexes, `(bucket, window)` PK).

## 7. Known limits / residual risks
- **Phone ownership is the first factor** (SIM-swap risk); staff are protected by TOTP, customers only by OTP in V1 (B14). Sensitive customer operations will need step-up when they exist.
- **First enrolment window:** between staff creation and first TOTP enrolment, whoever controls the phone can enrol. Mitigations: staff are created by an audited, step-up-gated action; enrolment needs a fresh login; the account has no role power until MFA completes. Consider enrolment invitations in Phase 4.
- **Unknown SMS outcome** keeps the code verifiable for ≤ 2 min; accepted.
- `idle` expiry is accurate to the 60 s touch interval.
- Rate-limit counters are per-window (fixed), so a burst at a window edge can reach 2× the limit; the DB-side cooldown and attempt caps still bound OTP guessing.
- `clientKey` (per-client send limit) must be supplied by the Phase 4 HTTP layer (derived from the real client address); until then only phone and global limits apply.
- The TOTP secret and OTP digest depend on a KeyProvider; D8/SEC-KAT remain open for production.
