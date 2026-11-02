# PHASE_2B_2_NOTES.md — Audit and Ledger (step 2b-2)

Scope (authorised 2026-11-03): chart-of-accounts design, asset/liability/revenue/expense accounts, double-entry ledger, transactions and entries, balance control at commit, append-only recording, idempotent financial operations, audit linked to financial operations, protection against unauthorised insert/change, account-balance reports, financial and concurrency tests on real PostgreSQL. **Not built:** full wallet, payment adapter, orders/checkout, real gateway, any real crypto provider, any later step. **Not decided:** revenue-recognition timing (no setting exists), tax, fees, COGS. Design reference: `LEDGER_DESIGN.md`.

## Also recorded this round (docs)
- **B14 = APPROVED** (mandatory MFA for all administrators/staff; mobile OTP + TOTP; step-up; audited single-use recovery codes; restricted audited MFA recovery; not required for customers). Full TOTP flow → step **2b-3**. B14 removed from OPEN_QUESTIONS.
- **SEC-KAT opened** as a security task: independent known-answer tests (AES-256-GCM, HMAC, AAD, key versions/rotation, auth-tag failures) before any production KeyProvider; gates production approval of the crypto, not the ledger. Listed in CRYPTO_DESIGN §8, DECISIONS, OPEN_QUESTIONS.

## What was added
| Area | Files |
|---|---|
| Audit module | `src/modules/audit/{domain/types,application/audit-service,infra/schema,index}.ts` — `recordAudit(tx, …)` (validated, redacted, size-limited, same-transaction), `listAudit` |
| Ledger module | `src/modules/ledger/{domain/chart-of-accounts,domain/posting,domain/posting-rules,application/ledger-service,infra/schema,index}.ts` — `ensureAccount`, `post`, `reverse`, `getBalance`, `trialBalance`, `verifyIntegrity`, `getTransaction`, proposed chart, 5 posting-rule builders |
| Migrations | `0007_audit_ledger_tables` (Drizzle-generated), `0008_audit_guards`, `0009_ledger_guards` (hand-written: FKs, append-only triggers, balance-projection guard, same-transaction guard, deferred balance/shape/mirror checks, integrity + trial-balance functions, grants registration). **No prototype SQL was promoted** (re-authored and extended). |
| Errors | `LEDGER_INVALID`, `LEDGER_UNBALANCED`, `LEDGER_ACCOUNT_NOT_FOUND`, `LEDGER_ACCOUNT_CONFLICT`, `LEDGER_REVERSAL_INVALID`, `INSUFFICIENT_FUNDS`, `AUDIT_INVALID` |
| Guards | ESLint: no `fetch`/`http`/`net` in ledger/audit code (no external calls inside DB transactions). Matrix: **`ledger → audit`** (ARCH-1). |
| DB pools | per-client `error` listener (a connection killed while checked out no longer crashes the process; found by the mid-transaction-kill test) |
| Docs | `LEDGER_DESIGN.md`, this file; DECISIONS, OPEN_QUESTIONS, CRYPTO_DESIGN (§8), TOTP_DESIGN, SECURITY, PLAN, DATABASE_DESIGN updated |
No new dependency.

## Verification (2026-11-03; PostgreSQL 16.15; Node 22.23)
| Suite | Result | New in this step |
|---|---|---|
| unit | **150 passed** | ledger-domain 23 |
| db (real PostgreSQL) | **126 passed** | ledger-sql 28, ledger-service 18, audit 6 |
| concurrency (real PostgreSQL, 5 consecutive stable runs of the ledger file) | **21 passed** | ledger 10 |
**Application tests total: 297** (150 + 126 + 21; was 212). lint, typecheck, `arch` (72 modules / 134 deps), `db:drift`, `npm audit` and `npm audit --omit=dev` (0 vulnerabilities), `next build`: clean.
**SQL prototype regression (separate, design reference only): 40 passed, 0 failed** — not evidence of readiness.

