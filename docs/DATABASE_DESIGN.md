# DATABASE_DESIGN.md

Status: **DRAFT v0.2 — Phase 1, updated with decisions D1–D7 (see `DECISIONS.md`); awaiting review.** Nothing here is implemented in the application yet.
Target: PostgreSQL 16+ (16.15 verified locally for the prototypes in `docs/db-prototypes/`).

Items marked **[OPEN]** depend on a decision listed in `OPEN_QUESTIONS.md`. Items marked **[VERIFIED]** were executed against PostgreSQL 16 via `docs/db-prototypes/test_prototypes.sh`.

---

## 1. Principles

1. **The database is the last line of defence.** Application checks are necessary but never sufficient. Every invariant that can be a constraint, trigger or unique index *is*.
2. **Money = integer RIAL (decision D1).** Every monetary column is `bigint` holding **Rials**; never `float`/`numeric` arithmetic in app code. The UI displays **Toman** (`rial / 10`). Conversion exists in exactly one place (`platform/money`: `rialToToman`, `tomanToRial`, `formatToman`) used by the UI formatting layer, admin input forms and nowhere else — domain code, SQL, gateway adapters and the ledger only ever see Rials. Catalog prices, sale prices and fixed-discount values are constrained to **multiples of 10 Rial** (`CHECK (price % 10 = 0)`) so the Toman shown to customers is always exact; computed percentage discounts are floored to a multiple of 10 Rial for the same reason. Ledger amounts may be any positive integer Rial. Percentages are applied with one explicit, tested rounding rule (see §9.3).
3. **Financial and inventory history is append-only.** Corrections are new compensating rows, never `UPDATE`/`DELETE`.
4. **Status is data with history.** Every state machine has (a) a CHECK-constrained status column, (b) an append-only transition history table, (c) a transition-rule table enforced by trigger (§8).
5. **Secrets are never plaintext columns.** Codes, credentials, supplier keys are encrypted (envelope); lookups use a keyed hash (§6).
6. **Time** is `timestamptz` in UTC. Jalali conversion is purely a presentation concern.
7. **IDs.** Internal PKs: `bigint identity` for high-volume append-only tables (ledger, events, movements); `uuid` (v7, app-generated or PG18 `uuidv7()`) for entities exposed in URLs/APIs (orders, tickets, users). Human order numbers are a separate unique column (non-sequential-guessable). **[OPEN T2: production PG version]**
8. **No physical deletes** of financial, order, payment, fulfillment, audit, or ledger rows. Catalog rows are archived (`archived_at`), not deleted, once referenced.
9. **Single currency (IRR) in v1**, but every money-bearing table carries `currency char(3)` with `CHECK (currency = 'IRR')`, so adding currencies later is a migration, not a redesign.

## 2. Schema overview (module → tables)

| Module | Tables |
|---|---|
| identity | `users`, `user_identities`, `otp_challenges`, `user_credentials` (optional), `user_sessions`, `verification_tokens`, `roles`, `permissions`, `role_permissions`, `user_roles`, `admin_totp` |
| catalog | `categories`, `brands` (platforms/games), `products`, `product_variants`, `attribute_schemas`, `product_images`, `variant_price_history`, `regions` |
| inventory | `inventory_batches`, `digital_codes`, `stock_counters`, `inventory_reservations`, `inventory_movements` |
| suppliers | `suppliers`, `supplier_credentials`, `supplier_products`, `variant_supplier_routes`, `supplier_orders`, `supplier_order_events` |
| orders | `carts`, `cart_items`, `orders`, `order_items`, `order_status_history`, `order_holds`, `order_discounts` |
| payments | `payments`, `payment_events`, `refunds`, `refund_items`, `refund_status_history`, `payment_status_history` |
| ledger/wallet | `ledger_accounts`, `ledger_transactions`, `ledger_entries`, `ledger_account_balances`, `wallet_topups` |
| fulfillment | `fulfillment_tasks`, `fulfillment_events`, `deliveries`, `delivery_secrets`, `secret_access_log` (reveal events) |
| promotions | `discount_codes`, `discount_code_rules`, `discount_redemptions`, `campaigns`, `campaign_targets` |
| support | `tickets`, `ticket_messages`, `ticket_attachments`, `ticket_status_history` |
| platform | `idempotency_keys`, `outbox_events`, `notifications`, `audit_logs`, `state_transition_rules`, `encryption_keys` (metadata only), `system_settings`, `fraud_flags` |

