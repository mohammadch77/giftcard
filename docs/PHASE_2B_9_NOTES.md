# PHASE_2B_9_NOTES.md — Refunds, reconciliation, closure (implemented; financially fail-closed)

## 1. Scope
PHASE_2B_PLAN §2b-9 only: refund request/policy/approval/execution, resolution of PAYMENT_NEEDS_REVIEW and late-payment holds by refund, paid-order cancellation through refunds, reconciliation detection. No HTTP routes, UI, sidebar, new dependency or later-phase feature. Plan items adapted: *unique refund per order* (not per item; full-order only), *delivered code ⇒ VOID* **not** executed (D10), *inventory↔movements* job = existing `verifyInventory`.

## 2. Model (migrations 0022 tables, 0023 guards)
See DATABASE_DESIGN §15b and STATE_MACHINES "Refund". Policy is data (`temporary-0`). Permissions: `orders.refunds.read|request|approve|execute|override_revealed`, `orders.reconciliation.run|read`.

## 3. Flows (orders module)
- `requestRefund` (customer owner or `orders.refunds.request`): locks the order; source ORDER_PAYMENT (paid order, destination = payment method, settlement posting required) or SUSPENSE_RECEIPT (`holdId` of a LATE_PAYMENT / PAYMENT_NEEDS_REVIEW hold, amount = the parked ledger amount). Snapshot of per-item disclosure + policy decision. Idempotent.
- `approveRefund` / `rejectRefund`: four-eyes, note ≥ 10, override rule above.
- `executeRefund` (`orders.refunds.execute`): assert executable (fail closed, before any change) → wallet: one transaction. Gateway: tx(PROCESSING + send intent) → gateway call (NO transaction) → tx(record outcome) → tx(finalize only if CONFIRMED). Repeating the call after PROCESSING only verifies.
- `finalize` (one transaction): ledger (`reverse` of the settlement posting / suspense posting, or the D9 `suspenseToWallet` rule) → COMPLETED → cancel open tasks → order CANCELLED → hold resolved (+ payment closed FAILED for mismatches) → outbox `order.refunded` → audit. Any failure rolls all of it back.
- `runReconciliation` / `runChecks` / `listFindings`: read-only detection, findings append-only.

## 4. What is verified vs generic
| Area | Status |
|---|---|
| Refund lifecycle, idempotency, four-eyes, audit, policy matrix, ledger balance after every path, rollback, DB gates, races | **Verified** by tests against real PostgreSQL |
| Gateway refund protocol | **GENERIC**: only `TestPaymentGateway` (accept/reject/throw, verify REFUNDED/PENDING/FAILED/UNKNOWN, amount). No real gateway (X1). |
| Ledger postings of order payments | **TEST DOUBLE only** (`TestBookingPolicy` — placeholder balanced posting; D10 open). Production default refuses to settle ⇒ no order can currently reach a refundable paid state in production. |
| Supplier-backed items | Refund blocked while a supplier order is outstanding; supplier reconciliation job is injected by the composition root. |

## 5. Financial workflows still BLOCKED (fail closed, exact error `REFUND_BLOCKED`)
Delivered/revealed items (decision recorded, execution blocked); gateway-paid→wallet; wallet-paid→gateway; partial refunds; any order without a settlement posting; any gateway without a refund capability; accepting a mismatched payment; fees/deadlines (none exist); Holds FRAUD_REVIEW / FULFILLMENT_FAILED / SUPPLIER_UNKNOWN.

## 6. Production launch blockers (unchanged or new)
D10 accountant decision + posting policy class; B12 final refund policy (legal) and B13 gateway refund semantics; a real gateway (X1) with a verified refund/status API; B3 reservation hold; B5 wallet limits; B10 thresholds; D8 production KeyProvider + SEC-KAT; B7; B1/B2/C-2; RET-1; X2 SMS, X3 supplier; schedulers for sweepers/reconciliation/refund retries; HTTP/UI (Phase 4).

## 7. Tests (2b-9)
`tests/db/refunds.test.ts` (lifecycle, policy, authz, fail-closed matrix, gateway ambiguity, held-money paths, rollback injection, reconciliation), `tests/concurrency/refunds.test.ts` (duplicate requests, approval race, concurrent executes ×2), `tests/architecture/refunds-regression.test.ts` (privacy, D10, I/O outside transactions, test-double isolation, override not seeded, read-only reconciliation). Existing pins updated: migrations 0020–0023 hashes, owner permission seed.

## 8. Post-commit verification notes
- `FULFILLING → CANCELLED` exists only as an engine rule added in 0023 and is guarded by `orders_cancel_gate` (needs a COMPLETED refund). Test: "a paid order can only be CANCELLED through a completed refund" asserts the order is FULFILLING, raw SQL cancel ⇒ PO002, then a completed refund makes the same edge succeed (history FULFILLING→CANCELLED).
- `orders.payment_status` stays `SUCCEEDED` after a refund (documented in STATE_MACHINES "Refund"; money was received and refunded, the cache records the payment, not the refund). Refund state is queryable from `refunds` (status, destination, amount, `external_outcome`, `ledger_txn_id`, `completed_at`; unique per order via `order_id`), `refund_status_history` and the ledger reversal; reconciliation's `PAID_ORDER_POSTING` / `REFUNDS_UNRESOLVED` jobs use exactly these. Reports must join `refunds`, not rely on `payment_status`.
- Plan wording "unique active refund per item" ⇒ implemented per order (full-order only); plan migration names `0021_refunds/0022_reconciliation_findings` ⇒ actual `0022_refunds_tables` / `0023_refunds_guards` (0020–0021 were used by orders).
