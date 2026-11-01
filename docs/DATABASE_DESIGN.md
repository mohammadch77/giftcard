# DATABASE_DESIGN.md

Status: **DRAFT v0.1 — Phase 1, awaiting review.** Nothing here is implemented in the application yet.
Target: PostgreSQL 16+ (16.15 verified locally for the prototypes in `docs/db-prototypes/`).

Items marked **[OPEN]** depend on a decision listed in `OPEN_QUESTIONS.md`. Items marked **[VERIFIED]** were executed against PostgreSQL 16 via `docs/db-prototypes/test_prototypes.sh`.

---

## 1. Principles

1. **The database is the last line of defence.** Application checks are necessary but never sufficient. Every invariant that can be a constraint, trigger or unique index *is*.
2. **Money = integer.** `bigint` in the smallest unit; never `float`/`numeric` arithmetic in app code. Percentages are applied with one explicit, tested rounding rule (see §9.3).
3. **Financial and inventory history is append-only.** Corrections are new compensating rows, never `UPDATE`/`DELETE`.
4. **Status is data with history.** Every state machine has (a) a CHECK-constrained status column, (b) an append-only transition history table, (c) a transition-rule table enforced by trigger (§8).
5. **Secrets are never plaintext columns.** Codes, credentials, supplier keys are encrypted (envelope); lookups use a keyed hash (§6).
6. **Time** is `timestamptz` in UTC. Jalali conversion is purely a presentation concern.
7. **IDs.** Internal PKs: `bigint identity` for high-volume append-only tables (ledger, events, movements); `uuid` (v7, app-generated or PG18 `uuidv7()`) for entities exposed in URLs/APIs (orders, tickets, users). Human order numbers are a separate unique column (non-sequential-guessable). **[OPEN: PG version]**
8. **No physical deletes** of financial, order, payment, fulfillment, audit, or ledger rows. Catalog rows are archived (`archived_at`), not deleted, once referenced.
9. **Single currency (IRT) in v1**, but every money-bearing table carries `currency char(3)` with a CHECK, so adding currencies later is a migration, not a redesign. **[OPEN: Toman vs Rial base unit]**

## 2. Schema overview (module → tables)

| Module | Tables |
|---|---|
| identity | `users`, `user_credentials`, `user_sessions`, `verification_tokens`, `roles`, `permissions`, `role_permissions`, `user_roles`, `user_security_events` |
| catalog | `categories`, `brands` (platforms/games), `products`, `product_variants`, `attribute_schemas`, `product_images`, `variant_price_history`, `regions` |
| inventory | `inventory_batches`, `digital_codes`, `stock_counters`, `inventory_reservations`, `inventory_movements` |
| suppliers | `suppliers`, `supplier_credentials`, `supplier_products`, `variant_supplier_routes`, `supplier_orders`, `supplier_order_events` |
| orders | `carts`, `cart_items`, `orders`, `order_items`, `order_status_history`, `order_discounts` |
| payments | `payments`, `payment_events`, `refunds`, `refund_status_history`, `payment_status_history` |
| ledger/wallet | `ledger_accounts`, `ledger_transactions`, `ledger_entries`, `ledger_account_balances`, `wallet_topups` |
| fulfillment | `fulfillment_tasks`, `fulfillment_events`, `deliveries`, `delivery_secrets`, `secret_access_log` |
| promotions | `discount_codes`, `discount_code_rules`, `discount_redemptions`, `campaigns`, `campaign_targets` |
| support | `tickets`, `ticket_messages`, `ticket_attachments`, `ticket_status_history` |
| platform | `idempotency_keys`, `outbox_events`, `notifications`, `audit_logs`, `state_transition_rules`, `encryption_keys` (metadata only), `system_settings`, `fraud_flags` |

This is a proposed inventory. Candidates to *drop or defer* if review agrees: `variant_price_history` (derive from audit log), `user_security_events` (merge into `audit_logs`), `fraud_flags` (start as a column on orders).