This is a proposed inventory. Candidates to *drop or defer* if review agrees: `variant_price_history` (derive from audit log), `fraud_flags` (start as a column on orders).

## 3. Identity & access

**Decision D3: primary registration/login = mobile OTP. Email can be attached later. SMS provider not selected.**

- `users(id uuid PK, status, display_name, created_at, …)` — contains no login identifier itself.
- `user_identities(id, user_id, type ∈ PHONE|EMAIL, value, verified_at, is_primary, created_at)` with `UNIQUE(type, value)` and a partial unique index guaranteeing one primary identity per type per user. v1 requires a verified `PHONE` identity for every customer; `EMAIL` is optional and linkable later (OTP-proven phone first, then email verified by link/OTP). Phone is normalised to E.164 (`+98…`) with a CHECK; email is `citext`, lower-cased. Adding a future login method (e.g. OAuth) = new `type` value, not a schema redesign.
- `otp_challenges(id, identity_type, identity_value, purpose ∈ LOGIN|REGISTER|ADD_EMAIL|STEP_UP, code_hash, attempts, max_attempts, expires_at, consumed_at, ip, created_at)` — the OTP itself is stored **hashed**, single-use, short TTL (e.g. 2 min), limited attempts, resend cool-down and per-identity/per-IP daily caps (SMS cost abuse). Consumption is a conditional UPDATE (`WHERE consumed_at IS NULL AND expires_at > now() AND attempts < max_attempts`).
- SMS delivery sits behind a `SmsProvider` port; **no provider is selected and none is faked in production configuration**. Until one is chosen the OTP flow can be developed only against a clearly named test double that is rejected at boot when `NODE_ENV=production`.
- `user_credentials(user_id PK/FK, password_hash, algo, updated_at)` — **optional**; not used in v1 unless later decided (argon2id when present). Separate table so hashes are never selected with the user row.
- RBAC: `roles`, `permissions(code unique, e.g. 'ledger.adjust', 'codes.reveal', 'orders.refund')`, `role_permissions`, `user_roles`. Permissions are code-defined constants seeded by migration; app checks permission codes, never role names.
- Sensitive actions (`ledger.adjust`, `codes.reveal`, `suppliers.credentials.write`, `refunds.approve`, `orders.resolve_hold`) are separate permissions so no single "admin" owns everything. Optional four-eyes approval for adjustments above a threshold. **[OPEN B10]**
- `user_sessions`: server-side sessions (hashed session token, ip, ua, last_seen, revoked_at) → "log out all devices". Admin accounts additionally require TOTP 2FA (`admin_totp`, secret stored with envelope encryption).

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
- Pricing (all **Rial**, decision D1): `product_variants.price bigint CHECK (price >= 0 AND price % 10 = 0)`, `sale_price bigint NULL CHECK (sale_price IS NULL OR (sale_price < price AND sale_price % 10 = 0))`, `sale_starts_at/ends_at` with CHECK (ends > starts). The `% 10` constraint guarantees an exact Toman display. Price changes append to `variant_price_history`. Campaign/code discounts are *not* stored in variants.
- Publication: `status ∈ DRAFT|PUBLISHED|ARCHIVED`; a variant can only be PUBLISHED if its product is.

### 4.2 Constraints
`UNIQUE(slug)` per table; `UNIQUE(product_id, sku)`; partial index on published variants; FK `ON DELETE RESTRICT` everywhere in catalog (history must keep resolving).

## 5. Inventory

### 5.1 Two inventory shapes

| Shape | Used by | Representation |
|---|---|---|
| **Itemised** | `AUTO_CODE` gift cards, pre-loaded accounts | one row per item in `digital_codes` |
| **Counted** | the store's manually managed stock (`MANUAL`), and `SUPPLIER_API` (no pre-loaded items) | `stock_counters(variant_id, available, reserved, CHECK available>=0 AND reserved>=0)`, `NULL`/unlimited allowed for supplier-backed items |

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
6. **Late payment** (verified payment whose reservation is no longer ACTIVE): the lapsed reservation is never used for delivery; see §5.5 for the full policy.
7. Counted stock: `UPDATE stock_counters SET available=available-$n, reserved=reserved+$n WHERE variant_id=$v AND available>=$n` (affected rows = 0 ⇒ insufficient).

