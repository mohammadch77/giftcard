# PHASE_2B_7_NOTES.md — Suppliers + Fulfillment (implemented)

## 1. Scope and honesty about what is verified
PHASE_2B_PLAN §2b-7 is "Suppliers + Fulfillment"; both halves are implemented. **All supplier behaviour is generic and verified only against `TestSupplier`** — no real supplier, API or document exists (X3). See `SUPPLIER_INTEGRATION.md`. Migrations `0018_suppliers_fulfillment_tables`, `0019_suppliers_fulfillment_guards` (forward-only; `0000–0017` untouched, hash-pinned). No new dependency; matrix unchanged. Not built: orders/checkout, refunds, payment-gate trigger (2b-8), UI/HTTP.

## 2. Model
suppliers (config JSON without secrets/hosts/URLs) · supplier_credentials (sealed, write-only, ACTIVE/REPLACED) · supplier_products (cost fact in Rial, availability, hash) · supplier_sync_runs + supplier_product_changes (history) · variant_supplier_routes (priority failover; variant must be SUPPLIER_API) · supplier_orders (unique `(supplier, idempotency_key)`, state machine CREATED/SUBMITTING/CONFIRMED/REJECTED/UNKNOWN, CHECK: CONFIRMED needs a reference or a human note) · supplier_order_secrets (sealed, append-only) · supplier_order_events (append-only).
fulfillment_tasks (unique per order item, engine) · fulfillment_events · deliveries (disclosure counters, first reveal by CUSTOMER/ADMIN) · delivery_secrets (sealed) · secret_access_log. No DELETE grants; UPDATE only on named columns; immutable cores; set-once fields.

## 3. Flows
- **Sync:** adapter call outside any transaction → normalise (IRR integers only) → one transaction with history; failures change nothing.
- **Submit:** claim under lock → adapter (timeout) → record. Test proves: no transaction open during the call, credentials seen only inside the call, supplier contacted once per key.
- **Reconcile / sweeper / manual resolution:** see SUPPLIER_INTEGRATION.
- **Fulfillment:** `createTasks` (orders, after PAID) → AUTO_CODE: `deliverAutoCodes` marks the CONSUMED reservation SOLD (inventory refuses anything else) and records deliveries; SUPPLIER_API: `fulfillSupplierTask` (routes in order, failover only after explicit rejection, ambiguity blocks everything, confirmed data re-sealed into `delivery_secrets`); MANUAL: `claimManualTask` (one winner; a FAILED task can be taken over as manual fallback) → `completeManualTask` (assignee only, secret sealed).
- **Reveal:** rate limit → ownership/permission → COMMITTED log + counters → open secret (KeyProvider, no transaction) → callback → zero.

## 4. Tests (real PostgreSQL, least-privilege role)
DB 24 (suppliers 14 + fulfillment 10): admin/credential protection (canary never in any table/audit/event; no read API), sync (create/update/missing/invalid/failed), mapping rules, every submit outcome incl. slow-timeout-while-executed, reconciliation matrix, non-transmission, malformed reply, seal failure, KeyProvider missing, sweeper, manual resolution, DB guards; task creation, delivery/reveal/disclosure/IDOR/log-first/rate-limit, late reservation never delivered, mixed orders, manual flow, supplier happy path, failover vs ambiguity (second supplier never contacted), fallback. Concurrency 6: **C4** 50 parallel submits → 1 supplier call; 30 parallel fulfilments → 1 purchase/1 delivery; 10 parallel reconciliations; 20 admins claim → 1; 100 parallel reveals → counters = log = successes (≤ 20); 20 parallel deliveries. Architecture 8. Two real defects were found by these tests and fixed: the delivery-secret envelope AAD used the wrong row id, and concurrent fulfilments could finalize against a still-`SUBMITTING` order.

## 5. Open / blocked
X3 (real adapter), B7, D10/B12/B13 (unchanged), 2b-8 payment-gate trigger, workers/schedulers (SUP-1), SSRF host allow-list when an adapter exists, `fulfillment.codes.reveal` granted to nobody.
