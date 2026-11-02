# OPEN_QUESTIONS.md

Status v0.2. Decisions already made live in `DECISIONS.md` and are **not** repeated as questions. Only unresolved items remain here, with my recommendation.

## Previously open, now RESOLVED (see DECISIONS.md)
D1 money unit (Rial) · D2 ORM (Drizzle) · D3 login (mobile OTP; email attachable) · D4 gateway (not selected, adapter only) · D5 fulfillment scope · D6 split payment (none) · D7 Docker/Redis (none) · **D9 (late-payment policy): APPROVED — see DECISIONS.md.**

## Blocking before Phase 2 can start
| ID | Question | Recommendation |
|---|---|---|
| D8 | **Hosting/VPS provider and KEK custody method — remains OPEN (confirmed 2026-11-01); the architecture must keep secure key management and recovery possible (`KeyProvider` port, versioned KEK, rotation, tested recovery).** Who holds the KEK backup shares? Managed or self-managed PostgreSQL with PITR? | Domestic VPS, self-managed PG with WAL archiving; KEK as root-only file + offline split backup with named custodians; run a recovery drill before launch. Scaffold (2a) can start without this, but **no real secrets/inventory** may be loaded before it is settled. |
| D10 | **Accountant review (pre-launch gate; decision 2026-11-01: stays PROPOSED, revenue-recognition mode is NOT an admin-panel setting)** of Chart of Accounts (DATABASE_DESIGN §9.2): revenue recognition (on payment vs on delivery), VAT, COGS method, treatment of gateway fees/settlement. | Needed before launch; development proceeds on Mode B as an explicitly provisional assumption. |

## Business / product
| ID | Question | Note |
|---|---|---|
| B1 | Launch catalog: brands, regions, denominations, fulfillment method per variant. **Also approve the fulfilment-compatibility proposal C-2.** Catalog schema/services exist (2b-4); no real data is loaded. | seeds catalog |
| B2 | (C-2 allows GAME_ACCOUNT → AUTO_CODE/MANUAL only.) Game accounts: pre-loaded stock (→ `digital_codes(ACCOUNT)`) or created per order (→ manual task)? Account-sharing/ToS risk acceptance? | |
| B3 | **Checkout reservation hold (seconds) and cart expiry — NO default exists since 2b-8: checkout is refused until `ORDER_RESERVATION_TTL_SECONDS` (60–3600) is set.** Inventory's 900 s is only that module's technical default. Cart expiry is needed when the cart exists (Phase 4). | before launch |
| B4 | Discount stacking policy (DATABASE_DESIGN §13 proposal). | |
| B5 | Wallet rules: top-up min/max (**no default exists; top-ups are refused until `WALLET_TOPUP_MIN_RIAL/MAX_RIAL` are set — 2b-6**); confirm **no cash-out** (none exists; major legal/AML implications). | before launch |
| B6 | Ticket reopen window, SLA, attachment limits. | |
| B7 | Show delivered secrets on-site only (recommended) or also by SMS/email? (2b-7: reveal is on-site only, logged; admin reveal permission exists but is granted to nobody.) | |
| B8 | Per-order / new-account spend caps and velocity thresholds. | SECURITY §11 |
| B10 | Four-eyes approval thresholds for ledger adjustments / refunds. (2b-6: ALL wallet adjustments currently need two admins — thresholds would only relax this.) | |
| B11 | Admin roles and permission matrix. **2b-3 part DONE** (owner / security_admin / support_agent, identity.* only — DECISIONS I-4). Open: roles/permissions of later modules (catalog, inventory, fulfilment, finance, …), each added in its own step. | |
| B12 | **Refund rules (current policy is TEMPORARY; legal review required before it is final)** per product type and disclosure state (not delivered / delivered-unrevealed / revealed), time windows, who may override. **Requires business decision + legal review.** Current design only records the facts and uses safe placeholders. | DATABASE_DESIGN §10.2 |
| SEC-KAT | **Tests IMPLEMENTED in 2b-3** (`tests/unit/crypto-kat.test.ts`). **Still a production gate:** it must be re-run against any real KeyProvider, which does not exist (D8). Original text: independent known-answer tests for AES-256-GCM, HMAC-SHA-256, AAD, key versions/rotation and auth-tag failures must be added and passed **before any production KeyProvider is connected** (blocks final production approval of the crypto, not the ledger). | before production crypto |
| B13 | Is a refund to the original gateway required, or is wallet-credit refund acceptable? | depends on gateway capability (unknown) |

