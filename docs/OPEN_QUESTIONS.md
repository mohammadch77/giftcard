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
| B1 | Launch catalog: brands, regions, denominations, fulfillment method per variant. | seeds catalog + attribute schemas |
| B2 | Game accounts: pre-loaded stock (→ `digital_codes(ACCOUNT)`) or created per order (→ manual task)? Account-sharing/ToS risk acceptance? | |
| B3 | Reservation TTL (default 15 min) and cart expiry. | |
| B4 | Discount stacking policy (DATABASE_DESIGN §13 proposal). | |
| B5 | Wallet rules: top-up min/max; confirm **no cash-out** (cash-out has major legal/AML implications). | |
| B6 | Ticket reopen window, SLA, attachment limits. | |
| B7 | Show delivered secrets on-site only (recommended) or also by SMS/email? | |
| B8 | Per-order / new-account spend caps and velocity thresholds. | SECURITY §11 |
| B10 | Four-eyes approval thresholds for ledger adjustments / refunds. | |
| B11 | Admin roles and permission matrix. | |
| B12 | **Refund rules (current policy is TEMPORARY; legal review required before it is final)** per product type and disclosure state (not delivered / delivered-unrevealed / revealed), time windows, who may override. **Requires business decision + legal review.** Current design only records the facts and uses safe placeholders. | DATABASE_DESIGN §10.2 |
| B14 | **Mandatory MFA (TOTP) for administrator accounts before launch?** Recommendation: yes (see TOTP_DESIGN.md). Decide before step 2b-3. | decides whether TOTP is built in 2b-3 |
| B13 | Is a refund to the original gateway required, or is wallet-credit refund acceptable? | depends on gateway capability (unknown) |

## External dependencies (blocked until the owner provides them)
| ID | Needed | Unblocks |
|---|---|---|
| X1 | Payment gateway choice + merchant approval + official documentation + sandbox credentials | real `PaymentGateway` adapter, `PAYMENT_INTEGRATION.md` |
| X2 | SMS provider choice + docs/credentials | real `SmsProvider`, production OTP |
| X3 | Supplier(s) + authoritative API documentation | real `SupplierAdapter`, `SUPPLIER_INTEGRATION.md` |

## Technical (low-risk, decided at scaffold time)
| ID | Question |
|---|---|
| T2 | Production PostgreSQL version (native `uuidv7()` needs 18; otherwise app-generated). |
| T3 | PostgreSQL RLS for customer-owned data as defence in depth? |
| T4 | Hash-chained audit log? |
| T5 | Error monitoring: Sentry SaaS / self-hosted / none (reachability from Iran). |
| T6 | Object storage: local disk behind interface vs self-hosted MinIO. |
| T7 | Custom OTP module vs Auth.js credentials flow (leaning custom). |
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
| B11 | Default admin role/permission matrix — will be proposed in the 2b-3 step plan | 2b-3 |
