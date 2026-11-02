# LEDGER_DESIGN.md — audit trail and double-entry ledger (step 2b-2)

Status: **implemented** (migrations `0007`–`0009`; modules `audit` and `ledger`). The chart of accounts is a **PROPOSAL** (`proposed-0`) pending an accountant (D10). **Revenue-recognition timing is NOT decided and NOT configurable** — there is no env variable, admin setting or database flag for it. No tax, fee or accounting policy is assumed.

## 1. Principles (all enforced by PostgreSQL, not only by TypeScript)
1. **The ledger is the only source of financial truth.** `ledger_account_balances` (and therefore every wallet balance) is a *projection* of the entries; it is written only by trigger code and is checked against the entries by `ledger_integrity_findings()`.
2. **Every transaction is balanced at COMMIT** (deferred constraint triggers): ≥ 2 entries, ≥ 1 debit and ≥ 1 credit, Σdebits = Σcredits. An unbalanced transaction, a one-sided one, or a transaction row with no entries cannot commit (SQLSTATE `PL001`).
3. **Append-only.** `ledger_accounts`, `ledger_transactions`, `ledger_entries` and `audit_logs` reject UPDATE, DELETE and TRUNCATE for everybody (triggers, SQLSTATE `23001`); the application role additionally has INSERT/SELECT only. The projection rejects any direct write (`PL004`) — only code running inside the ledger triggers (checked with `pg_trigger_depth()`) may change it.
4. **Corrections are new transactions.** A reversal must be the **exact mirror** of the original (same accounts and amounts, opposite sides — verified at COMMIT, `PL002`); a transaction can be reversed **once** (unique index); a reversal cannot be reversed. Anything else is an explicit `ADMIN_ADJUSTMENT`/`CORRECTION` posting with a mandatory reason.
5. **Idempotent.** Every posting carries a business-derived `idempotency_key` (UNIQUE) and a request fingerprint: same key + same request = replay (returns the original transaction, writes nothing); same key + different request = `IDEMPOTENCY_CONFLICT`.
6. **Audited.** Every ledger transaction has a NOT-NULL foreign key to an `audit_logs` row (action `ledger.post` / `ledger.reverse`, entity = the idempotency key, actor, reason, entries). Account creation is audited too. Audit rows are written in the same DB transaction as the change.
7. **No external calls inside a database transaction.** The ledger API takes the caller's transaction and performs no I/O besides SQL; ESLint forbids `fetch`/`http`/`net` imports in `src/modules/ledger` and `src/modules/audit`.
8. **Wallet money is a liability.** `CUSTOMER_WALLET` is a LIABILITY (credit-normal, floor 0): top-ups credit it and are *not* revenue; overdrafts are rejected atomically by a CHECK on the projection (`INSUFFICIENT_FUNDS`).
9. **Money** is integer Rial in PostgreSQL domains (`rial_amount` 1…10¹³ per entry; balances in `rial_balance`).

## 2. Schema (as built)
| Table | Notes |
|---|---|
| `audit_logs` | id, occurred_at (Clock), recorded_at, actor_type/id, action, entity_type/id, request_id, before/after/metadata (jsonb, redacted before insert, ≤ 64 KB), CHECKs on formats. Indexes by entity, actor, action. |
| `ledger_accounts` | code, owner_type/owner_id (both or neither), type, `contra`, normal_side (CHECK: matches type and contra), currency `IRR`, `min_balance`, `chart_version`; unique `(code, coalesce(owner_type,''), coalesce(owner_id,''))`. Immutable. |
| `ledger_transactions` | kind, idempotency_key (UNIQUE), request_hash, reference_type/id, reverses_id (partial UNIQUE), description (≤ 500), actor_type/id, **audit_log_id NOT NULL → audit_logs**, `pg_txid`, posted_at (Clock), created_at. `kind='REVERSAL'` ⇔ `reverses_id` set. |
| `ledger_entries` | transaction_id, account_id, side, amount (`rial_amount`, > 0). An entry can only be inserted by the DB transaction that created its ledger transaction (`PL003`). |
| `ledger_account_balances` | PROJECTION: balance, min_balance (copy, immutable), entry_count, last_entry_id, version; CHECK `balance >= min_balance`. Row lock per account serialises concurrent postings. |
Functions: `ledger_assert_transaction_valid`, `ledger_reversal_mismatch`, `ledger_integrity_findings()` (BALANCE_DRIFT, MISSING_BALANCE_ROW, BELOW_FLOOR, UNBALANCED_TRANSACTION, REVERSAL_MISMATCH, AUDIT_MISMATCH), `ledger_trial_balance()`. Custom SQLSTATEs: `PL001` unbalanced/invalid, `PL002` invalid reversal, `PL003` late/foreign entry, `PL004` direct projection write.
Cross-module FK `ledger_transactions.audit_log_id → audit_logs(id)` is created in SQL (policy P-1); the Drizzle schemas stay module-private. **Matrix change ARCH-1: `ledger → audit` is now allowed** (audit imports nothing).