## 3. Identity & access

- `users(id uuid PK, phone text UNIQUE, email citext UNIQUE NULL, status, created_at, …)`. Iranian norm is **phone/OTP login** — phone is normalised to E.164 (`+98…`) before storage; CHECK on format. **[OPEN: login method]**
- `user_credentials(user_id PK/FK, password_hash, algo, updated_at)` — **argon2id** hashes only. Separate table so it is never accidentally selected with the user row.
- RBAC: `roles`, `permissions(code unique, e.g. 'ledger.adjust', 'codes.reveal', 'orders.refund')`, `role_permissions`, `user_roles`. Permissions are code-defined constants seeded by migration; app checks permission codes, never role names.
- Sensitive actions (`ledger.adjust`, `codes.reveal`, `suppliers.credentials.write`, `refunds.approve`) are separate permissions so no single "admin" owns everything. Optional four-eyes approval for adjustments above a threshold. **[OPEN]**
- `user_sessions`: server-side sessions (hashed session token, ip, ua, last_seen, revoked_at) to allow "log out all devices". Admin accounts require TOTP 2FA.

## 4. Catalog

### 4.1 Model

```
categories (tree: parent_id, slug, path)         brands (Steam, PlayStation, Spotify, a game…)
        \                                          /
         products (type, brand_id, category_id, slug, status, seo jsonb)
              |
         product_variants (sku, region, denomination/duration, fulfillment_method, price, attrs jsonb)
```

- `products.type` ∈ `GIFT_CARD | GAME_ACCOUNT | GAME_SUBSCRIPTION | STREAMING_SUBSCRIPTION | DIGITAL_SERVICE | OTHER` (lookup-backed, extensible).
- **Variants are the sellable unit.** "Steam $20 US" and "Steam $50 US" are variants of one product. Cart, order items, stock, supplier mapping all reference `variant_id`, never `product_id`.
- `product_variants.fulfillment_method` ∈ `AUTO_CODE | MANUAL | SUPPLIER_API`. Fulfillment is a **variant** property (a product can have an auto-code variant and a manual variant).
- Attributes: *filterable/structural* ones are typed columns (`region_id`, `denomination` + `denomination_currency`, `duration_days`). *Descriptive/type-specific* ones live in `attrs jsonb`, validated at write time against `attribute_schemas(product_type, json_schema, version)` with Zod. This avoids EAV join explosions while keeping per-type validation. Variant `attrs` are snapshotted into `order_items` at purchase.
- Pricing: `product_variants.price bigint CHECK (price >= 0)`, `sale_price bigint NULL CHECK (sale_price IS NULL OR sale_price < price)`, `sale_starts_at/ends_at` with CHECK (ends > starts). Price changes append to `variant_price_history`. Campaign/code discounts are *not* stored in variants.
- Publication: `status ∈ DRAFT|PUBLISHED|ARCHIVED`; a variant can only be PUBLISHED if its product is.

### 4.2 Constraints
`UNIQUE(slug)` per table; `UNIQUE(product_id, sku)`; partial index on published variants; FK `ON DELETE RESTRICT` everywhere in catalog (history must keep resolving).

## 5. Inventory

### 5.1 Two inventory shapes

| Shape | Used by | Representation |
|---|---|---|
| **Itemised** | `AUTO_CODE` gift cards, pre-loaded accounts | one row per item in `digital_codes` |
| **Counted** | `MANUAL`, `SUPPLIER_API` (no pre-loaded items) | `stock_counters(variant_id, available, reserved, CHECK available>=0 AND reserved>=0)`, `NULL`/unlimited allowed for supplier-backed items |

### 5.2 `digital_codes` (prototype **[VERIFIED]**: `docs/db-prototypes/002_inventory.sql`)

