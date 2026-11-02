# PHASE_2B_PLAN.md — Core backend execution plan

Status: **v1.1 — P-1…P-9 APPROVED, D9 APPROVED, only step 2b-1a AUTHORISED (see DECISIONS.md).** Steps after 2b-1a are plans only. **No code and no migration has been created for Phase 2b.** Where this plan and `DECISIONS.md` disagree, `DECISIONS.md` wins.

Terminology: "SQL prototypes" = `docs/db-prototypes/` (design-validation scripts, 40 checks). "Application tests" = `tests/**` run by Vitest against the real code. They are reported separately (§8). **Passing prototypes is never evidence that the commercial system is ready.**

---

## 0. Scope and naming (needs your confirmation — P-2)
Your message treats "Phase 2b" as *the commercial backend modules*. The older roadmap split that into 2b–2f. This plan **merges 2b–2f into one Phase 2b divided into 10 small approvable steps (2b-1a … 2b-9)**, each ending in a review gate. Phase 3 (promotions, cart, support, notifications, fraud rules, reports) and Phase 4+ (UI) are untouched.

## 1. Re-review of existing documents — findings
I re-read `DECISIONS`, `IMPLEMENTATION_ROADMAP`, `ARCHITECTURE`, `DATABASE_DESIGN`, `SECURITY`, `STATE_MACHINES`, `OPEN_QUESTIONS`, `TECH_STACK`, `PHASE_2A_NOTES`. Problems found and how they are handled:

| # | Finding | Action |
|---|---|---|
| F1 | I had recorded **D9 as resolved** and written "5 minutes" as a decided policy. Your latest message says 300 s is only a **technical default** and the late-payment policy **still needs your approval**. | D9 re-opened in `OPEN_QUESTIONS`; `DECISIONS` E2 reworded; `DATABASE_DESIGN §5.5` reworded in this commit. "Manual review only" (E1) stays as the *current working rule*, not as final policy. |
| F2 | `DECISIONS` directive #8 still listed "auto re-reserve flag (default off), grace window, hold SLA" as open — stale vs E1/E2. | Updated. |
| F3 | `STATE_MACHINES`: late payment arriving for an `EXPIRED`/`CANCELLED` order (both terminal ■) moves it to `ON_HOLD` — contradicts "terminal". | Reworded: these two states are terminal *except* via a `LATE_PAYMENT_NO_RESERVATION` hold. Transition rule table must encode this explicitly. |
| F4 | `DATABASE_DESIGN §5.5` said the sweeper "skips reservations with a payment in VERIFYING". Inventory cannot know payments (module matrix). | Simplified: orders calls `inventory.extendForVerification()` which moves `expires_at` once; the sweeper stays payment-agnostic. | *(Later withdrawn entirely by D9: no extension exists.)*
| F5 | `DATABASE_DESIGN §17` proposes crypto-shredding of delivered secrets after 12 months. Your rule: **no financial/encrypted data is deleted without a defined policy.** | Retention stays a *proposal*. Phase 2b implements **no delete, purge or crypto-shred path** (P-7). |
| F6 | `ARCHITECTURE §3` says the payment-success handler is "one transaction incl. reservation consume and order PAID", but `payments` may not import `orders`/`inventory`. | Resolved by orchestration in `orders` (§5, step 2b-8): orders calls `payments`, `inventory`, `ledger` in one transaction. Contract written below. |
| F7 | Prototype `min_balance` is copied into `ledger_account_balances` at creation; later changes would not propagate. | `min_balance` is immutable after creation (trigger) — step 2b-2. |
| F8 | Prototype time-dependent functions use `now()`, making expiry boundaries untestable deterministically. | Time-dependent SQL takes an explicit `p_now` from an injected `Clock` (P-6). |
| F9 | Prototype ledger inserts entries in caller order → possible deadlocks between concurrent multi-account postings. | Ledger service inserts entries sorted by account id; deadlock test added. |
| F10 | `TECH_STACK` says `Rial` is "bigint-mapped" without saying how it appears in JS. | Decision proposed in P-9. |
| F11 | CI status was documented as "not run". **Actual: CI ran and passed** (see `DEPENDENCY_AUDIT.md §4`). | `PHASE_2A_NOTES` corrected. Open CI items remain (§9). |
| F12 | Earlier I reported "2 moderate npm audit findings". `npm audit` actually flags **20 packages**, caused by **2 advisories** propagating through the tree. | Corrected in `DEPENDENCY_AUDIT.md`. |