## 3. Public contract (`src/modules/ledger/index.ts`)
`ensureAccount(tx, spec, actor)` · `post(tx, input)` · `reverse(tx, input)` · `getBalance(db, ref)` · `trialBalance(db)` · `verifyIntegrity(db)` · `getTransaction(db, id)` · chart helpers (`walletAccount`, `gatewayReceivable`, `systemAccount`) · posting-rule builders. Audit: `recordAudit(tx, entry)`, `listAudit(db, filter)`.
- Entries are inserted sorted by account id → every caller locks accounts in the same order (deadlock avoidance; 300 random opposing transfers produced no deadlock).
- A losing concurrent posting rolls back to a savepoint (discarding its own audit row) and then replays the winner.
- `SENSITIVE_KINDS` (`ADMIN_ADJUSTMENT`, `REVERSAL`, `CORRECTION`) require a reason (≥ 5 chars) which lands in the audit metadata.

## 4. Chart of accounts — PROPOSED (`proposed-0`)
Defined in code (`domain/chart-of-accounts.ts`), created on demand by `ensureAccount` (no accounts are seeded by migration, so the accountant's changes never require rewriting history; every account stores the chart version). 17 accounts: BANK_SETTLEMENT, GATEWAY_RECEIVABLE (per gateway), SUPPLIER_PREPAID, INVENTORY_DIGITAL, **CUSTOMER_WALLET (per user, liability, floor 0)**, CUSTOMER_PREPAYMENTS, REFUNDS_PAYABLE, SUPPLIER_PAYABLE, **SUSPENSE_UNRESOLVED_RECEIPTS** (late payments, D9), TAX_PAYABLE (reserved), OWNER_EQUITY, SALES_REVENUE, SALES_REFUNDS (contra), COGS, GATEWAY_FEES, PROMO_CREDIT_EXPENSE, ADJUSTMENT_EXPENSE.
**Posting rules provided** (they do not depend on open decisions): wallet top-up, suspense receipt, suspense → wallet, admin wallet credit, admin wallet debit. **Deliberately NOT provided:** order payment, delivery/revenue, refunds of recognised revenue, gateway settlement, fees, tax — they depend on D10 and on the unselected gateway. A test pins the list of rules.

## 5. Reports
`trialBalance()` — per account, computed from the entries (debit total, credit total, balance) next to the projection, plus overall totals and a `balanced` flag; `verifyIntegrity()` — empty list = healthy. Both are single statements (one consistent snapshot; tested while 150 postings run).

## 6. What this does NOT protect against (honest limits)
- A **superuser/owner** can disable triggers (`session_replication_role = replica`) and forge rows. The integrity check **detects** this (tested: drift, unbalanced transactions, mirror mismatch, audit mismatch, floor breach) but nothing can *prevent* it inside PostgreSQL; off-box audit shipping and backups are the mitigation (Phase 6).
- A **compromised application role** can still INSERT new, balanced, audited transactions (it cannot change or delete history). Detection relies on audit review and reconciliation.
- Audit rows are tamper-*evident* only through the append-only guards; there is no hash chain (T4 open).
- Reports scan all entries (fine for now; needs snapshots/period closing at scale — Phase 6).
- Rounding/percent rules, VAT, fees, COGS and revenue timing are undefined by design (D10).