Columns: `id`, `variant_id`, `batch_id`, `code_hash bytea UNIQUE`, `ciphertext`, `wrapped_dek`, `kek_version`, `status ∈ AVAILABLE|RESERVED|SOLD|VOID|QUARANTINED`, `reservation_id`, `order_item_id UNIQUE`, `reserved_until`, `sold_at`, `payload_kind ∈ CODE|ACCOUNT`, `public_attrs jsonb` (non-secret, e.g. region/expiry).

- **CHECK `status_links`** ties status to its foreign references (an `AVAILABLE` code cannot have an order; a `SOLD` code must). Together with `order_item_id UNIQUE`, a code **cannot** be attached to two order items even if application code is wrong.
- **Duplicate detection:** `code_hash = HMAC-SHA256(pepper, normalise(code))` with `UNIQUE`. A *keyed* hash is mandatory: gift codes are low-entropy and a plain SHA-256 column would be brute-forceable if the DB leaked. The pepper lives outside the DB (see `SECURITY.md`). Uniqueness is global (across variants/batches), so re-importing the same code anywhere fails.
- **Game accounts** use the same table with `payload_kind='ACCOUNT'` and an encrypted JSON payload (login/password/extra); the pre-loaded-account case. Accounts created by an admin *after* an order (manual fulfillment) go in `delivery_secrets` (§10).
- Partial index `(variant_id, id) WHERE status='AVAILABLE'` makes reservation an index scan.

### 5.3 Reservation strategy

Goal: reserve N codes for a checkout atomically, never twice, never blocking other customers.

```sql
UPDATE digital_codes SET status='RESERVED', reservation_id=$r, reserved_until=now()+$ttl
 WHERE id IN (SELECT id FROM digital_codes
               WHERE variant_id=$v AND status='AVAILABLE'
               ORDER BY id LIMIT $n
               FOR UPDATE SKIP LOCKED)
RETURNING id;
```
Rules:
1. Runs inside the checkout DB transaction with the `inventory_reservations` insert and order creation.
2. If rows returned `< n` → **roll back** the whole transaction (all-or-nothing) and report "insufficient stock".
3. `SKIP LOCKED` means concurrent buyers take *different* rows instead of queueing; `FOR UPDATE` + the status predicate prevents the same row going to two buyers.
4. **[VERIFIED]** 1,000 attempts × 50 parallel clients vs 10 codes → exactly 10 reservations, 0 duplicates (`test_prototypes.sh`). This proves the primitive, not the full purchase flow; the full-flow stress test is specified in §16.
5. TTL default 15 min **[OPEN]**. Expiry worker: `UPDATE … SET status='AVAILABLE', reservation_id=NULL WHERE status='RESERVED' AND reserved_until < now()` + reservation→`EXPIRED` + movement row, using `SKIP LOCKED`. Checkout also opportunistically sweeps expired reservations for the variant it is reserving.
6. **Late payment** (gateway success after reservation expiry): payment is recorded, then the system tries to re-reserve. On failure the order goes `ON_HOLD`/needs-refund and the money is credited to the customer's wallet or flagged for refund — *never* silently kept without delivery. **[OPEN: policy]**
7. Counted stock: `UPDATE stock_counters SET available=available-$n, reserved=reserved+$n WHERE variant_id=$v AND available>=$n` (affected rows = 0 ⇒ insufficient).

### 5.4 Movements

`inventory_movements(id, variant_id, code_id NULL, type, qty_delta, reservation_id, order_item_id, reason, actor, created_at)` — append-only (trigger). Types: `IMPORT, RESERVE, RELEASE, SELL, VOID, RETURN_TO_STOCK, ADJUST`. For itemised stock, `available` = count of AVAILABLE rows; a reconciliation job asserts it equals the sum of movements. `inventory_batches(supplier_id, cost_per_unit, currency, purchased_at, import_checksum)` holds cost basis (needed for COGS) and de-duplicates re-uploaded files.

## 6. Secret storage (summary; full detail in `SECURITY.md`)

