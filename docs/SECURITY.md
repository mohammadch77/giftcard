# SECURITY.md

Status: **DRAFT v0.1 — Phase 1.** Describes the intended security design. Nothing is implemented or verified yet; no claim of production readiness.

## 1. Assets and threat model (what is worth attacking)
| Asset | Why | Primary threats |
|---|---|---|
| Unsold codes / account credentials | direct cash value | DB leak, SQL injection, insider/admin abuse, backup theft, API over-exposure |
| Wallet balances & ledger | money | double-spend via race, replayed callbacks, admin tampering, IDOR |
| Customer accounts | purchased secrets, wallet | credential stuffing, OTP/SMS abuse, session theft |
| Gateway/supplier credentials | financial control | secret leak, SSRF, logs |
| Admin panel | god-mode | phishing, weak auth, privilege creep |
| Reputation/chargeback exposure | fraud using stolen cards | carding, automated purchases |

## 2. Secrets & encryption

### 2.1 Envelope encryption (codes, account credentials, supplier credentials, delivery secrets)
- Per-secret random 256-bit **DEK**; payload encrypted with **AES-256-GCM**, unique 96-bit nonce, **AAD = table + row id + kind** (prevents moving ciphertext between rows).
- DEK wrapped by a **KEK** that is **not stored in the database** (loaded from a root-only file or secret store on the server; never in `NEXT_PUBLIC_*`, never in the repo, never in logs). Implement with Node `crypto`; no hand-rolled primitives.
- `kek_version` stored per row. **Rotation:** introduce KEK v(n+1) → background job re-wraps DEKs (payloads untouched) → retire v(n). Rotation runbook and a rotation test are required before launch.
- KEK backup: offline, split custody (e.g. Shamir shares) **[OPEN: operational decision]**. Losing the KEK = losing all codes; this is the #1 operational risk.
- No cloud KMS assumed (availability from Iran uncertain). Interface `KeyProvider` allows a KMS/HSM later.

### 2.2 Duplicate-detection hash
`HMAC-SHA256(pepper, normalised_code)`, with a pepper **distinct from the KEK**, stored outside the DB. A plain unsalted hash of a short code is brute-forceable, so a keyed hash is required. Pepper versioning column to allow rotation (re-hash during decrypt-capable maintenance window).

### 2.3 Other secrets
Passwords: **argon2id** (tuned params, per-hash salt). OTPs / reset tokens / session tokens: stored hashed, short TTL, single-use. Env secrets validated at boot by a Zod schema; process refuses to start if missing. `.env*` in `.gitignore`; secret scanning in CI.

## 3. Authentication & sessions
- Login method **[OPEN]** (phone+OTP is the local norm; email+password also in scope). Either way: rate limits per IP *and* per identifier, generic error messages, constant-time comparison, lockout/backoff, OTP resend cooldown, SMS-pumping cost cap.
- Server-side sessions: random 256-bit token, stored hashed; cookie `HttpOnly; Secure; SameSite=Lax; Path=/`, `__Host-` prefix. Rotate on login/privilege change; absolute + idle timeouts; user can list/revoke sessions.
- **Admin:** mandatory TOTP 2FA, shorter idle timeout, re-authentication (step-up) for sensitive actions (reveal codes, ledger adjustment, credential change, role change), optional IP allowlist.
- Password reset: single-use hashed token, 15-minute TTL, invalidates all sessions.

## 4. Authorization
- RBAC with granular permission codes (§ DATABASE_DESIGN §3); deny by default; checks in the application layer entry points, not in UI.
- Object-level checks on every customer-facing read/write (`order.user_id = actor.id`) — IDOR is the most likely real-world bug; add automated authorization tests per endpoint (Phase 6) and consider PostgreSQL RLS as defence in depth.
- Separation of duties: finance actions, code/credential access, supplier credentials and user/role management are different permissions. Large manual ledger adjustments require a second approver **[OPEN]**.
- Public product APIs return only public columns via explicit DTOs/select lists — `digital_codes`, `delivery_secrets`, supplier tables are never reachable from public queries.

## 5. Purchased-secret exposure rules
1. Plaintext only after payment `SUCCEEDED` **and** `order.user_id = session.user_id` (or admin with `codes.reveal`).
2. Each reveal writes `secret_access_log` *before* returning data; rate limited; optional step-up (OTP) for re-viewing old purchases.
3. Responses containing secrets: `Cache-Control: no-store`; never in URLs, query strings, logs, error reports, emails or SMS (send "your order is ready", not the code, unless product policy decides otherwise **[OPEN]**).
4. UI masks by default with explicit reveal; no secrets in client-side state beyond the reveal view; no analytics scripts on those pages.
5. Account-type products: store only the minimum (credentials + required delivery notes); no unnecessary personal data.