### 5.4 Movements

`inventory_movements(id, variant_id, code_id NULL, type, qty_delta, reservation_id, order_item_id, reason, actor, created_at)` — append-only (trigger). Types: `IMPORT, RESERVE, RELEASE, SELL, VOID, RETURN_TO_STOCK, ADJUST`. For itemised stock, `available` = count of AVAILABLE rows; a reconciliation job asserts it equals the sum of movements. `inventory_batches(supplier_id, cost_per_unit, currency, purchased_at, import_checksum)` holds cost basis (needed for COGS) and de-duplicates re-uploaded files.

### 5.5 Late payment, reservation expiry and settlement policy (decision 8)

**Principle: a code is delivered only against a reservation that was ACTIVE when the payment was verified. If the reservation has lapsed, the order goes to review and settlement — it is never delivered from stale state.**

1. **Consume on verify.** In the payment-success transaction the reservation is moved `ACTIVE → CONSUMED` by a conditional UPDATE (`WHERE status='ACTIVE' AND expires_at > now()`). Only a `CONSUMED` reservation permits `digital_codes → SOLD`.
2. **DB-level guard [VERIFIED].** A `BEFORE UPDATE` trigger on `digital_codes` rejects `→ SOLD` unless the code's reservation is `CONSUMED` (prototype `003_orders_payments.sql`, test group "LATE PAYMENT"). Even buggy application code cannot deliver from an expired/released/re-assigned reservation. A `SOLD` code is immutable except `SOLD → VOID` (found and fixed during prototype testing: an earlier draft allowed re-pointing a SOLD code to another order item).
3. **Verification grace (technical default `PAYMENT_VERIFY_GRACE_SECONDS=300`, configurable — NOT an approved business-policy value, see D9).** When a payment enters `VERIFYING`, the orchestrator (`orders`) calls `inventory.extendForVerification()`, which moves a still-ACTIVE, unexpired reservation's `expires_at` forward once. The sweeper stays payment-agnostic (inventory knows nothing about payments); it simply respects `expires_at`. The grace **never** revives an already EXPIRED/RELEASED reservation and never permits delivery without a CONSUMED reservation; if the reservation had already lapsed when verification completes, rule 4 applies unchanged.
4. **Late payment path.** If consume returns `LATE` (reservation EXPIRED/RELEASED, or order EXPIRED/CANCELLED):
   - the payment is still recorded as `SUCCEEDED` (the money genuinely arrived) and posted to the ledger into the **suspense account** `SUSPENSE_UNRESOLVED_RECEIPTS`, not to revenue/prepayment (§9.2);
   - the order moves to `ON_HOLD` with an open `order_holds` row (`reason = LATE_PAYMENT_NO_RESERVATION`); no fulfillment task is created;
   - outbox events notify the admin review queue and the customer ("payment received, your order is being settled").
5. **Settlement options** (permission `orders.resolve_hold`, audited, each with a mandatory note):
   - **Re-reserve:** create a *new* reservation through the normal atomic path (same `SKIP LOCKED` logic, new TTL). If every item is obtained, consume it, reclassify suspense → normal posting, `ON_HOLD → PAID`, continue standard fulfillment. This is the only route to delivery and uses fresh stock, not the lapsed reservation. The original order price snapshot is honoured.
   - **Wait for restock / substitute:** keep on hold; substitution changes order items with customer consent, and any price difference is refunded.
   - **Refund to wallet** (suspense → customer wallet) or **refund to gateway** (via refund workflow, only if the gateway supports it).
6. **Automation level (working rule, pending final approval D9):** in v1 every late payment is reviewed and settled **manually**. No automatic re-reservation exists in v1; the `late_payment.auto_rereserve` flag is not implemented. The complete late-payment policy still requires owner approval.
7. **Alerts:** holds older than a threshold (proposal 30 min) raise an alert; a hold cannot silently age.
8. Orders still `PENDING_PAYMENT` whose reservation expires become `EXPIRED` (no money involved). If a gateway success arrives afterward, rule 4 applies.

## 6. Secret storage (summary; full detail in `SECURITY.md`)

