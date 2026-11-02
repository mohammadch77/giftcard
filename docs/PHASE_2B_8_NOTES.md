# PHASE_2B_8_NOTES.md — Orders & Checkout (implemented; settlement fail-closed)

## 1. Scope
PHASE_2B_PLAN §2b-8: orders, immutable items, history, holds, checkout, wallet + gateway settlement, D9 late-payment path, cancel/expire, hold resolution, DB payment gate, public contracts. Migrations `0020_orders_tables`, `0021_orders_guards` (forward-only; `0000–0019` untouched and hash-pinned). No new dependency; matrix unchanged. **No cart module** (not in the plan; Phase 4). Not built: refunds (2b-9), promotions, fraud, HTTP/UI, real gateway/supplier.

## 2. Model
`orders` (random order number, status engine with history + actor, `payment_method` WALLET|GATEWAY, `payment_status` cache, integer-Rial `total`, `reservation_id`, `payment_id`, `settlement_ledger_txn_id`, `expires_at`), `order_items` (one row per variant; **snapshot JSON + unit price + line total, never updatable**), `order_status_history`, `order_holds` (open-hold uniqueness per reason). CHECKs/triggers: total = Σ items at commit; ON_HOLD ⇔ open hold at commit; paid states require SUCCEEDED + `paid_at`; wallet orders have no payment row (D6); immutable cores; set-once `paid_at`/ledger ref. Unit refs for fulfilment are `<order_item_id>#<n>`.
**Payment gate (0021):** `fulfillment_tasks` and `deliveries` inserts require an item of a PAID order, same customer, and (tasks) same order and variant.

## 3. Flows
- **Checkout** (`checkout`): config gate (B3, D10, gateway) → one tx under an advisory lock: replay check, `pricing.quote` (no price input), snapshots, `inventory.reserve` (all-or-nothing; supplier variants skipped), `payments.initiatePayment`, order + items, outbox/audit → after commit `payments.startGatewayPayment`.
- **Gateway settlement** (`confirmGatewayPayment` → `payments.verifyPayment` with `onSucceeded`): fresh (PENDING_PAYMENT, before `expires_at`) and `inventory.consume` = CONSUMED ⇒ settle; otherwise **D9 late path**. Mismatch ⇒ payment NEEDS_REVIEW ⇒ order ON_HOLD (`PAYMENT_NEEDS_REVIEW`).
- **Wallet settlement** (`payOrderWithWallet`): expiry check, consume, settle; an expired order expires instead.
- **settle** = D10 posting policy → PAID → `fulfillment.createTasks` → `deliverAutoCodes` (marks the CONSUMED reservation SOLD) → fulfilment status derived from tasks.
- **Late/hold:** see DECISIONS OR-3. **Cancel/expire:** OR-5. **Fulfilment progress:** `syncFulfillment` derives FULFILLING / PARTIALLY_COMPLETED / COMPLETED from the tasks.
- Reads: `getOrder` (owner only), `listOrdersForUser`, admin `getOrderAdmin` / `listOpenHolds`.

## 4. Fail-closed configuration (tests prove nothing is written)
B3 hold missing/out of bounds ⇒ `ORDER_RESERVATION_TTL_NOT_CONFIGURED`; D10 policy missing ⇒ `ORDER_ACCOUNTING_NOT_CONFIGURED` (checkout, wallet pay, RE_RESERVE); no gateway ⇒ `PAYMENT_GATEWAY_NOT_CONFIGURED`. **To launch:** set `ORDER_RESERVATION_TTL_SECONDS`; provide the approved `OrderPaymentPostingPolicy` (one class in orders, then wire it at the composition root); provide a real gateway (X1).

## 5. Tests (real PostgreSQL, least-privilege role)
DB 20: fail-closed matrix, snapshot immutability across later price changes, no client price, atomic shortage, idempotency, commit-time invariants, IDOR; redirect-is-not-payment, settlement + reveal ownership + history actors, mismatch hold; D9 (expired, edge instant before the sweeper, cancelled, RE_RESERVE incl. new reservation / insufficient stock / permissions, KEEP_ON_HOLD); wallet settlement, expiry, rollback after posting; cancel/expire; raw-SQL gate matrix; fulfilment progress; audit. Concurrency 6: **S1 end-to-end — 1,000 concurrent checkout→pay→deliver on 10 codes ⇒ exactly 10 delivered, 0 duplicate codes, consistent**; mixed wallet/gateway 400; 30 same-key checkouts; 100 duplicate callbacks ⇒ 1 settlement; 50 races payment-vs-sweeper at the expiry instant; 30 races cancel-vs-payment. A cross-module invariant set (available+reserved+sold=total, tasks/deliveries ↔ paid orders, no fulfilment for unpaid/held orders, SOLD ↔ paid order, ledger integrity) is asserted after each scenario. Architecture 7 (table privacy, no accounting accounts, no default TTL, no price field, no I/O, test-double isolation). Existing fulfilment tests were migrated to seed real PAID orders because the new gate rejects anything else.

## 6. Blocked / open
D10 (settlement), B3, B12/B13 (review-hold resolution, refunds → 2b-9), X1/X3, workers (ORD-1), B1/B2/C-2 untouched, B7 unchanged (on-site reveal only).