- Envelope encryption: random 256-bit **DEK per secret** → AES-256-GCM encrypts the payload (AAD = row id + kind, prevents ciphertext swapping) → DEK wrapped by a **KEK** held *outside* the database (`kek_version` column enables rotation by re-wrapping DEKs, no payload re-encryption).
- Duplicate detection key (HMAC pepper) is a **separate** key from the KEK.
- Plaintext exists only in memory during import and during an authorised reveal.
- Reveal is an explicit service call that writes `secret_access_log` (who, what, why, ip) *before* returning plaintext.

## 7. Orders

```
orders(id uuid, number text UNIQUE, user_id, status, payment_status, currency,
       subtotal, discount_total, total, wallet_applied, gateway_amount, placed_at, expires_at, …)
order_items(id, order_id, variant_id, qty, unit_price, discount, line_total,
            name_snapshot, attrs_snapshot jsonb, fulfillment_method, fulfillment_status, …)
```
- **Everything the customer saw is snapshotted** on the item (name, attrs, unit price). Later catalog edits never alter history.
- CHECKs: `total = subtotal - discount_total`, `total >= 0`, `wallet_applied + gateway_amount = total`, `qty > 0`, `line_total = unit_price*qty - discount`.
- Prices, discounts and totals are **recomputed server-side** inside the checkout transaction from DB rows; nothing monetary is accepted from the client.
- The three concepts are separate: `orders.status` (lifecycle), `orders.payment_status` (aggregate cache of `payments`), `order_items.fulfillment_status` (per-item; source of truth is `fulfillment_tasks`). See `STATE_MACHINES.md`.
- A split payment (wallet + gateway) is allowed: wallet portion is posted to the ledger only when the gateway portion verifies, or reserved with a ledger hold. **[OPEN: v1 = all-wallet OR all-gateway?]** (recommended: no split in v1).
- `order_status_history(order_id, from, to, reason, actor, created_at)` append-only.
- **Cancellation rules:** `PENDING_PAYMENT` → customer/system may cancel (reservation released). After `PAID`, cancellation = refund workflow; delivered/revealed codes are not cancellable. **[OPEN: refund policy]**

## 8. State machine enforcement

Pattern applied to orders, payments, fulfillment tasks, reservations, supplier orders, refunds, tickets:

1. `status` column typed as a PG enum or `text CHECK (status IN (…))`.
2. `state_transition_rules(machine, from_status, to_status)` seeded by migration from `STATE_MACHINES.md`.
3. `BEFORE UPDATE OF status` trigger rejects any `(old,new)` not in the table, and `AFTER UPDATE` writes the history row (so history cannot be skipped by buggy code).
4. Application layer also validates (fast, nicer errors) — the DB is the backstop.
5. Guard transitions with optimistic concurrency: `UPDATE … SET status=$new WHERE id=$id AND status=$expected` (0 rows ⇒ someone else moved it; treat as conflict, re-read).

## 9. Ledger (wallet & accounting)

Prototype **[VERIFIED]**: `docs/db-prototypes/001_ledger.sql`; tests: balanced txn accepted, unbalanced rejected at COMMIT, overdraft rejected, duplicate posting rejected, UPDATE/DELETE/TRUNCATE blocked, late entries into a committed transaction rejected.

### 9.1 Structure
- `ledger_accounts(type, normal_side, owner_type/owner_id, currency, min_balance)` — one **wallet account per user** (LIABILITY, `min_balance=0`), plus system accounts.
- `ledger_transactions(kind, idempotency_key UNIQUE, reference_type/id, reverses_id, created_by)` — the unit of posting.
- `ledger_entries(transaction_id, account_id, side, amount>0)` — ≥2 rows per transaction; sum(DEBIT) = sum(CREDIT) enforced by a **deferred constraint trigger at COMMIT**.
- `ledger_account_balances` — a *projection* maintained inside the same DB transaction by trigger (row lock serialises concurrent postings on one wallet; `CHECK (balance >= min_balance)` is the overdraft guard). **It is a cache, not truth**: a nightly job recomputes balances from entries and alerts on drift.
- Append-only: triggers block UPDATE/DELETE/TRUNCATE. Corrections = a new transaction with `reverses_id`.
- `pg_txid` guard: entries can only be inserted by the DB transaction that created their ledger_transaction.
- App DB role has `INSERT/SELECT` only on ledger tables (no UPDATE/DELETE grant) as a second layer.