## 6. Payment security
- **Never trust the browser redirect.** Success only after server-to-server verification (or verified signed webhook where the gateway supports it) with amount and reference matching the stored payment.
- Callback endpoint: strict input validation, no state change before verification, idempotent via `payment_events` unique key + conditional state update, rate limited, never reveals internal state.
- No card data ever stored or logged. Gateway credentials in encrypted settings/env.
- Amount mismatch, unknown reference, or repeated failures → `NEEDS_REVIEW` + alert.
- Gateway-specific signature/verification scheme: **unknown until documentation is provided**; nothing is assumed.

## 7. Supplier security
Credentials encrypted (§2.1) and only decrypted inside the adapter call; request/response logs stored **redacted** (headers/keys stripped, codes masked); outbound calls restricted to configured hosts (SSRF guard — no user-controlled URLs), timeouts and circuit breaker; idempotency keys; reconciliation job detects drift between local and supplier state.

## 8. Web application hardening
| Area | Control |
|---|---|
| SQLi | parameterised queries only; raw SQL via tagged template with bound params; lint rule against string-concatenated SQL; least-privilege DB role |
| XSS | React escaping; never `dangerouslySetInnerHTML` on user/admin HTML without sanitisation (DOMPurify server-side); strict CSP with nonces; ticket messages treated as plain text/markdown-sanitised |
| CSRF | SameSite cookies + Origin/Host checking on all mutating routes/Server Actions + CSRF token for non-Next endpoints |
| Clickjacking / headers | `frame-ancestors 'none'`, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` |
| Rate limiting | login, OTP, register, password reset, coupon validation, checkout, code reveal, ticket creation, search |
| File uploads (tickets, images) | size/type allowlist by magic bytes, re-encode images, random storage names, store outside web root, download via authenticated route with `Content-Disposition`, optional AV scan, no SVG from users |
| Errors | generic client messages; detailed errors only in server logs with correlation id; no stack traces to clients |
| Dependencies | lockfile, `npm audit`/OSV in CI, Dependabot-style updates, minimal dependency policy |
| Logging | redaction list (password, token, code, authorization, cookie, card-like numbers); logs never contain secrets |

## 9. Database security
- Separate roles: `migrator` (DDL), `app` (DML; **no UPDATE/DELETE on ledger/movements/audit tables**), `readonly_reports`. Network-restricted, TLS.
- Triggers enforce append-only and state machines even if app code is compromised (not against a DBA/superuser — mitigated by audit log shipping off-box).
- **Backups:** automated encrypted base backups + WAL (PITR); backup encryption key separate from the KEK; periodic **restore drills** with measured RPO/RTO; backups contain ciphertext only (useless without KEK).

## 10. Audit logging
Append-only `audit_logs` (actor, action, entity, before/after with secrets redacted, ip, ua, request id). Must-log events: login/2FA changes, role/permission changes, all admin mutations, code import/void/reveal, ledger adjustments, refund decisions, settings/credential changes, manual state overrides. Logs shipped off-host; optional hash chain **[OPEN]**.

## 11. Fraud & abuse controls (v1 baseline)
- New-account limits: low per-order and per-day spend caps that rise with account age/verified phone/successful history; configurable in `system_settings`.
- Velocity rules: orders/hour per user, IP, device fingerprint; repeated payment failures (e.g. ≥3/hour) → challenge/hold; many accounts from one IP/phone prefix.
- High-value or first-order-of-high-risk-product → `ON_HOLD` manual review queue with reason codes.
- Wallet top-up then immediate full spend on high-value codes flagged.
- Admin dashboard: suspicious-activity feed, flag/unflag users, block list (phone, IP, card-hash from gateway if provided).
- Don't deliver auto-codes to flagged orders until cleared.
Thresholds are **[OPEN]** business inputs; defaults will be conservative and configurable.

## 12. Legal / regulatory / licensing — items requiring review before launch (no conclusions drawn here)
- Legal basis and licensing for selling foreign gaming gift cards, subscriptions and accounts to customers in Iran, including **international sanctions and platform terms of service** (Steam, PlayStation, Xbox, Spotify, Discord, etc. — whether resale or regional use is permitted, and the supply-chain provenance of codes).
- Domestic business registration, **e-commerce licensing / e-Namad (electronic trust symbol)** and any requirements imposed by payment gateways/PSPs (Shaparak-connected providers) for approval, including allowed product categories.
- Tax and accounting treatment (VAT, revenue recognition) and record retention.
- Consumer-protection requirements: refund/return policy for digital goods, mandatory terms, privacy policy, data retention.
- Personal-data protection obligations and data-residency expectations; SMS provider regulations.
- Policy on "game accounts": account-sharing may violate publisher ToS; chargeback/ban risk for customers.
Owner: business owner + qualified local counsel/accountant. Tracked in `OPEN_QUESTIONS.md`.

## 13. Pre-launch security checklist (to be completed in Phase 6)
KEK/pepper rotation drill · restore drill · authorization test suite · concurrency/stress tests green · dependency audit · CSP/headers scan · pen-test or independent review of payment + secret-reveal paths · incident response runbook (leaked code batch, compromised admin, gateway outage).
