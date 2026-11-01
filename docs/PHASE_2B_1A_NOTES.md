# PHASE_2B_1A_NOTES.md — Platform primitives (step 2b-1a)

Scope (authorised 2026-11-01): money/Rial primitives, ids, Clock, state-transition engine + history/triggers, idempotency, outbox, database roles and grants. **Not** in scope and not built: any business module, real payment, wallet, ledger, identity, operational cryptography, any provider.

## What exists now
| Area | Code | Database (migration) |
|---|---|---|
| Money / Rial (P-9) | `src/platform/money` — branded `number` `Rial`, `rial()`, `rialAggregate()`, `rialPrice()`, `addRial/subRial/sumRial/mulRial`, exact `mulDivFloor/percentFloor/basisPointsFloor` (BigInt intermediate, always floor), `floorToToman`, Rial↔Toman (`rialToToman/tomanToRial/formatToman`, the only place the units meet) | `0003`: domains `rial_amount` (0…10¹³), `rial_price` (+ multiple of 10), `rial_balance` (±(2⁵³−1)); Drizzle column types `rialAmount/rialPriceColumn/rialBalance` in `src/platform/db/types.ts` |
| Ids | `src/platform/ids` — `uuidv7(clock)` (RFC 9562, monotonic per process), `generateOrderNumber()` (unbiased, 31-symbol alphabet) | — |
| Clock (P-6) | `src/platform/clock` — `Clock`, `systemClock`; test double `ManualClock` in `clock/testing.ts` | time-dependent SQL takes `p_now` |
| Errors | `src/platform/errors` — `DomainError` with stable codes (support for the above) | — |
| Transition engine (P-3) | `src/platform/transitions` — `setTransitionContext`, `conditionalTransition` | `0002` `state_transition_rules`; `0004` `platform_enforce_transition()`, `platform_record_transition()`, `platform_attach_transition_guard(table, machine, history?, id_col, status_col, require_actor)`; SQLSTATE `PT001` invalid transition, `PT002` actor required; history tables made append-only |
| Idempotency | `src/platform/idempotency` — `withIdempotency`, `hashRequest`, `canonicalJson` | `0002` `idempotency_keys`; `0005` write-once + "complete at COMMIT" deferred trigger, no delete/truncate |
| Outbox | `src/platform/outbox` — `enqueueOutbox`, `claimOutbox`, `runOutboxOnce`; worker wiring in `src/worker/index.ts` (empty handler registry) | `0002` `outbox_events`; `0005` `outbox_claim/ack/fail` (lease, `SKIP LOCKED`, attempts, DEAD letter), transition machine `outbox_event`, immutability + no delete |
| Roles & grants (P-4) | `db/ops/roles.sql` (ops script, not a migration) | `0002` `platform_roles`, `platform_grant_registry`; `0006` `platform_register_grants()`, `platform_apply_grants()` (idempotent) |
| Guards | ESLint: no `/ 10`, `* 10` outside `src/platform/money`; no interpolated SQL; dependency-cruiser rule `no-testing-doubles-in-production` | — |
| CI | `npm audit --omit=dev`, `npm audit`, `test:concurrency` steps; `permissions: contents: read` | — |

Migrations added: `0002_platform_tables` (Drizzle-generated), `0003_money_domains`, `0004_transition_engine`, `0005_idempotency_outbox_logic`, `0006_grants_registry` (hand-written). **No prototype SQL was promoted.**

## How later steps must use the primitives (conventions)
1. **New table with a status:** seed `state_transition_rules`, create `<table>_history(id identity, entity_id <id type>, from_status, to_status, actor_id text, reason text, occurred_at timestamptz)`, call `SELECT platform_attach_transition_guard(...)` in the same migration. Change status with `conditionalTransition()` (or `UPDATE … WHERE status = :from` after `setTransitionContext`).
2. **New table at all:** call `SELECT platform_register_grants('t', mode[, update_columns])` in the migration — the test "every public table is registered" fails otherwise. Choose `append_only` for evidence/financial tables; `read_write_delete` only for operational tables (P-7).
3. **Money columns:** use `rialAmount / rialPriceColumn / rialBalance` (never plain bigint/numeric), `NOT NULL` (domains permit NULL).
4. **Idempotent request handling:** `withIdempotency(tx, …)` inside the operation's own transaction. Not for multi-phase flows with external calls.
5. **Events:** `enqueueOutbox(tx, …)` in the same transaction as the state change; handlers must be idempotent; register them in the worker registry.
6. **Time:** inject `Clock`; pass `p_now` into time-dependent SQL.
7. **Roles in production:** an operator runs `db/ops/roles.sql` as superuser, then gives `giftcard_app` LOGIN + a password out-of-band; the app connects as `giftcard_app`, migrations as the database owner.