### 9.2 Chart of accounts (v1 proposal — **[OPEN: confirm with an accountant]**)

| Code | Type | Owner | Meaning |
|---|---|---|---|
| `CUSTOMER_WALLET` | Liability (credit-normal) | per user | store owes customer |
| `GATEWAY_CLEARING` | Asset | per gateway | money captured by gateway not yet settled to bank |
| `UNEARNED_REVENUE` | Liability | system | paid, not yet delivered |
| `SALES_REVENUE` | Revenue | system | recognised on delivery |
| `INVENTORY` | Asset | system | cost of unsold codes |
| `COGS` | Expense | system | cost of delivered items |
| `SUPPLIER_PAYABLE` / `SUPPLIER_PREPAID` | Liability / Asset | per supplier | **[OPEN]** |
| `GATEWAY_FEES` | Expense | per gateway | |
| `PROMO_CREDIT_EXPENSE`, `ADJUSTMENT` | Expense | system | goodwill/admin credits |

### 9.3 Standard postings (amounts in minor units)

| Event | Debit | Credit |
|---|---|---|
| Wallet top-up verified | GATEWAY_CLEARING | CUSTOMER_WALLET |
| Order paid from wallet | CUSTOMER_WALLET | UNEARNED_REVENUE |
| Order paid via gateway | GATEWAY_CLEARING | UNEARNED_REVENUE |
| Item delivered | UNEARNED_REVENUE → | SALES_REVENUE ; and COGS ← INVENTORY |
| Refund to wallet (pre-delivery) | UNEARNED_REVENUE | CUSTOMER_WALLET |
| Refund to gateway | UNEARNED_REVENUE (or revenue reversal) | GATEWAY_CLEARING |
| Admin credit/debit | ADJUSTMENT ↔ CUSTOMER_WALLET (needs reason + permission + audit) | |

Discounts: the order `total` is already net; the discount lives in `order_discounts` for reporting. No ledger entry.
Percentage rounding rule: `discount = floor(base * pct / 100)` using integer arithmetic (rounding favours the store by < 1 unit); capped by `max_discount`; unit-tested. **[OPEN: confirm]**

### 9.4 Idempotency
Every posting derives its `idempotency_key` from its business cause (`topup:<payment_id>`, `orderpay:<order_id>`, `refund:<refund_id>`). A duplicate callback attempts the same key → UNIQUE violation → treated as "already done". Combined with the idempotent payment state transition (§11), duplicate callbacks cannot double-credit **[VERIFIED at ledger level; end-to-end test pending in Phase 2]**.

## 10. Fulfillment & delivery

- `fulfillment_tasks(id, order_item_id UNIQUE per attempt-chain, method, status, assignee, attempt, last_error, …)`, `fulfillment_events` (append-only log: created, assigned, supplier_submitted, delivered, failed, retried…).
- Created **only** when the order reaches `PAID` (guard: task insertion trigger checks order.payment_status='SUCCEEDED').
- `deliveries(order_item_id, kind, delivered_at)` + for itemised stock the link is `digital_codes.order_item_id`. For manual accounts / supplier-returned codes: `delivery_secrets(delivery_id, ciphertext, wrapped_dek, kek_version, …)`, same envelope scheme.
- **Delivery gate (invariant):** `digital_codes.status` may become `SOLD`, and a `delivery_secrets` row may be inserted, only if the order's payment status is `SUCCEEDED`. Enforced in the service layer **and** by a trigger checking the order row.
- `secret_access_log(secret_ref, actor, purpose, ip, created_at)` append-only.
- Customer access: reveal endpoint authorises `order.user_id = session.user_id`; admins need `codes.reveal` and the access is logged.