- Envelope encryption: random 256-bit **DEK per secret** → AES-256-GCM encrypts the payload (AAD = row id + kind, prevents ciphertext swapping) → DEK wrapped by a **KEK** held *outside* the database (`kek_version` column enables rotation by re-wrapping DEKs, no payload re-encryption).
- Duplicate detection key (HMAC pepper) is a **separate** key from the KEK.
- Plaintext exists only in memory during import and during an authorised reveal.
- Reveal is an explicit service call that writes `secret_access_log` (who, what, why, ip) *before* returning plaintext.

## 7. Orders

```
orders(id uuid, number text UNIQUE, user_id, status, payment_status,
       payment_method ∈ WALLET|GATEWAY, currency='IRR',
       subtotal, discount_total, total, placed_at, expires_at, …)   -- all money in Rial
order_items(id, order_id, variant_id, qty, unit_price, discount, line_total,
            name_snapshot, attrs_snapshot jsonb, fulfillment_method, fulfillment_status, …)
```
- **Everything the customer saw is snapshotted** on the item (name, attrs, unit price). Later catalog edits never alter history.
- CHECKs: `total = subtotal - discount_total`, `total >= 0`, `qty > 0`, `line_total = unit_price*qty - discount`.
- Prices, discounts and totals are **recomputed server-side** inside the checkout transaction from DB rows; nothing monetary is accepted from the client.
- The three concepts are separate: `orders.status` (lifecycle), `orders.payment_status` (aggregate cache of `payments`), `order_items.fulfillment_status` (per-item; source of truth is `fulfillment_tasks`). See `STATE_MACHINES.md`.
- **No split payment in v1 (decision D6).** An order is paid either entirely from the wallet (`payment_method = WALLET`, one ledger transaction, no gateway) or entirely through the gateway (`GATEWAY`). To use wallet money the customer tops up the wallet and pays by wallet. A partial-wallet/partial-gateway design is deliberately absent so there is no cross-instrument atomicity problem; adding it later is a new design, not a flag.
- `order_status_history(order_id, from, to, reason, actor, created_at)` append-only.
- `order_holds(id, order_id, reason ∈ LATE_PAYMENT_NO_RESERVATION|PAYMENT_NEEDS_REVIEW|FRAUD_REVIEW|FULFILLMENT_FAILED|SUPPLIER_UNKNOWN, opened_at, opened_by, resolved_at, resolution ∈ RESUMED|REFUND_WALLET|REFUND_GATEWAY|SUBSTITUTED|CANCELLED, resolved_by, note)`; partial unique index → at most one *open* hold per `(order_id, reason)`. An order is `ON_HOLD` iff it has an open hold (kept consistent by trigger).
- **Cancellation rules:** `PENDING_PAYMENT` → customer/system may cancel (reservation released). After `PAID`, cancellation = refund workflow (§10.2); delivered/revealed codes are not cancellable by the customer.

## 8. State machine enforcement

Pattern applied to orders, payments, fulfillment tasks, reservations, supplier orders, refunds, tickets:

1. `status` column typed as a PG enum or `text CHECK (status IN (…))`.
2. `state_transition_rules(machine, from_status, to_status)` seeded by migration from `STATE_MACHINES.md`.
3. `BEFORE UPDATE OF status` trigger rejects any `(old,new)` not in the table, and `AFTER UPDATE` writes the history row (so history cannot be skipped by buggy code).
4. Application layer also validates (fast, nicer errors) — the DB is the backstop.
5. Guard transitions with optimistic concurrency: `UPDATE … SET status=$new WHERE id=$id AND status=$expected` (0 rows ⇒ someone else moved it; treat as conflict, re-read).

## 9. Ledger (wallet & accounting)

Prototype **[VERIFIED]**: `docs/db-prototypes/001_ledger.sql`; tests (see `db-prototypes/LAST_RUN.txt`): balanced txn accepted, unbalanced rejected at COMMIT, overdraft rejected, duplicate posting rejected, UPDATE/DELETE/TRUNCATE blocked, late entries into a committed transaction rejected, 500 parallel wallet debits never overdraw.