## 2. Invariants every step must preserve
1. No delivery before verified payment; no delivery without a `CONSUMED` reservation; one code → at most one order item.
2. Money is integer Rial; ledger is append-only, balanced at COMMIT; no UPDATE/DELETE/TRUNCATE path; corrections are reversing transactions.
3. Every state change goes through the transition engine (rule table + history); invalid transitions are rejected by PostgreSQL, not only by TypeScript.
4. External calls (gateway, supplier, SMS) never run inside a DB transaction; intent is persisted first, result recorded after.
5. No plaintext secret (code, credential, key, OTP, token) in DB, logs, errors, audit rows or test output; tests plant **canary secrets** and grep for them.
6. No real gateway, SMS or supplier API is invented. Test doubles are forbidden in production by configuration and by a lint/architecture rule.
7. Nothing financial, secret-bearing, audit, idempotency or outbox-dead-letter data is ever deleted (P-7).
8. Modular monolith: all work goes through module `index.ts` contracts and the matrix in `architecture/module-deps.cjs`.

## 3. Real dependency analysis (why this order)
Not the order of the module list. Derived from **(a)** the import matrix, **(b)** DB-level references, **(c)** which cross-cutting primitive each step needs:

```
platform primitives (money, ids, clock, errors, transitions, idempotency, outbox)   ← everything
platform crypto (KeyProvider, envelope, HMAC, TOTP, redaction)                      ← identity(TOTP), inventory, suppliers, fulfillment
audit ──────────────┐                                                               ← almost all (writes)
ledger (no deps) ───┼─► payments ─► wallet ─┐
identity ───────────┤                       │
catalog ─► pricing ─┼─► inventory ─────────►│
                    └─► suppliers ─► fulfillment ─► orders ─► refunds
```
Key consequences:
- **ledger, audit and platform have zero module dependencies** → they go first; every money-touching step is built on a verified ledger.
- **identity before anything user-facing**, but nothing financial needs it (user ids are opaque to ledger/wallet) → it can follow the ledger.
- **inventory needs crypto and catalog**; it does **not** need orders (opaque `order_ref`); the reverse FKs are added later by the later module's migration (P-1).
- **orders is the last orchestrator**: it is the only module whose matrix list contains payments, wallet, inventory, fulfillment together. Building it earlier would force stubs of five modules.
- **refunds** need orders + payments + ledger + fulfillment disclosure data → last.
- `cart`, `promotions`, `fraud`, `support`, `notifications` are **not** prerequisites of a correct checkout; pricing ships without promotions in 2b (hook added in Phase 3 — matrix already allows `pricing → promotions`). Cart is deferred to Phase 4 (checkout takes explicit lines + idempotency key).

## 4. Proposed steps (each a review gate)
| Step | Name | Modules | New migrations (names are proposals) | Blocking inputs |
|---|---|---|---|---|
| **2b-1a** | Platform primitives | platform | `0002_transition_engine`, `0003_idempotency_outbox`, `0004_db_roles_and_grants` | P-decisions only |
| **2b-1b** | Crypto & secrets plumbing | platform | none (no tables) | none for code; **D8 before any real secret/inventory** |
| **2b-2** | Audit + Ledger | audit, ledger | `0005_audit_logs`, `0006_ledger_core`, `0007_ledger_integrity` | none (chart stays *proposed*, D10 before launch) |
| **2b-3** | Identity | identity | `0008_identity_core`, `0009_otp_sessions_rbac`, `0010_rate_limits` | B11 (role matrix) to finalise seeds; X2 only for production SMS |
| **2b-4** | Catalog + minimal pricing | catalog, pricing | `0011_catalog_core`, `0012_catalog_variants_pricing` | none (B1 only for real data) |
| **2b-5** | Inventory | inventory | `0013_inventory_core`, `0014_inventory_guards` | B3 (TTL) ; **D8 before real codes** |
| **2b-6** | Payments + Wallet | payments, wallet | `0015_payments_core`, `0016_wallet_topups` | none (X1 only for a real gateway) |
| **2b-7** | Suppliers + Fulfillment | suppliers, fulfillment | `0017_suppliers_core`, `0018_fulfillment_core` | B2, B7; X3 only for a real supplier |
| **2b-8** | Orders, checkout, late-payment path | orders | `0019_orders_core`, `0020_cross_module_guards` | B3; the operational use of the handling window (confirm in step plan) |
| **2b-9** | Refunds + reconciliation + phase closure | orders/payments/wallet/fulfillment (refund use cases in `orders`), worker | `0021_refunds`, `0022_reconciliation_findings` | **B12 legal**, B13 |

Each step: (1) you approve the step plan, (2) I implement only that step, (3) full report: application tests and SQL-prototype regression reported separately, plus "not tested" list, (4) you approve the next.

---

## 5. Step details
Notation — **Contract** = what other modules may import from `index.ts` (proposed names, not final). Migration numbers continue after `0001_platform_primitives`.

