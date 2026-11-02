# PHASE_2B_6_NOTES.md — Payments + Wallet (implemented)

## 1. Scope (from PHASE_2B_PLAN §2b-6)
`payments` and `wallet` modules; `PaymentGateway` port; migrations `0016_payments_wallet_tables`, `0017_payments_wallet_guards` (forward-only, `0000–0015` untouched and hash-pinned); no new dependency. Matrix unchanged (`payments → ledger, audit`; `wallet → ledger, payments, audit`; neither imports identity). Not built: orders, suppliers, refunds, order payment from wallet (blocked, §6), real gateway, HTTP/UI.

## 2. Model
- `payments`: opaque `order_ref | topup_ref` (exactly one, by purpose), `user_ref`, `gateway`, `gateway_ref` (unique per gateway), integer Rial `amount` (`rial_amount`, > 0), `status` INITIATED/PENDING/VERIFYING/SUCCEEDED/FAILED/NEEDS_REVIEW/EXPIRED/CANCELLED (engine + history, actor required), unique `idempotency_key` + request hash, verification lease (`verifying_since`, `verify_attempts`), `verified_at`, `verified_amount`. **CHECK: SUCCEEDED ⇒ verified_amount = amount and gateway_ref present.** Immutable core columns; set-once `gateway_ref`/`verified_*`.
- `payment_events`: append-only, unique `(gateway, event_key)`, payloads passed through `redact`.
- `wallet_topups` (REQUESTED→COMPLETED/FAILED; COMPLETED ⇒ ledger transaction + payment), `wallet_adjustments` (REQUESTED→COMPLETED/REJECTED; CHECK decider ≠ requester, reasons ≥ 10/5 chars). Cross-module FKs (payment, ledger transaction) created in SQL (P-1); one ledger posting per business row (unique partial indexes).
- No DELETE anywhere; UPDATE only on named columns. The wallet balance is NOT stored: it is the ledger's `CUSTOMER_WALLET` account.

## 3. Flows
**Top-up:** `startTopUp` (limits required — B5) → tx: top-up row + INITIATED payment (idempotent) → *no tx*: `gateway.createPayment` (CREATED→PENDING / REJECTED→FAILED / thrown→stays INITIATED, retry-safe) → customer pays at the gateway → callback/return → `completeTopUp` → `verifyPayment`:
1. **claim** (tx, row lock): PENDING→VERIFYING with lease; duplicates get `IN_PROGRESS`/`FINAL`; expired lease ⇒ re-claim; budget spent ⇒ NEEDS_REVIEW.
2. **verify** (NO transaction open — test probes `pg_stat_activity`).
3. **record** (tx): PAID + same reference + exact amount ⇒ SUCCEEDED, outbox `payment.succeeded`, audit, **and in the same transaction** the wallet ledger posting (`topup:<paymentId>`) + top-up COMPLETED. Failing hook ⇒ everything rolls back and the payment stays VERIFYING. Mismatch ⇒ NEEDS_REVIEW + received amount to suspense (D9); FAILED ⇒ FAILED; unknown/timeout ⇒ retry later.
**Adjustments:** request (admin A) → decide (admin B ≠ A): approve posts `ADMIN_ADJUSTMENT` in the same transaction (debit beyond balance ⇒ `INSUFFICIENT_FUNDS`, request stays open); reject moves nothing.

## 4. Public contracts
payments: `initiatePayment`, `startGatewayPayment`, `verifyPayment(…, {onSucceeded})`, `listVerificationDue` (worker), `getPayment`, `findPaymentByGatewayRef`, `getPaymentForUser` (IDOR-safe), admin `getPaymentAdmin`/`listNeedingReview`. wallet: `startTopUp`, `completeTopUp`, `getTopUp`, `getWalletBalance`, admin `getWalletBalanceAdmin`, `requestAdjustment`, `decideAdjustment`. Orders (2b-8) will call `initiatePayment` with `purpose=ORDER` and `verifyPayment` with their own `onSucceeded` (reservation consume + `markSold` + order PAID), which is how the D9 LATE branch is decided in the same transaction.

## 5. Tests (real PostgreSQL, least-privilege role)
DB (13): idempotency/validation, gateway-create outcomes, credit-once with ledger/outbox/audit, B5 fail-closed, no-gateway loudness, callback-as-trigger, mismatch→suspense, FAILED, timeouts/lease/budget/late answer, no-transaction-during-gateway-call + hook rollback, IDOR + forged transitions + grants, two-person adjustments incl. overdraft rollback. Concurrency (5): **C3 — 100 parallel duplicate callbacks → 1 settlement, 1 ledger transaction, wallet credited once, 1 gateway call**; 20 users × 5 callbacks; 25 same-key starts; S2 analogue — 40 concurrent debit approvals ⇒ exactly 25 succeed, never negative; same adjustment approved by 20 admins ⇒ once. Architecture (7): table privacy (caught a real violation during development), matrix, no stored balance, no recognition-dependent posting, factory guards, no I/O, permissions.

## 6. Open / blocked
- **Blocked by D10:** `payFromWallet` / order payment posting (exact choice in DECISIONS "D10 / blocked"). **Blocked by B12/B13:** manual NEEDS_REVIEW resolution and refunds. **X1:** real gateway; the port must be revisited against its documentation. **B5/B10** as recorded.
- Redirect URL is returned once (not stored). Payment expiry/cancel sweeps (PENDING→EXPIRED/CANCELLED) have rules but no scheduler yet (2b-8 with orders).
- Reconciliation: every SUCCEEDED top-up payment has one `topup:` ledger transaction (asserted in tests); a scheduled report is future work.