### 9.1 Structure
- `ledger_accounts(type, normal_side, owner_type/owner_id, currency, min_balance)` — one **wallet account per user** (LIABILITY, `min_balance=0`), plus system accounts.
- `ledger_transactions(kind, idempotency_key UNIQUE, reference_type/id, reverses_id, created_by)` — the unit of posting.
- `ledger_entries(transaction_id, account_id, side, amount>0)` — ≥2 rows per transaction; sum(DEBIT) = sum(CREDIT) enforced by a **deferred constraint trigger at COMMIT**.
- `ledger_account_balances` — a *projection* maintained inside the same DB transaction by trigger (row lock serialises concurrent postings on one wallet; `CHECK (balance >= min_balance)` is the overdraft guard). **It is a cache, not truth**: a nightly job recomputes balances from entries and alerts on drift.
- Append-only: triggers block UPDATE/DELETE/TRUNCATE. Corrections = a new transaction with `reverses_id`.
- `pg_txid` guard: entries can only be inserted by the DB transaction that created their ledger_transaction.
- App DB role has `INSERT/SELECT` only on ledger tables (no UPDATE/DELETE grant) as a second layer.

### 9.2 Proposed Chart of Accounts (decision 10 — **PROPOSAL; revenue-recognition timing NOT final until an accountant approves**)

All accounts are in Rial. "Normal side" is the side that increases the balance. `Owner` = one account per owner when set.

| Code | Name | Type | Normal | Owner | Purpose |
|---|---|---|---|---|---|
| 1100 | `BANK_SETTLEMENT` | Asset | Debit | system | cash actually settled to the business bank account |
| 1200 | `GATEWAY_RECEIVABLE` | Asset | Debit | per gateway | money captured by a gateway, not yet settled to the bank (**gateway receipts**) |
| 1300 | `SUPPLIER_PREPAID` | Asset | Debit | per supplier | prepaid supplier balance (if that commercial model applies) |
| 1400 | `INVENTORY_DIGITAL` | Asset | Debit | system | cost basis of unsold codes/accounts |
| 2100 | `CUSTOMER_WALLET` | Liability | Credit | per user | **customer wallet liability** — what the store owes the customer; `min_balance = 0` |
| 2200 | `CUSTOMER_PREPAYMENTS` | Liability | Credit | system | paid but not yet delivered (used only under recognition mode B) |
| 2250 | `REFUNDS_PAYABLE` | Liability | Credit | per gateway | refund approved and owed back to a gateway/customer, not yet paid out |
| 2300 | `SUPPLIER_PAYABLE` | Liability | Credit | per supplier | owed to supplier (if pay-later model) |
| 2400 | `SUSPENSE_UNRESOLVED_RECEIPTS` | Liability | Credit | system | received money not yet attributable to a deliverable order (late payments, `NEEDS_REVIEW`); must trend to zero; aged-balance alert |
| 2600 | `TAX_PAYABLE` | Liability | Credit | system | **reserved** — VAT/tax treatment undecided |
| 3100 | `OWNER_EQUITY` | Equity | Credit | system | opening balances |
| 4100 | `SALES_REVENUE` | Revenue | Credit | system | recognised sales |
| 4200 | `SALES_REFUNDS` | Contra-revenue | Debit | system | refunds of already-recognised revenue |
| 5100 | `COGS` | Expense | Debit | system | cost of delivered items |
| 5200 | `GATEWAY_FEES` | Expense | Debit | per gateway | gateway commissions (recorded at settlement from gateway data; source of fee data unknown until a gateway is chosen) |
| 5300 | `SUPPLIER_FEES` | Expense | Debit | per supplier | optional |
| 5400 | `PROMO_CREDIT_EXPENSE` | Expense | Debit | system | goodwill / promotional wallet credits |
| 5500 | `ADJUSTMENT_EXPENSE` | Expense | Debit | system | admin manual adjustments (reason + approval mandatory) |
| 5600 | `CHARGEBACK_FRAUD_LOSS` | Expense | Debit | system | **reserved** |

**Revenue recognition — two candidate modes, both representable with the accounts above; the difference lives only in the ledger module's posting rules.**
- **Mode A — on payment:** payment posts straight to `SALES_REVENUE`.
- **Mode B — on delivery:** payment posts to `CUSTOMER_PREPAYMENTS`; delivery moves it to `SALES_REVENUE`.
*Working assumption for development only: Mode B.* The mode is a **code-level constant chosen at release time and recorded in the repository/release notes — it is deliberately NOT a free setting in the admin panel** (decision of 2026-11-01; an operator must not be able to flip accounting policy at runtime). It must be confirmed (or replaced) by an accountant, together with VAT treatment and the COGS method, **before launch**; the ledger is append-only, so the mode cannot be silently changed after real postings exist (a change needs an approved cut-over date). The same applies to the account list itself.