## 11. Payments

- `payments(id uuid, purpose ORDER|WALLET_TOPUP, order_id/topup_id (exactly one, CHECK), gateway, gateway_ref/authority, amount, currency, status, created_at, verified_at)`; `UNIQUE(gateway, gateway_ref)`.
- `payment_events(id, payment_id, gateway, event_key, raw jsonb (redacted), received_at)` with `UNIQUE(gateway, event_key)` — every callback/webhook/verify response is logged once; dedupe by key (or by payload hash when the gateway has no event id).
- **Browser redirect is only a trigger to run server-to-server verification**; payment becomes `SUCCEEDED` only from a verified gateway response whose `amount` and reference match `payments` (mismatch ⇒ `NEEDS_REVIEW`).
- Success handler is one DB transaction: `payments → SUCCEEDED` (conditional UPDATE), ledger posting (idempotency key), `orders → PAID`, outbox event `order.paid`. The `WHERE status='VERIFYING'` conditional update means only one concurrent handler wins.
- Gateway specifics (Zarinpal/IDPay/etc.): **not designed yet** — pending documentation and a decision. Adapter interface only (`PAYMENT_INTEGRATION.md`, later).
- Never store card data; only gateway reference, masked PAN if the gateway returns one, and amounts.

## 12. Suppliers

- `suppliers(id, name, adapter_key, status, config jsonb (non-secret))`, `supplier_credentials(supplier_id, ciphertext, wrapped_dek, kek_version, rotated_at)`.
- `supplier_products(supplier_id, external_sku, name, cost, currency, available, last_synced_at, raw_hash)`; `variant_supplier_routes(variant_id, supplier_product_id, priority, active)` allows multiple suppliers per variant with failover order.
- `supplier_orders(id, order_item_id, supplier_id, idempotency_key UNIQUE(supplier_id,key), status, request_redacted, response_redacted, external_ref, attempts, next_retry_at)` + `supplier_order_events`.
- **Timeout ⇒ `UNKNOWN`, never auto-retry blindly.** A purchase request that timed out may have succeeded. UNKNOWN orders are resolved by status query (if the supplier offers one) or manual reconciliation; only then retried or failed. Marked `CONFIRMED` only on an explicit supplier confirmation.
- Supplier API shapes, auth and capabilities: **unknown until docs are supplied**; nothing here assumes any.

## 13. Promotions

`discount_codes(code citext UNIQUE, type PERCENT|FIXED, value, min_order, max_discount, total_limit, per_user_limit, starts_at, ends_at, active)`, `discount_code_rules(code_id, target_type PRODUCT|CATEGORY|BRAND, target_id, mode INCLUDE|EXCLUDE)`, `discount_redemptions(code_id, user_id, order_id UNIQUE(code_id, order_id), status RESERVED|CONSUMED|RELEASED)`.
- Usage limits are enforced atomically: `UPDATE discount_codes SET used_count=used_count+1 WHERE id=$1 AND (total_limit IS NULL OR used_count<total_limit)`; per-user limit via count under a per-user advisory lock or a unique-partial-index trick. Redemption is released if the order expires/cancels.
- `campaigns(priority, starts_at, ends_at, stackable, …)`, `campaign_targets`. Proposed default conflict rule: **at most one automatic campaign (highest priority; ties → larger discount) plus at most one code, and a code stacks with a campaign only if both flagged `stackable`.** **[OPEN]**
- Each applied discount is snapshotted into `order_discounts(order_id, order_item_id, source_type, source_id, amount)`.

## 14. Support