### Acceptance scenarios requested → where they are proven
| Scenario | Evidence |
|---|---|
| Balanced and unbalanced transactions | ledger-sql: multi-entry balanced commit; unbalanced / one-sided / entry-less rejected at COMMIT (`PL001`) with **nothing left behind**; ledger-domain: friendly validation errors |
| Prevention of unbalanced posting | domain check first, PostgreSQL deferred trigger as backstop (raw SQL bypassing the service) |
| Concurrent financial postings | **S2: 500 parallel debits on a 1,500,000-Rial wallet → exactly 150 succeed, 350 `INSUFFICIENT_FUNDS`, balance exactly 0, audit rows == ledger transactions**; mixed random credits/debits → final balance = initial + credits − successful debits; 50 parallel `ensureAccount` → 1 account, 1 audit row |
| Duplicate request, same idempotency key | 100 parallel identical postings → **1 transaction, 1 audit row, balance changed once**; same key with different amounts → one winner, rest `IDEMPOTENCY_CONFLICT` |
| Reversal | exact mirror restores balances (audited with reason); wrong amount/account/direction rejected (`PL002`); once only; reversal of a reversal refused; reversal of a spent top-up → `INSUFFICIENT_FUNDS`, nothing changes; 20 concurrent reversals with different keys → exactly 1 succeeds; 20 with the same key → 1 reversal, 19 replays |
| No direct UPDATE/DELETE | owner/superuser: `23001` for UPDATE, DELETE, TRUNCATE on accounts, transactions, entries, audit; application role: `42501`; projection writes rejected for everyone (`PL004`) |
| Ledger vs balance projection | trial balance computed from entries equals the projection for every account; `verifyIntegrity()` empty after every scenario; 30 reports taken while 150 postings run were all consistent snapshots |
| Failure in the middle of a transaction | FK failure mid-posting rolls back audit row + transaction + entries + projection; exception after `post()` rolls back everything incl. account creation; **connection killed with `pg_terminate_backend` mid-transaction → nothing persisted**; insufficient-funds inside an outer transaction rolls back only that posting (savepoint) and the outer transaction continues |
| Audit for sensitive operations | every ledger transaction links (NOT NULL FK) to an audit row with the right action/entity; admin adjustment and reversal require a reason that lands in the audit metadata; secrets in audit payloads are redacted (tested) |
| Concurrency with several transactions | 300 random opposing transfers among 12 accounts → **no deadlock**, all succeed, totals conserved, ledger consistent |
| Tamper detection | with triggers disabled (superuser, replica mode) the integrity function **detects** drift, unbalanced transactions, mirror mismatch, audit mismatch and floor breach |
All of the above ran as the **least-privilege application role** (INSERT/SELECT only) except the explicit superuser tamper/permission tests.

## Findings during implementation (all fixed)
1. **Race found by the concurrency suite:** two concurrent reversals with the *same* key could hit the one-reversal unique index before the idempotency-key index and fail with "already reversed" instead of replaying (1 flaky failure in 3 runs). `write()` now re-checks for a same-key replay in that case; 5 consecutive clean runs afterwards.
2. A connection killed while checked out emitted an unhandled `ECONNRESET`; pools now attach a per-client error listener (also a production fix).
3. My early SQL tests used invalid reference formats / left a pooled connection in an aborted transaction, and I mistakenly tried to forge a below-floor *projection* (the CHECK still blocks it even with triggers off — so the check was rewritten to forge it via entries, which is what is detected).
4. `TRUNCATE` on a table referenced by a foreign key fails earlier than the guard trigger; tests use `CASCADE` so the guard is what rejects.

## NOT tested / not covered (explicit)
- Superuser/owner forgery is **detected, not prevented** (limit of PostgreSQL); off-box audit shipping and backups are Phase 6.
- A compromised application role can still insert balanced, audited transactions; no behavioural anomaly detection exists.
- No tax/fee/VAT/COGS/revenue-recognition postings (undecided, by design); no order-payment, delivery, refund or settlement rules; no multi-currency.
- Reports scan all entries: no performance, snapshot or period-closing work; no load/soak test beyond the 500/300-operation runs.
- No hash chain on the audit log (T4 open); audit ordering relies on the identity column.
- PostgreSQL versions other than 16 untested; managed-database privilege behaviour untested.
- Reversal is full-transaction only; partial reversals/refunds will be explicit postings in later steps.
- Wallet is **not** built: only the ledger accounts, floors and 5 posting rules it will use; the wallet module's API, limits (B5) and top-up flow are step 2b-6.
- The 57P01 "administrator command" log lines in concurrency output come from tests dropping databases with live connections; they are now logged instead of crashing, and harmless.

## Remaining risks
- **D10 (accountant) is a launch gate:** chart, recognition timing, VAT, COGS and fees are undecided; the ledger is append-only, so a wrong chart means correcting by new postings, not edits.
- **SEC-KAT** remains open for the cryptography; **D8** remains open for key custody.
- The `ledger → audit` matrix change (ARCH-1) needs your acknowledgement.
- Audit/ledger tables grow without bound (P-7 forbids deletion); archival/partitioning policy is needed before scale.
- Deferred balance trigger runs per entry (≤ 50 per transaction) — fine now, revisit if large batch postings appear.