### 9.3 Standard postings (amounts in Rial; `D` = debit, `C` = credit)

| Event | Mode B (working assumption) | Mode A |
|---|---|---|
| Gateway wallet top-up verified | D `GATEWAY_RECEIVABLE` / C `CUSTOMER_WALLET` | same |
| Order paid from wallet | D `CUSTOMER_WALLET` / C `CUSTOMER_PREPAYMENTS` | D `CUSTOMER_WALLET` / C `SALES_REVENUE` |
| Order paid via gateway | D `GATEWAY_RECEIVABLE` / C `CUSTOMER_PREPAYMENTS` | D `GATEWAY_RECEIVABLE` / C `SALES_REVENUE` |
| Item delivered (auto code, manual or supplier) | D `CUSTOMER_PREPAYMENTS` / C `SALES_REVENUE`; D `COGS` / C `INVENTORY_DIGITAL` (or `SUPPLIER_PREPAID/PAYABLE`) | D `COGS` / C inventory/supplier only |
| Late / unattributable receipt | D `GATEWAY_RECEIVABLE` / C `SUSPENSE_UNRESOLVED_RECEIPTS`; later reclassified, refunded or re-attributed | same |
| Refund to wallet, before delivery | D `CUSTOMER_PREPAYMENTS` (or `SUSPENSE…`) / C `CUSTOMER_WALLET` | D `SALES_REFUNDS` / C `CUSTOMER_WALLET` |
| Refund to wallet, after delivery (policy-approved) | D `SALES_REFUNDS` / C `CUSTOMER_WALLET` (+ COGS decision: code not restocked ⇒ cost stays expensed) | same |
| Refund to gateway approved | D `CUSTOMER_PREPAYMENTS`/`SALES_REFUNDS`/`SUSPENSE…` / C `REFUNDS_PAYABLE`; on gateway payout: D `REFUNDS_PAYABLE` / C `GATEWAY_RECEIVABLE` | analogous |
| Gateway settles to bank | D `BANK_SETTLEMENT` + D `GATEWAY_FEES` / C `GATEWAY_RECEIVABLE` | same |
| Admin credit to wallet | D `ADJUSTMENT_EXPENSE` (or `PROMO_CREDIT_EXPENSE`) / C `CUSTOMER_WALLET` | same |
| Admin debit from wallet | D `CUSTOMER_WALLET` / C `ADJUSTMENT_EXPENSE` | same |
| Reversal of any posting | new transaction with swapped sides and `reverses_id` | same |

Discounts: the order `total` is already net; the discount lives in `order_discounts` for reporting. No ledger entry in v1.
Percentage rounding rule: `discount = floor(base * pct / 100)` in integer arithmetic, then floored to a multiple of 10 Rial; capped by `max_discount`; unit-tested. **[OPEN: confirm]**

### 9.4 Idempotency
Every posting derives its `idempotency_key` from its business cause (`topup:<payment_id>`, `orderpay:<order_id>`, `refund:<refund_id>`). A duplicate callback attempts the same key → UNIQUE violation → treated as "already done". Combined with the idempotent payment state transition (§11), duplicate callbacks cannot double-credit. **[VERIFIED at SQL level: 100 parallel duplicate callbacks → exactly 1 settlement, 1 ledger transaction, wallet credited once; the full application path is tested in Phase 2.]**

## 10. Fulfillment & delivery

- `fulfillment_tasks(id, order_item_id UNIQUE per attempt-chain, method, status, assignee, attempt, last_error, …)`, `fulfillment_events` (append-only log: created, assigned, supplier_submitted, delivered, failed, retried…).
- Created **only** when the order reaches `PAID` (guard: task insertion trigger checks order.payment_status='SUCCEEDED').
- `deliveries(order_item_id, kind, delivered_at)` + for itemised stock the link is `digital_codes.order_item_id`. For manual accounts / supplier-returned codes: `delivery_secrets(delivery_id, ciphertext, wrapped_dek, kek_version, …)`, same envelope scheme.
- **Delivery gate (invariant):** `digital_codes.status` may become `SOLD`, and a `delivery_secrets` row may be inserted, only if the order's payment status is `SUCCEEDED`. Enforced in the service layer **and** by a trigger checking the order row.
- `secret_access_log(secret_ref, actor, purpose, ip, created_at)` append-only.
- Customer access: reveal endpoint authorises `order.user_id = session.user_id`; admins need `codes.reveal` and the access is logged.