`tickets(id uuid, user_id, order_id NULL, category, priority, status, …)`, `ticket_messages(ticket_id, author_type CUSTOMER|ADMIN, author_id, body, created_at)`, `ticket_attachments(message_id, storage_key, mime, size, sha256, scan_status)`, `ticket_status_history`. Authorisation: customers can only read tickets where `user_id = self`; enforced in the data-access layer (a mandatory `userId` predicate in the customer-facing repository), with optional PostgreSQL RLS as defence in depth. **[OPEN: RLS yes/no]**

## 15. Platform tables

- `idempotency_keys(scope, key, request_hash, status IN_PROGRESS|DONE, response jsonb, created_at, expires_at, UNIQUE(scope,key))` — for HTTP-level idempotency (checkout create, top-up create, admin actions). Same key + different request hash ⇒ 422.
- `outbox_events(id, aggregate_type, aggregate_id, type, payload jsonb, created_at, available_at, locked_by, processed_at, attempts, last_error)`. Written **in the same transaction** as the state change; a worker polls with `FOR UPDATE SKIP LOCKED`, delivers (email/SMS, supplier submission, fulfillment start), marks processed. Consumers must be idempotent (at-least-once). This provides background jobs **without Redis**.
- `audit_logs(id, actor_id, actor_type, action, entity_type, entity_id, before jsonb, after jsonb, ip, ua, created_at)` append-only; secrets redacted at write; optional hash-chain column for tamper evidence. **[OPEN: need hash chain?]**
- `notifications(user_id, channel SMS|EMAIL|IN_APP, template, payload, status, …)` fed by outbox.

## 16. Concurrency & invariant test plan (summary)

Correctness tests (fast, deterministic, in CI) and stress tests (slow, separate job) are distinct.

| # | Test | Type | Expected |
|---|---|---|---|
| C1 | Two buyers, one code | correctness | one wins, one `INSUFFICIENT_STOCK` |
| C2 | Same payment callback ×N parallel | correctness | one `SUCCEEDED`, one ledger posting, one delivery |
| C3 | Duplicate wallet top-up callback | correctness | credited once |
| C4 | Duplicate supplier submission with same idempotency key | correctness | one supplier order |
| C5 | Supplier failure | correctness | order not `COMPLETED`; task `FAILED`; fallback offered |
| C6 | Reservation expiry vs concurrent payment | correctness | no double sale; late-payment policy applied |
| C7 | Direct SQL `UPDATE/DELETE` on ledger/movements | correctness | rejected |
| C8 | Invalid status transition via raw SQL | correctness | rejected by trigger |
| S1 | **1,000 concurrent purchase attempts vs 10 codes** through the real checkout→pay→deliver path | stress | ≤ 10 successful allocations, 0 duplicate codes, inventory never < 0, every order/payment/fulfillment in a consistent terminal state, ledger balanced, `available + reserved + sold = total` |
| S2 | 500 concurrent wallet debits on one wallet | stress | never negative; sum of successes ≤ balance |

Already proven at primitive level: S1's allocation core and ledger invariants (see `docs/db-prototypes/`).

## 17. Retention (proposal) **[OPEN: legal review]**
- Financial/ledger/orders/payments: retain indefinitely (or per Iranian tax/accounting rules — to be confirmed).
- Delivered secrets: encrypted payload kept for a customer-visible window (e.g. 12 months), then crypto-shredded (DEK destroyed) while the metadata/hash remain.
- `payment_events` raw payloads: 24 months then redact. Audit logs: ≥ 24 months. Sessions: 30 days after expiry.

## 18. ORM note
Prisma can model tables/relations but **cannot express** CHECK constraints, partial indexes, triggers, deferred constraint triggers or `SKIP LOCKED` in its schema. Plan: Prisma (or Drizzle — see `TECH_STACK.md`) for types and ordinary queries; **hand-written SQL migrations** for constraints/triggers/functions; raw queries (`$queryRaw`) inside interactive transactions for reservation and ledger posting; CI check that fails if the live schema drifts from migrations.