### 2b-1a Platform primitives  *(IMPLEMENTED — as-built details, deviations and test results: `PHASE_2B_1A_NOTES.md`)*
- **Build:**
  - `platform/money` (Rial type, checked arithmetic, `rialToToman`, `tomanToRial`, `formatToman`; multiples-of-10 validator), `platform/ids` (UUIDv7 generator; non-guessable order-number generator), `platform/clock` (`Clock` port + `SystemClock`, `FixedClock` for tests), `platform/errors` (typed `DomainError` with stable codes, no secret interpolation).
  - **Transition engine:** table `state_transition_rules(machine, from_status, to_status)` (unique); generic trigger function `platform_enforce_transition()` (validity) and `platform_record_transition()` (writes a row into the entity's history table; actor/reason read from transaction-local `set_config('app.actor_id'/'app.reason')`). Owner modules create their own history tables and attach the triggers. **(P-3)**
  - `idempotency_keys` and `withIdempotency(tx, scope, key, requestHash, fn)` (same key + different hash → rejected; concurrent identical → one execution; result stored).
  - `outbox_events` (+ dead-letter state, never deleted), `enqueue(tx, event)`, `claimBatch` with lease (`SKIP LOCKED`, `locked_until`), `ack/fail` with backoff, worker loop + handler registry (no handlers yet).
  - DB roles/grants **(P-4)**: ops script `db/ops/roles.sql` (not a migration) creates `giftcard_migrator`, `giftcard_app`, `giftcard_readonly`; migration `0004` only issues `GRANT/REVOKE` to those names; append-only tables get `INSERT, SELECT` only for `giftcard_app`.
- **Contracts (platform, importable by all modules):** `Rial`, `Clock`, `newId()`, `DomainError`, `withTransaction`, `withIdempotency`, `outbox.enqueue`, `attachTransitionGuard(table, machine)` (SQL helper used in owner migrations).
- **Tests**
  - *Unit:* money (overflow guard, ×10 conversions, multiples-of-10, floor rounding of percentages, negative rejection, never-float); uuidv7 ordering/version bits; error code stability.
  - *Database:* every `(from,to)` not in the rule table rejected (C8); history row created even when app code "forgets"; actor/reason captured; rule table cannot be edited by `giftcard_app`; grants test creates the three roles in a throwaway DB and proves `giftcard_app` cannot UPDATE/DELETE/TRUNCATE a guarded table.
  - *Integration:* idempotency replay returns stored result; different hash → conflict; outbox event invisible until commit (rollback test).
  - *Concurrency:* 50 parallel identical idempotent calls → 1 execution; 4 claimers × 500 events → each event leased by exactly one claimer; killed claimer's lease expires and is re-claimed; no event lost.
- **Acceptance:** all above pass in CI; `npm run check` clean; boundary rules extended so production code cannot import `**/testing/**` doubles except through the guarded factory (P-5).
- **Risks:** *financial* — rounding rule errors (mitigated by exhaustive table tests); *security* — wrongly granted privileges (grants test), trigger bypass by superuser (documented limitation, mitigated by audit shipping later).

### 2b-1b Crypto & secrets plumbing (no tables)  *(IMPLEMENTED — details in `PHASE_2B_1B_NOTES.md` and `CRYPTO_DESIGN.md`; **TOTP was NOT built**: design-only, see `TOTP_DESIGN.md`; `redact()` was extended with a minimal structured logger)*
- **Build:** `KeyProvider` port (`currentVersion`, `wrap/unwrapDek`, `hmacKey`, `listVersions`); `EnvelopeCipher` (AES-256-GCM, fresh random DEK per secret, 96-bit random nonce, **AAD = table|row-id|kind**); `rewrapDek(from→to)`; `codeHash` (HMAC-SHA256 with a key distinct from the KEK, versioned); RFC 6238 TOTP helper (no dependency); `redact()` log/error scrubber; provider **conformance test-suite** that any future provider must pass; `DevKeyProvider` (key material from a local env var, **rejected when `NODE_ENV=production`**, `KEY_PROVIDER` env: `none|dev`; `none` ⇒ crypto features fail closed).
- **No production provider is written** — D8 (custody method) is open. The conformance suite makes the future choice (root-only file, secret manager, …) a plug-in.
- **Contract:** `encryptSecret/decryptSecret`, `codeHash`, `rewrap`, `totp`, `redact`.
- **Tests:** round-trip; tamper of ciphertext/tag/AAD/row-id swap each detected; wrong key version; 10 000 encryptions → unique nonces and DEKs; rotation preserves plaintext and old-version rows remain readable until re-wrapped; HMAC deterministic, differs from any KEK-derived value; RFC 6238 vectors; `redact()` removes canary strings from nested objects/errors; production guard test (dev provider refused).
- **Acceptance:** conformance suite green for DevKeyProvider; documented rotation procedure test passes; no key bytes ever logged.
- **Risks:** *security* — nonce misuse, key in logs/heap dumps, silent fallback to weak key (fail-closed test), AAD omitted. KEK loss is an operational risk owned by D8.

### 2b-2 Audit + Ledger
- **Tables/migrations:** `audit_logs` (append-only, partial redaction at write, request id, actor type); `ledger_accounts`, `ledger_transactions`, `ledger_entries`, `ledger_account_balances` + triggers (entries only in creating txn, balanced at COMMIT, floor, append-only incl. TRUNCATE, immutable `min_balance` F7, unique reversal per transaction), `chart_version` column. **No accounts seeded by migration** — accounts are created by code from a versioned *proposed* chart (`chart: 'proposed-0'`), so the accountant's later changes don't require rewriting history.
- **Rewritten from the prototype with review changes:** F7, F9, explicit mapping of the floor violation to `INSUFFICIENT_FUNDS`, `currency = 'IRR'` CHECK, amounts > 0, `reverses_id` partial unique.
- **Contracts:** `audit.record(tx, entry)`; `ledger.ensureAccount(tx, spec)`, `ledger.post(tx, {kind, idempotencyKey, ref, entries})`, `ledger.reverse(tx, txnId, reason)`, `ledger.balance(tx, accountId)`, `ledger.verifyIntegrity()`; pure posting-rule builders for the proposed chart (`REVENUE_RECOGNITION = 'ON_DELIVERY'` is a **code constant labelled provisional — not an env/admin setting**, E4).
- **Tests:** *Database* — unbalanced rejected, late entry rejected, UPDATE/DELETE/TRUNCATE blocked, floor, idempotent duplicate, double reversal rejected. *Integration* — post/reverse round-trips; projection == recomputation; `verifyIntegrity` **detects** corruption injected by a superuser in the test. *Property-style* (seeded RNG, no new dependency) — 2 000 random balanced postings over 20 accounts: Σ=0 always, projection always equals recomputation. *Concurrency* — S2 500 parallel debits on one wallet (exactly ⌊balance/amount⌋ succeed, never negative); 200 parallel random-pair transfers (no deadlock, totals conserved); 100 parallel same-key postings → 1.
- **Acceptance:** all ported prototype ledger checks exist as application tests; integrity verifier green; audit rows contain no canary secrets.
- **Risks:** *financial* — sign/side errors, lost updates, deadlock, accounting policy not final (outputs flagged provisional); *security* — privileged tampering (detected, not prevented); audit log growth (no purge, P-7).

### 2b-3 Identity (OTP, sessions, RBAC)
- **Tables:** `users`, `user_identities` (PHONE now, EMAIL attachable; E.164 CHECK; one primary per type), `otp_challenges` (hashed code), `user_sessions` (hashed token), `roles`, `permissions`, `role_permissions`, `user_roles`, `admin_totp` (secret via envelope), `rate_limit_counters` (Postgres-backed limiter).
- **Contracts:** `identity.requestOtp(ctx)`, `verifyOtp(ctx) → session`, `getSession(token)`, `revokeSession/revokeAll`, `authorize(actor, permission, resource?)`, `requirePermission`, `SmsProvider` port (+ `TestSms` capture, forbidden in production), `normalizePhone`. Permission codes are code constants seeded by migration; **no default admin and no default credentials** — first admin created only by an explicit operator script run with a phone allow-list.
- **Independent (private):** OTP hashing/attempt logic, session storage, limiter internals, TOTP storage. **Public:** the functions above and the `Actor`/`Permission` types.
- **Tests:** *Unit* — phone normalisation table (Persian/Arabic digits, `09…`, `+98…`, invalid); TOTP vectors. *Database* — no plaintext OTP/token in any column (canary grep), E.164 CHECK, one primary identity. *Integration* — enumeration-safe responses (identical shape/timing class for known/unknown numbers); expiry/attempts/resend cool-down via `FixedClock`; session rotation, idle/absolute timeout, revoke-all; permission matrix; step-up requirement for sensitive actions. *Concurrency* — 50 parallel verifications of one OTP → exactly 1 success; limiter under 200 parallel requests never admits more than its quota.
- **Acceptance:** all above; no SMS content in logs; `authorize` is the only way services check access.
- **Risks:** *security* — SMS-pumping cost, OTP brute force (6 digits), SIM-swap, session fixation, admin bootstrap abuse, IDOR; *financial* — indirect (account takeover → wallet). **Open:** B11, T7 (custom OTP module recommended), X2 (production SMS only).

### 2b-4 Catalog + minimal pricing
- **Tables:** `categories` (tree + path), `brands`, `regions`, `products`, `product_variants` (fulfillment_method, region, denomination/duration columns, `attrs jsonb`), `attribute_schemas`, `product_images` (metadata only; no upload yet — T6), `variant_price_history` (trigger-appended). CHECKs: `price % 10 = 0`, `sale_price < price`, sale window, slug unique; trigger: variant can be PUBLISHED only if its product is.
- **Contracts:** `catalog.getSellableVariants(ids)` / `getVariantSnapshot(id)` (name, attrs, price, fulfillment method — used by orders to snapshot), `listPublished(filters)`, admin use cases (permission + audit). `pricing.quote(lines)` → Rial totals computed from DB rows only (promotions hook arrives in Phase 3).
- **Independent (private):** attribute-schema validation, tree maintenance, price history trigger, SEO fields. **Public:** read DTOs with explicit column lists.
- **Tests:** *Database* — every CHECK/trigger; *Unit* — per-type Zod attribute schemas; *Integration* — public DTO leak test (no key matching `cost|supplier|secret|internal`), publish rules, price-history append; *Concurrency* — quote takes `FOR SHARE` on variant rows so a concurrent price change cannot yield a mixed quote (test with parallel updater).
- **Acceptance:** client-supplied prices are structurally impossible (quote API has no price input).
- **Risks:** *financial* — stale/tampered price, free items via 0-price publish (CHECK `price > 0` for PUBLISHED); *security* — stored XSS in descriptions (sanitised at render in Phase 4; DTO marks fields as untrusted text). **Open:** B1 (real catalog) not needed.

### 2b-5 Inventory
- **Tables:** `inventory_batches`, `digital_codes` (status_links CHECK, UNIQUE `code_hash`, UNIQUE `order_item_id`, `payload_kind`), `inventory_reservations` (+ lines for counted stock), `inventory_movements` (append-only), `stock_counters`. Triggers: SOLD requires CONSUMED reservation; SOLD immutable except →VOID; code & reservation transitions via the engine; floor CHECKs.
- **Reviewed vs prototype:** time via `p_now`; reservation lines unified for itemised + counted stock; `order_ref` is an opaque id (FK added in 2b-8, P-1).
- **Contracts:** `inventory.importCodes(tx, batch, codes[])` (returns counts/duplicates — **never echoes codes**), `reserve(tx, {orderRef, lines, ttl})`, `consume(tx, reservationId) → CONSUMED | LATE`, `release`, `sweepExpired(batchSize)`, `markSold(tx, reservationId, itemMap)`, `unsealForDelivery(tx, codeId, DeliveryCapability)` (capability object minted only by fulfillment), `availability(variantId)`.
- **Independent (private):** crypto fields, hashing, movement bookkeeping, SQL for `SKIP LOCKED`. **Public:** the contract above; ciphertext columns are unreachable to other modules (schema is private).
- **Tests:** *Database* — status_links, dedupe, SOLD guard/immutability, negative stock, movement append-only. *Integration* — import dedupe (in-file, cross-batch, cross-variant), canary secret never in tables/logs/errors, `available+reserved+sold+void = total`, movements reconcile with state. *Concurrency* — **S1-core through the service: 1 000 attempts vs 10 codes** (≤10 reservations, 0 duplicates); chaos run of 5 000 random reserve/release/expire/consume ops with invariants checked at the end; **C6: consume vs sweeper racing at the expiry boundary 200× — never both, never SOLD from a lapsed reservation**; counted stock 1 000 vs 10.
- **Acceptance:** guards hold even when the service layer is bypassed with raw SQL; sweeper metrics exposed (stuck-reserved count).
- **Risks:** *financial* — double sale, phantom stock; *security* — plaintext in memory/logs/error messages/temp files during import, KEK loss (D8). **No real inventory is loaded before D8 is settled.** Open: B3 (TTL; default 15 min is a config value), B2.

### 2b-6 Payments + Wallet
- **Tables:** `payments`, `payment_events` (UNIQUE gateway+event_key), `payment_status_history`, `wallet_topups`. Wallet balances live in the ledger (account per user, created lazily).
- **Contracts (payments):** `PaymentGateway` port (`createPayment`, `verifyPayment`, `capabilities`) — **hypothesis, finalised only with real docs**; `TestGateway` (scriptable: success, failure, mismatch, timeout, duplicate callback; forbidden in production); `initiate`, `beginVerification(tx,id)` → won/lost, `recordVerificationResult(tx, id, result)` → `SUCCEEDED | FAILED | NEEDS_REVIEW` (exact integer Rial equality). **Contracts (wallet):** `topUp.start/complete`, `payFromWallet(tx, userId, amount, ref, idemKey)`, `balance`, `adjust` (permission + mandatory reason + audit; four-eyes per B10).
- **Flow rule:** verification is 3-phase — (1) tx: conditional `PENDING→VERIFYING`; (2) external verify **outside** any transaction; (3) tx: record result. A timeout is *not* a failure (stays `VERIFYING`/`NEEDS_REVIEW`, retried).
- **Tests:** *Concurrency* — **C3: 100 parallel duplicate callbacks → 1 settlement, 1 ledger txn, wallet credited once**; only one `VERIFYING` winner; 500 parallel wallet payments never overdraw (S2 via service). *Integration* — amount mismatch → `NEEDS_REVIEW` and money to suspense, unknown/forged reference harmless, replay after SUCCEEDED is a no-op, every SUCCEEDED payment has exactly one ledger transaction (reconciliation query). *Unit* — state-machine table tests.
- **Acceptance:** no code path marks a payment SUCCEEDED from a browser redirect; `TestGateway` refused in production.
- **Risks:** *financial* — double credit, amount tampering, race top-up/spend; admin adjustments as laundering/abuse vector; *security* — callback spoofing (design: verify server-to-server), logging gateway payloads (redacted). **Open:** X1 (real gateway), B5 (wallet limits), B10.

### 2b-7 Suppliers + Fulfillment
- **Tables:** `suppliers`, `supplier_credentials` (envelope-encrypted), `supplier_products`, `variant_supplier_routes`, `supplier_orders` (UNIQUE supplier+idempotency key), `supplier_order_events`; `fulfillment_tasks`, `fulfillment_events`, `deliveries` (reveal counters), `delivery_secrets`, `secret_access_log` (append-only).
- **Contracts:** `SupplierAdapter` port (capabilities explicit, never assumed) + `TestSupplier` (confirm/reject/timeout/duplicate); `suppliers.submit/reconcile`; `fulfillment.createTasks(tx, items)` (called by orders after PAID), `deliverAutoCodes`, manual flow (`claim`, `complete(credentials)`), `reveal(actor, deliveryId)` (**logs before returning plaintext; if logging fails nothing is returned**), `deliveryStatus(orderItemId)`.
- **Rules:** persist `SUBMITTING` + idempotency key **before** calling the supplier; timeout ⇒ `UNKNOWN` (no automatic retry); `CONFIRMED` only on explicit confirmation; reject ⇒ next route or manual fallback; outbound hosts come from configuration only (no user-controlled URLs).
- **Tests:** *Concurrency* — **C4** duplicate submission with one key → one supplier order; two admins claiming one manual task → one wins; outbox redelivery of "deliver" → idempotent; 100 parallel reveals → counters exact. *Integration* — **C5** failure never completes order/task; UNKNOWN never retried blindly and resolves via reconciliation; reveal IDOR (user B cannot read A's); canary credential never in logs/audit; log-failure ⇒ no reveal. *Database* — task transition rules; `delivery_secrets` has no plaintext.
- **Acceptance:** the **payment-gate trigger** (delivery requires paid order) cannot exist yet because `orders` doesn't — it is installed in 2b-8 (`0020`), and 2b-7 acceptance records that explicitly.
- **Risks:** *financial* — duplicate supplier purchase, false confirmation; *security* — credential exposure, insider reveal (permissioned + logged), SSRF, secrets in supplier request logs (redacted). **Open:** X3, B2, B7.

### 2b-8 Orders, checkout, late-payment path
- **Tables:** `orders` (`payment_method ∈ WALLET|GATEWAY`, no split), `order_items` (snapshots), `order_status_history`, `order_holds`. **`0020_cross_module_guards`:** FKs from `digital_codes.order_item_id`, `inventory_reservations.order_ref`, `payments.order_id`, `fulfillment_tasks.order_item_id` to the orders tables; **delivery gate trigger** (a delivery can be inserted only if the order's payment is SUCCEEDED and its reservation CONSUMED); order transition rules incl. the F3 late-payment exception.
- **Contracts:** `orders.checkout(actor, lines, paymentMethod, idempotencyKey)`, `orders.confirmGatewayPayment(paymentRef)` (3-phase), `orders.cancel`, `orders.expireStale()` (worker), `orders.resolveHold(actor, holdId, {RE_RESERVE | KEEP_ON_HOLD})` (refund-based resolutions arrive in 2b-9), `orders.get(actor, id)` (owner-checked).
- **Orchestration contract (F6):** `orders` is the only caller that combines `payments`, `inventory`, `wallet/ledger`, `fulfillment` in one transaction; modules below it never import `orders` (they emit outbox events).
- **Late payment (D9, APPROVED):** consume returns `LATE` ⇒ payment recorded SUCCEEDED, ledger → `SUSPENSE_UNRESOLVED_RECEIPTS`, order `ON_HOLD` + `order_holds` row, **no task, nothing SOLD**; resolution only by a permissioned human; `RE_RESERVE` creates a *new* reservation. `LATE_PAYMENT_HANDLING_WINDOW_SECONDS=300` is a handling-policy parameter only; **no reservation TTL is ever extended**, and an expired reservation is never used for delivery.
- **Tests:** *Integration* — client-supplied price ignored; insufficient stock leaves no order/reservation (rollback); same idempotency key → same order; **C2/C6/C10** end-to-end incl. late-payment → hold → re-reserve → delivery; failure injected after ledger posting rolls everything back; owner-only reads (IDOR). *Concurrency* — **S1 end-to-end: 1 000 concurrent checkout→pay→deliver attempts on 10 codes** (wallet-paid, then TestGateway-paid, then mixed): ≤10 deliveries, 0 duplicate codes, no negative stock, every order/payment/task in a consistent state, ledger balanced, `available+reserved+sold=total`; sweeper-vs-payment race. *Database* — gate trigger rejects delivery for unpaid order even via raw SQL.
- **Acceptance:** S1 end-to-end green; invariants query-set returns zero violations; late-payment path behaves exactly as the approved D9 policy (tests assert: no TTL extension, no delivery from an expired reservation).
- **Risks:** *financial* — money without delivery or delivery without money, orphan reservations, replay/double submit; *security* — IDOR, order enumeration (non-guessable numbers), privilege use in hold resolution.

### 2b-9 Refunds, reconciliation, closure
- **Tables:** `refunds`, `refund_items` (disclosure snapshot), `refund_status_history`, `reconciliation_findings` (append-only), versioned `refund_policy` config table.
- **Contracts:** `orders.requestRefund`, `evaluateRefundPolicy` (policy as data; **current temporary rules**: undelivered ⇒ refundable, anything delivered ⇒ review, revealed ⇒ override permission + reason), `approve/reject`, `execute` (ledger postings per the provisional chart; wallet credit; gateway refund only if the adapter reports the capability), delivered code ⇒ `VOID`, never restocked; hold resolutions `REFUND_WALLET` / `REFUND_GATEWAY`; worker reconciliation jobs (ledger integrity, payments↔ledger, inventory↔movements, orphan reservations, aged holds, supplier UNKNOWN aging, outbox lag/dead letters).
- **Tests:** unique active refund per item (concurrent duplicate request → 1); double-approval race; refund after reveal blocked without override; ledger remains balanced after every refund path; reconciliation detects injected faults (one per job); full acceptance run of S1 + S2 + invariants.
- **Acceptance:** phase-closure report with the §8 honesty sections; remaining legal/accounting gates listed as launch blockers.
- **Risks:** *financial* — double refund, refund of consumed value, wallet used as cash-out proxy (no cash-out exists), mis-posted reversals; *legal* — refund rules are temporary (B12).

---

## 6. Module independence vs public contracts (all 16 modules)
Rule for all: **tables, SQL, schema.ts, triggers' helper functions and crypto fields are private to the owning module; other modules see only `index.ts`.** DB-level FKs from later modules to earlier modules' tables are allowed (P-1); reverse references are opaque ids until the later module's migration adds the FK.

| Module | Private (not importable) | Public contract (`index.ts`) | May import |
|---|---|---|---|
| audit | table, redaction details | `record` | — |
| ledger | all tables/triggers, balance projection, chart internals | `post`, `reverse`, `balance`, `ensureAccount`, `verifyIntegrity`, posting-rule builders | — |
| identity | OTP/session/limiter internals, TOTP storage | `requestOtp`, `verifyOtp`, `getSession`, `authorize`, `Actor`, `Permission`, `SmsProvider` port | audit |
| catalog | tree/attr-schema logic, price-history trigger | variant snapshot/lookup, published listing DTOs, admin use cases | audit |
| pricing | — | `quote` | catalog, promotions (Phase 3) |
| inventory | ciphertext, hashing, SKIP LOCKED SQL, movements | `importCodes`, `reserve`, `consume`, `release`, `sweepExpired`, `markSold`, `unsealForDelivery`(capability), `availability` | catalog, audit |
| suppliers | credentials, adapter registry, supplier SQL | `submit`, `reconcile`, `SupplierAdapter` port, admin use cases | catalog, audit |
| payments | payment SQL, event log | `initiate`, `beginVerification`, `recordVerificationResult`, `PaymentGateway` port | ledger, audit |
| wallet | topup table | `topUp.*`, `payFromWallet`, `balance`, `adjust` | ledger, payments, audit |
| fulfillment | tasks, secrets, access log | `createTasks`, `deliverAutoCodes`, manual flow, `reveal`, `deliveryStatus` | inventory, suppliers, ledger, catalog, audit |
| orders | order tables, holds, refund SQL | `checkout`, `confirmGatewayPayment`, `cancel`, `expireStale`, `resolveHold`, refund use cases, `get` | cart, catalog, pricing, promotions, inventory, payments, wallet, fulfillment, ledger, fraud, identity, audit |
| cart, promotions, fraud, support, notifications | *(not built in 2b)* | — | per matrix |

## 7. Cross-cutting decisions proposed (need your approval)
| ID | Proposal |
|---|---|
| P-1 | **Cross-module FKs:** allowed in SQL from later modules to earlier ones; reverse-direction references start as opaque ids and the FK is added by the later module's migration (`0020`). Application code still never touches another module's tables. |
| P-2 | **Merge old 2b–2f into one Phase 2b** with the 10 steps above. |
| P-3 | **Trigger-based transition validation + history** via a generic engine and `set_config('app.actor_id'/'app.reason', …, true)`. Alternative (history written only in services) is simpler but skippable. Recommend triggers. |
| P-4 | **Roles/grants:** ops script creates roles; migrations only GRANT/REVOKE to them; `giftcard_app` has no UPDATE/DELETE on append-only tables. Production role creation is an operational step tied to D8. |
| P-5 | **Test doubles** (`DevKeyProvider`, `TestGateway`, `TestSms`, `TestSupplier`) live under `**/testing/`, are blocked in production by env validation and by a new dependency-cruiser rule. |
| P-6 | **Time:** `Clock` port; time-dependent SQL functions take `p_now`. |
| P-7 | **No deletion:** no DELETE/TRUNCATE grants, no purge jobs, no crypto-shredding in 2b for financial, secret-bearing, audit, idempotency or outbox tables, until a retention policy is approved. |
| P-8 | **No new runtime dependencies expected** (UUIDv7, TOTP, crypto in-house on Node built-ins). If one becomes necessary I will report before adding it. |
| P-9 | **Rial in TypeScript (APPROVED):** branded `number` restricted to safe integers (`Number.isSafeInteger` guard, arithmetic only via `platform/money`); limits enforced in domain **and** PostgreSQL domains; JSON amounts named `amountRial`. |

## 8. Test taxonomy and honest reporting
- **Unit** — pure logic, no DB. **Integration** — service + real PostgreSQL. **Database** — SQL-level guards exercised with raw SQL (bypassing services). **Concurrency/stress** — real parallel connections, invariants asserted afterwards. All run through Vitest projects (`unit`, `db`; a `stress` project is added in 2b-1a so slow tests are separable but still in CI).
- **Prototype suite stays separate**, frozen as a *design regression* (`npm run test:sql-prototypes`, separate CI step). Mapping prototype → application test is tracked per step; when a prototype check has an application equivalent, the report shows both counts.
- **Every step report must contain:** (1) application tests: counts and names, (2) SQL-prototype regression: separate count, (3) explicitly **not tested** items, (4) deviations from this plan, (5) new risks. I will never describe prototype or stress results as system readiness; production readiness remains a Phase 6 claim backed by the §13 checklist in `SECURITY.md`.
- **Flakiness policy:** concurrency tests assert invariants, not timings; a test that cannot be made deterministic is reported, not deleted.

## 9. Open decisions and blockers
| ID | Item | Needed by | Status |
|---|---|---|---|
| P-1…P-9 | Cross-cutting proposals above | — | **APPROVED** |
| D9 | Final late-payment policy | — | **APPROVED** (see DECISIONS) |
| D8 | VPS + KEK custody | before any real secret/inventory; not before code | open |
| D10 | Accountant: chart, recognition, VAT, COGS | launch gate (not 2b) | open |
| B12/B13 | Refund rules (legal) / gateway refund need | final of 2b-9 / launch | open — temporary rules in use |
| B11 | Admin roles & permission matrix | 2b-3 seeds | proposal needed → **I will propose a default matrix in the 2b-3 step plan** |
| B3 | Reservation TTL (default 15 min) | 2b-5 | config value, confirm |
| B2, B7 | Account stock model; reveal channel | 2b-7 | confirm |
| B5, B10 | Wallet limits; four-eyes thresholds | 2b-6 | confirm |
| T2, T5, T6, T7 | PG version, monitoring, object storage, OTP library | as noted | low risk |
| X1–X3 | Gateway, SMS, supplier documentation | only for *real* adapters — **not blockers for 2b** | open |
| CI | GitHub Actions: first run **passed** on `a2719c7`; still open: confirm required-status/branch protection, rerun after dependency changes, add `npm audit` reporting step, pin action versions by SHA | 2b-1a | open (see `DEPENDENCY_AUDIT.md`) |
| DEP | Apply (or reject) the audit-fix `overrides` candidate | before 2b-1a | **APPROVED conditional** — tested as an independent change |

## 10. Recommendation
P-1…P-9, D9 and the override decision are approved; **only 2b-1a** is authorised. 2b-1a touches no money and no secrets, produces the primitives every later step relies on, and is small enough to review in one sitting.