### 10.1 Delivery & disclosure tracking
For every delivery the system records, in append-only fashion, *what was delivered and what was shown*:
- `deliveries`: `delivered_at`, `delivery_kind`, `first_revealed_at`, `first_revealed_by_type ∈ CUSTOMER|ADMIN`, `last_revealed_at`, `reveal_count` (updated in the same transaction that appends to `secret_access_log`).
- `secret_access_log(id, delivery_id/secret_ref, actor_type, actor_id, action ∈ REVEAL|ADMIN_REVEAL|EXPORT, ip, ua, created_at)` — append-only; written *before* plaintext is returned.
- Derived **disclosure state** per order item: `NOT_DELIVERED` → `DELIVERED_UNREVEALED` → `REVEALED_BY_CUSTOMER` (or `REVEALED_BY_ADMIN_ONLY`). Limitation (documented): the server can only know that plaintext was *sent to a browser*, not whether the user copied or used the code.
- A `SOLD` code never returns to `AVAILABLE`. After refund it can only become `VOID` (default) — restocking a delivered code is unsafe because the secret has left the system.

### 10.2 Refund workflow for digital products (decision 9 — rules pending business + legal decision)
- `refunds(id, order_id, payment_id, requested_by, reason_code, amount, destination ∈ WALLET|GATEWAY, status, policy_version, eligibility_snapshot jsonb, decided_by, decided_at, override_reason)` and `refund_items(refund_id, order_item_id, amount, disclosure_state_at_request)`; `refund_status_history`.
- **Facts are captured, rules are configuration.** At request time the system snapshots each item's delivery/disclosure state (§10.1), fulfillment status, supplier-order status and payment/gateway refund capability into `eligibility_snapshot`. A versioned, configurable policy table maps `(product_type, disclosure_state, elapsed time)` → `AUTO_ALLOWED | REVIEW_REQUIRED | DENIED`.
- **Current policy is TEMPORARY (confirmed 2026-11-01) and needs legal review before it is finalised.** Launch default until the business/legal decision exists: undelivered items → refundable (approval by permission holder); anything `DELIVERED_UNREVEALED`, `REVEALED_*`, or supplier-confirmed → `REVIEW_REQUIRED` (never automatic); overriding a `REVEALED` item needs permission `refunds.override_revealed` and a written reason, both audited. These are *safe placeholders*, not the final policy.
- Refunds post to the ledger per §9.3 and change `payments.status` to `PARTIALLY_REFUNDED/REFUNDED`; they do not rewrite order history. Gateway refunds are used only if the chosen gateway supports them (unknown today); otherwise refunds default to wallet credit. **[OPEN B-refund, legal review]**

## 11. Payments

