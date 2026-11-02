# TOTP_DESIGN.md — design only (NOT implemented)

Status: **design; DECISION B14 = APPROVED (2026-11-03): MFA (mobile OTP + TOTP) is mandatory for all administrators and staff before V1 release; step-up for sensitive operations; single-use audited recovery codes; restricted, auditable MFA recovery; not mandatory for ordinary customers. Implementation: step 2b-3.** Per instruction, TOTP is documented and deliberately **not** built in step 2b-1b because it has no consumer yet (it depends on user accounts, sessions and an admin concept that arrive in step 2b-3). Writing it now would create unused security code.

## 1. Questions asked, and answers
| Question | Answer |
|---|---|
| Is it for administrators or customers? | **Administrators / staff only** (accounts holding permissions such as `codes.reveal`, `ledger.adjust`, `refunds.approve`, `orders.resolve_hold`, `suppliers.credentials.write`, role management). **Not for customers in V1:** customers log in with mobile OTP (D3). An optional customer TOTP is out of V1 scope. |
| What product/security need does it cover? | Mobile-OTP (SMS) alone is a weak second factor for privileged accounts: SIM-swap, SMS interception, SMS-provider outage and SMS-pumping abuse (SECURITY §3). Staff accounts can reveal gift-card codes and move money, so they need a factor that does not depend on the SMS channel. It also gives a **step-up** factor for sensitive actions without sending an SMS each time. Concrete V1 uses: admin login second factor; step-up before code reveal, ledger adjustment, refund override, role/permission change. |
| Can it be independent of mobile OTP? | **As a primitive, yes; as a flow, only partly.** Verifying a TOTP is a pure function of (secret, time) and does not use the SMS/OTP module. But TOTP is a *second* factor: it needs a first factor to establish who is asking. In V1 that first factor is the mobile OTP login (D3), so the admin flow is "phone OTP → TOTP". Enrollment/binding needs `users` and sessions (step 2b-3). TOTP must **not** become the only factor (a stolen secret would be a full account takeover) and must not be required for ordinary customers. |

## 2. Decision (B14, final)
TOTP is **mandatory for every administrator/staff account before the V1 release**, with mobile OTP as first factor, step-up authentication for sensitive operations, single-use audited recovery codes and a restricted, auditable recovery process. It is implemented inside step **2b-3** (identity), reusing the 2b-1b envelope encryption. It is not required for ordinary customers in V1.

## 3. Proposed design (for 2b-3, if B14 = yes)
- **Algorithm:** RFC 6238 (HMAC-SHA-1 as universally supported by authenticator apps, 6 digits, 30 s step); verify the current step ±1; implemented with `node:crypto` (no dependency, P-8) and tested against the RFC 6238 test vectors.
- **Secret:** 160-bit random, shown once as `otpauth://` URI/QR at enrollment; stored **only** sealed with `sealSecret` (AAD = table `admin_totp`, row = user id, kind `totp_secret`), never logged, never returned after enrollment.
- **Enrollment:** only for an authenticated admin session; the secret becomes active after one correct code (confirm step); enrollment and any reset are audited.
- **Replay protection:** store `last_used_step` per user; a code for a step ≤ last used is rejected (one-time use within the window); update with a conditional UPDATE to be safe under concurrency.
- **Brute force:** per-user and per-IP rate limits (the Postgres limiter from 2b-3), lock-out/back-off after repeated failures, generic error messages.
- **Recovery:** single-use recovery codes (generated at enrollment, stored hashed, shown once). Lost device = reset performed by a second privileged admin (four-eyes, B10) with a mandatory reason, audited; the last super-admin lockout is handled by an offline operator procedure (DB-level, documented in the runbook).
- **Sessions:** a TOTP-verified admin session carries an `mfa_at` timestamp; sensitive actions require `mfa_at` within N minutes (step-up).
- **Data model (2b-3):** `admin_totp(user_id PK, sealed secret columns, confirmed_at, last_used_step, created_at)` and `admin_recovery_codes(user_id, code_hash, used_at)`; both registered in the grant registry (no delete grant, P-7).
- **Tests planned:** RFC vectors; ±1 window and clock-skew edges with `Clock`; replay (same code twice, 50 concurrent submissions → one success); brute-force limiter; sealed-secret canary never in DB/logs; enrollment/confirm/reset flows; IDOR (admin cannot read another's state); recovery-code single use.
- **Dependencies:** none expected.

## 4. Risks if skipped
Privileged accounts protected only by SMS OTP: SIM-swap or SMS-provider compromise would expose code reveal and ledger/refund actions. Mitigations without TOTP: mandatory step-up OTP per sensitive action, short admin sessions, IP allow-list, four-eyes on money actions, alerting.