## External dependencies (blocked until the owner provides them)
| ID | Needed | Unblocks |
|---|---|---|
| X1 | Payment gateway choice + merchant approval + official documentation + sandbox credentials | real `PaymentGateway` adapter, `PAYMENT_INTEGRATION.md` |
| X2 | SMS provider choice + docs/credentials | real `SmsProvider`, production OTP |
| X3 | Supplier(s) + authoritative API documentation. **2b-7 delivered only the GENERIC port + test double; nothing is verified against a real supplier.** Needed per supplier: auth, idempotency guarantee (`idempotentSubmit`), status-query semantics (is NOT_FOUND conclusive?), whether the listing is complete, whether codes are returned, currency/units of prices, rate limits, timeouts | real `SupplierAdapter`, `SUPPLIER_INTEGRATION.md` |

## Technical (low-risk, decided at scaffold time)
| ID | Question |
|---|---|
| T2 | Production PostgreSQL version (native `uuidv7()` needs 18; otherwise app-generated). |
| T3 | PostgreSQL RLS for customer-owned data as defence in depth? |
| T4 | Hash-chained audit log? |
| T5 | Error monitoring: Sentry SaaS / self-hosted / none (reachability from Iran). |
| T6 | Object storage: local disk behind interface vs self-hosted MinIO. |
| T7 | ~~Custom OTP module vs Auth.js~~ **RESOLVED in 2b-3: custom Identity module.** |
| T8 | ~~Verify at scaffold~~ **DONE in Phase 2a** (see TECH_STACK): custom migrations, `skip locked`, CHECK, drift check verified. |

## Legal / compliance (owner + local counsel; no conclusions in these docs)
See `SECURITY.md §12`: sanctions and publisher ToS for foreign gaming products, business licensing / e-Namad, gateway onboarding rules and allowed categories, tax/VAT, consumer-protection and refund terms for digital goods, data protection, SMS regulations, account-sharing risks.

## Design
| ID | Question |
|---|---|
| G1 | Provide the actual source for references #1–#3 and the three pending ones (#4–#6) — see `DESIGN_REFERENCES.md` for exactly what I have and lack. |
| G2 | Licence status of Soda/GetLayers and of each 21st.dev/Aceternity component. |
| G3 | Does #6 (Sidebar + Dashboard) serve admin, customer dashboard, or both? |
| G4 | Brand name/logo/tone of voice (Persian copy). |

## Phase 2b planning items (P-1…P-9 and the dependency-override decision are APPROVED — see DECISIONS.md)
| ID | Item | Needed by |
|---|---|---|
| CI | Branch protection/required check, SHA-pinned actions, audit step (CI run #1 passed) | 2b-1a |
| B11 | Admin role/permission matrix — 2b-3 part implemented (see above); later modules add theirs | 2b-4+ |
| CAT-1 | `catalog_manager` role proposal (B11 continuation); product images/uploads (T6), SEO fields and per-type attribute schemas deferred (flat bounded `attrs` only) | Phase 3/4 |
| INV-1 | Returned/refunded code handling (SOLD→VOID only exists as a transition, no API), supplier cost/COGS on batches (D10), code-expiry dates, bulk void by batch, reconciliation job schedule | 2b-7/2b-9, D10 |
| PAY-1 | **D10 sub-decision blocking order payments (2b-8 built the port and the fail-closed boundary; implementing the policy = one class once decided):** wallet/gateway order payment credit account — `CUSTOMER_PREPAYMENTS` (Mode B) vs `SALES_REVENUE` (Mode A); manual resolution of NEEDS_REVIEW payments (B12/B13); real gateway docs (X1); gateway key/refund capability | 2b-8/2b-9 |
| SUP-1 | Supplier cost → COGS/pricing policy (D10), supplier prepaid/payable accounting, task cancellation on refund (2b-9), scheduler for `sweepStuckSubmissions` / reconciliation / `sweepExpired` / `listVerificationDue` workers, SSRF-safe outbound host allow-list when the first real adapter exists | 2b-8/2b-9, D10, X3 |
| ORD-1 | Review/refund handling of `PAYMENT_NEEDS_REVIEW` and other holds (B12/B13); fraud/promotion hooks in checkout; schedulers for `expireStale`, `sweepExpired`, `verifyPayment` retries, supplier workers, `syncFulfillment` (outbox consumer for `fulfillment.delivered`); customer-visible hold wording | 2b-9, Phase 3/4 |
| RET-1 | Retention policy for sessions, OTP challenges, rate-limit counters, recovery records, audit (no purge exists) | before launch |
| HTTP-1 | HTTP routes, real cookie integration (`__Host-`, HttpOnly, Secure, SameSite=Lax), CSRF/Origin enforcement, client-IP derivation for `clientKey` | Phase 4 |
| X2 | Production SMS provider (OTP cannot be delivered in production until chosen; `SmsProvider` port + fail-closed `NullSmsProvider` exist) | launch |