- `payments(id uuid, purpose ORDER|WALLET_TOPUP, order_id/topup_id (exactly one, CHECK), gateway, gateway_ref, amount (Rial), currency='IRR', status, created_at, verified_at)`; `UNIQUE(gateway, gateway_ref)`.
- `payment_events(id, payment_id, gateway, event_key, raw jsonb (redacted), received_at)` with `UNIQUE(gateway, event_key)` — every callback/webhook/verify response is logged once; dedupe by key (or by payload hash when the gateway has no event id).
- **Browser redirect is only a trigger to run server-to-server verification**; payment becomes `SUCCEEDED` only from a verified gateway response whose `amount` and reference match `payments` (mismatch ⇒ `NEEDS_REVIEW`).
- Success handler is one DB transaction: `payments → SUCCEEDED` (conditional UPDATE; only one concurrent handler wins), **reservation `ACTIVE → CONSUMED`** (if `LATE`, branch to the late-payment path §5.5: ledger → suspense, order `ON_HOLD`, nothing delivered), ledger posting (idempotency key), `orders → PAID`, outbox event `order.paid`.
- **Gateway: not selected (decision D4).** Nothing gateway-specific is designed or assumed — no endpoints, signature scheme, refund capability or Rial/Toman semantics. Only a `PaymentGateway` port (see `ARCHITECTURE.md`) exists; `payments.gateway` is a free `text` key resolved through configuration. Amounts passed to any adapter are Rial (the native unit of Iranian gateways in general is to be confirmed from the chosen gateway's documentation).
- Never store card data; only gateway reference, masked PAN if the gateway returns one, and amounts.

## 12. Suppliers

- `suppliers(id, name, adapter_key, status, config jsonb (non-secret))`, `supplier_credentials(supplier_id, ciphertext, wrapped_dek, kek_version, rotated_at)`.
- `supplier_products(supplier_id, external_sku, name, cost (Rial), currency, available, last_synced_at, raw_hash)`; `variant_supplier_routes(variant_id, supplier_product_id, priority, active)` allows multiple suppliers per variant with failover order.
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
| C6 | Reservation expiry vs concurrent payment | correctness | no double sale; late payment → `ON_HOLD` + suspense posting, never delivered from lapsed reservation **(SQL-level guard [VERIFIED])** |
| C7 | Direct SQL `UPDATE/DELETE` on ledger/movements | correctness | rejected |
| C8 | Invalid status transition via raw SQL | correctness | rejected by trigger (**pending**: generic transition-rule trigger not yet prototyped) |
| C9 | SOLD code re-pointed to another order item / returned to AVAILABLE | correctness | rejected **[VERIFIED]** |
| C10 | Late payment → admin re-reserve vs. concurrent buyers | correctness | delivery only from new CONSUMED reservation |
| S1 | **1,000 concurrent purchase attempts vs 10 codes** through the real checkout→pay→deliver path | stress | ≤ 10 successful allocations, 0 duplicate codes, inventory never < 0, every order/payment/fulfillment in a consistent terminal state, ledger balanced, `available + reserved + sold = total` |
| S2 | 500 concurrent wallet debits on one wallet | stress | never negative; sum of successes ≤ balance |

Proven at SQL-primitive level (40 checks, see `docs/db-prototypes/LAST_RUN.txt`): ledger invariants; S1 allocation core (1,000 attempts → exactly 10); S2 wallet floor (500 debits); counted-stock floor; duplicate callback and supplier-submission idempotency; late-payment delivery guard. **Not yet proven:** the application-level paths (C5, C10, S1 end-to-end, S2 via services), generic transition-rule triggers (C8).

## 17. Retention (PROPOSAL ONLY — nothing is deleted, purged or crypto-shredded until a policy is approved; Phase 2b implements no such path) **[OPEN: legal review]**
- Financial/ledger/orders/payments: retain indefinitely (or per Iranian tax/accounting rules — to be confirmed).
- Delivered secrets: encrypted payload kept for a customer-visible window (e.g. 12 months), then crypto-shredded (DEK destroyed) while the metadata/hash remain.
- `payment_events` raw payloads: 24 months then redact. Audit logs: ≥ 24 months. Sessions: 30 days after expiry.

## 18. ORM: Drizzle (decision D2)
Drizzle ORM is the data-access layer. PostgreSQL-specific features are **kept first-class**, not abstracted away:
- **Schema & types** in Drizzle (`pgTable`, enums, indexes, and `check()` where expressible) for typed queries.
- **Migrations are SQL files** under `db/migrations/`, reviewed by hand. Drizzle-generated SQL is accepted only after review; triggers, trigger functions, deferred constraint triggers, partial/expression indexes, grants and `CHECK`s that Drizzle cannot express are written as **custom SQL migrations** (drizzle-kit supports custom migrations — to be confirmed at scaffold time against the installed version).
- **`SELECT … FOR UPDATE SKIP LOCKED`** and the reservation/ledger functions are called via Drizzle's `sql` template (parameterised) inside `db.transaction(...)`; whether the query builder's locking clause is used directly is verified at scaffold time. The tested SQL in `docs/db-prototypes/` is the reference.
- CI job: apply all migrations to a clean PostgreSQL, run the SQL test suite (this prototype suite grows into it), and fail if the Drizzle schema and the migrated database drift.
- The application DB role is non-owner with DML-only grants (no UPDATE/DELETE on append-only tables).