## Verification (2026-11-01; PostgreSQL 16.15; Node 22.23)
Application test suites (Vitest, real PostgreSQL):
| Suite | Result |
|---|---|
| unit — **64 passed** | money 30, env 11, boundaries/architecture 11, ids+clock 8, request-hash util 4 |
| db — **63 passed** | transitions 18, outbox 12, grants 10, idempotency 9, migrations 7, money domains 7 |
| concurrency — **7 passed** (3 consecutive runs earlier, stable) | idempotency 3, outbox 2, transitions 2 |
| lint · typecheck · arch (53 modules / 60 deps) | clean |
| `db:drift` · `drizzle-kit generate` | no drift |
| `npm audit` and `npm audit --omit=dev` | 0 vulnerabilities |
| `next build` | success |
| migrations on a fresh PostgreSQL, plus `db/ops/roles.sql` run twice | success |
**Application tests total: 134** (64 + 63 + 7), all against a real PostgreSQL.

**SQL prototype regression (reported separately, design reference only): 40 passed, 0 failed.** It is not evidence of readiness of any commercial feature.

Concurrency results (what is actually proven): 50 parallel calls with one idempotency key → 1 execution (the rest wait, then replay); 20 parallel calls with conflicting payloads → one payload wins, rest conflict; a failing first executor → exactly one waiter takes over and the side effect happens once; 4 workers × 500 outbox events → each processed exactly once, work shared across workers; a crashed worker's 50 claimed events are recovered after lease expiry, still once; 40 rows × 6 racers (PAID vs CANCELLED) → exactly one winner per row, history has exactly one transition; 300 parallel random UPDATEs → no illegal transition recorded, history chain contiguous.

## Findings during implementation
1. `ManualClock`-driven tests exposed that `enqueueOutbox` used the real clock for `available_at`; it now takes the injected `Clock`.
2. Idle pooled-client errors (e.g. `57P01` when a database is dropped) crashed the test process: `createDatabase` now installs a pool `error` listener (also a production safety fix) that logs a code only.
3. `UPDATE … RETURNING` row order is undefined → `claimOutbox` sorts by id.
4. `percentFloor` expected value in my own test was mistyped; the implementation matched a BigInt reference over 20,000 seeded random cases.
5. The dependency-cruiser rule meant to block test doubles originally matched only a `testing/` *folder*, not the `testing.ts` file I created; its own fixture test failed, exposing a rule that would never have fired. Fixed (matches both) and covered by two fixture tests.
6. Drizzle's schema API **does** express CHECK, partial indexes and expression indexes (`coalesce(...)`) — verified (supersedes the open note in TECH_STACK).

## Deviations from PHASE_2B_PLAN §5 (2b-1a)
- Added `platform/errors` (needed by money/idempotency; tiny).
- `outbox_ack/outbox_fail` take the attempt number (stale workers cannot ack a re-claimed event) — stricter than the plan.
- Outbox `last_error` stores a classification only (`NO_HANDLER`, `Error:<Name>`, `DomainError:<CODE>`), never a message (plan said redaction would come in 2b-1b).
- Grants are driven by a registry table + idempotent function (plan said ops script + GRANT/REVOKE); roles stay out of migrations as planned.
- Worker loop is wired (polling `OUTBOX_POLL_INTERVAL_MS`, batch `OUTBOX_BATCH_SIZE`) with an empty registry.
- Config: `PAYMENT_VERIFY_GRACE_SECONDS` renamed `LATE_PAYMENT_HANDLING_WINDOW_SECONDS` (D9). Operational use of the window is deliberately **not** implemented.

## NOT tested / not covered (explicit)
- Superuser/table-owner bypass (`DISABLE TRIGGER`, `session_replication_role`) is not preventable inside PostgreSQL; only the app-role denial is tested.
- PostgreSQL versions other than 16 (local 16.15; CI `postgres:16`); managed-PostgreSQL privilege behaviour; production role creation by an operator.
- Performance/throughput of `to_jsonb(NEW)`-based triggers and of the outbox poll loop; no load or soak test; no `LISTEN/NOTIFY`.
- The worker loop itself is covered only by a manual smoke run (start/stop with migrated DB); `runOutboxOnce` is covered by tests.
- `INSERT … ON CONFLICT DO UPDATE SET status` and `COPY` against guarded tables are not explicitly tested (triggers should fire; unverified).
- `uuidv7` monotonicity holds per process, not across processes (ids are time-ordered to the millisecond).
- `formatToman` relies on Node's ICU (full-icu is default on Node 22).
- History `occurred_at` uses database transaction time (`now()`), not the injected `Clock`.
- No test of concurrent `platform_apply_grants()` runs.

## Remaining risks
- **Outbox/idempotency tables grow without bound** (P-7 forbids deletion); an archival policy is needed before production scale.
- Triggers hide logic from application developers: mitigated by direct SQL tests and the conventions above, not eliminated.
- The 10¹³ Rial per-amount ceiling is a technical default; changing it is a migration.
- Dev/test doubles exist (`ManualClock`); the production guard is lint/arch-level — no composition root exists yet to enforce it at runtime.
- CI hardening still open: SHA-pinned actions, branch protection / required checks.
