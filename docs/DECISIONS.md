# DECISIONS.md

Authoritative log of decisions made by the project owner. Other docs must agree with this file; if they do not, this file wins and the other doc is a bug.

## Final decisions (received after the Phase 0/1 report)
| ID | Decision | Applied in |
|---|---|---|
| D1 | **Money:** all amounts stored as integer **Rial**; UI shows **Toman**; conversion only in dedicated layers (`platform/money`, UI formatting, input boundary). | DATABASE_DESIGN §1, §4, §9; ARCHITECTURE §5a |
| D2 | **ORM: Drizzle.** CHECK, triggers, `SKIP LOCKED` and SQL migrations are preserved. | TECH_STACK; DATABASE_DESIGN §18 |
| D3 | **Auth:** mobile OTP primary for register/login. Email attachable later (architecture reserves it). SMS provider **not selected**. | DATABASE_DESIGN §3; SECURITY §3; ARCHITECTURE §7 |
| D4 | **Payments:** gateway **not selected**. Payment Adapter designed; no hypothetical gateway/API implemented. | DATABASE_DESIGN §11; ARCHITECTURE §6 |
| D5 | **Fulfillment scope v1:** store's manual stock, automatic code delivery, manual delivery of accounts/subscriptions, and Supplier API *architecture* — all in v1. Real supplier connection waits for authoritative documentation. | DATABASE_DESIGN §5, §10, §12; ARCHITECTURE §6 |
| D6 | **No split payment** in v1: wallet **or** gateway. | DATABASE_DESIGN §7; ARCHITECTURE §5b |
| D7 | **No Docker, no Redis** for now. PostgreSQL + outbox. Final VPS and KEK custody **need review and approval**. | ARCHITECTURE §2; SECURITY §2.1 |

## Directives requiring careful design (policy principles fixed, details still open)
| # | Directive | Where designed | Still open |
|---|---|---|---|
| 8 | Late payment / reservation expiry: never deliver without re-reservation; order enters review and settlement. | DATABASE_DESIGN §5.5, STATE_MACHINES | **resolved by D9 (APPROVED)** |
| 9 | Refund policy records delivery and reveal of confidential data; final rules need business + legal decision. | DATABASE_DESIGN §10.1–10.2 | the actual refund rules |
| 10 | Chart of Accounts proposed; revenue-recognition timing **not final** without an accountant. | DATABASE_DESIGN §9.2–9.3 | accountant sign-off (recognition mode, VAT, COGS) |

## Process directives
11–14: fix test script typing issue, re-run all prototypes/tests and report separately; reconcile design-reference status; align docs; **no scaffold/implementation yet.** Results: `db-prototypes/LAST_RUN.txt`, `DESIGN_REFERENCES.md`.

## Decisions of 2026-11-01 (second review) and Phase 2a authorisation
| ID | Decision | Applied in |
|---|---|---|
| E1 | *Superseded by D9 (APPROVED, see below).* | — |
| E2 | *Superseded by D9 (APPROVED, see below):* the 300 s value is a late-payment **handling** window, not a reservation extension. | — |
| E3 | VPS choice and final KEK custody method stay **open**; the architecture must still allow secure key management and recovery. | OPEN_QUESTIONS D8; SECURITY §2.1 |
| E4 | Chart of Accounts and revenue-recognition timing stay **proposed** until an accountant approves before launch. Revenue-recognition mode must **not** become a freely editable admin-panel setting. | DATABASE_DESIGN §9.2 |
| E5 | Current refund policy is **temporary**; final policy needs legal review. | DATABASE_DESIGN §10.2; OPEN_QUESTIONS B12 |
| E6 | **Phase 2a authorised** (scaffold, Drizzle, migrations + runner, DB test harness, dependency-cruiser, module structure, env validation, lint/typecheck/tests). No business features, no real providers, no secrets, no prototype migrations promoted without review, no UI design. | PHASE_2A_NOTES.md |

## Decisions of 2026-11-01 (third review) — Phase 2b preparation
| ID | Decision | Applied in |
|---|---|---|
| F-1 | *Superseded:* D9 is APPROVED (fourth review). | — |
| F-2 | Prototype SQL tests are kept **separate** from application tests and must never be reported as readiness of the commercial system. | PHASE_2B_PLAN §8 |
| F-3 | No financial or encrypted data may be removed without an explicit approved policy (no delete/purge/crypto-shred paths in Phase 2b). | PHASE_2B_PLAN P-7 |
| F-4 | Phase 2b is **planned only**; no code or migration until the plan is approved. | PHASE_2B_PLAN |

## Decisions of 2026-11-01 (fourth review) — Phase 2b-1a authorisation
| ID | Status | Decision | Applied in |
|---|---|---|---|
| **D9** | **APPROVED** | **Final late-payment policy.** (1) A payment verified after the reservation has expired is classified `LATE`. (2) The order becomes `ON_HOLD`. (3) The received amount is posted to `SUSPENSE_UNRESOLVED_RECEIPTS`. (4) Review and settlement are **manual** in v1. (5) The **300-second window is a handling-policy parameter only**; it **does not extend the reservation TTL**. (6) An expired reservation is **never** used for delivery under any circumstance; delivery after a late payment is possible only through a *new* reservation chosen by a human. Config key: `LATE_PAYMENT_HANDLING_WINDOW_SECONDS` (default 300; renamed from `PAYMENT_VERIFY_GRACE_SECONDS`, which wrongly suggested a TTL extension). The `inventory.extendForVerification` idea is **withdrawn**. | DATABASE_DESIGN §5.5; STATE_MACHINES; PHASE_2B_PLAN |
| P-1 … P-8 | **APPROVED** | As proposed in PHASE_2B_PLAN §7: P-1 cross-module FK policy; P-2 merged Phase 2b with 10 steps; P-3 trigger-based transition validation + history; P-4 ops-script roles + migration grants; P-5 test doubles isolated under `**/testing/`; P-6 `Clock` port and `p_now` in time-dependent SQL; P-7 no delete/purge/crypto-shred; P-8 no new runtime dependencies. | PHASE_2B_PLAN §7 |
| P-9 | **APPROVED (refined)** | `Rial` = **branded `number`**, guarded by `Number.isSafeInteger`; all financial arithmetic on integers only (no floats). Amount limits are enforced in **both** the domain layer (`platform/money`) and PostgreSQL (domains `rial_amount`, `rial_price`, `rial_balance` with CHECKs). Technical ceilings: single amount ≤ `MAX_RIAL_AMOUNT = 10^13` Rial; aggregates/balances ≤ `Number.MAX_SAFE_INTEGER`. Prices are multiples of 10 Rial. (The 10^13 ceiling is a technical default; changing it needs a migration.) | PHASE_2B_1A_NOTES |
| G-1 | **APPROVED** | **Release scope vs implementation order.** Moving Cart, Promotions, Support, Fraud and Notifications to later *implementation* steps does **not** remove them from V1 *release scope*. V1 must still ship: shopping cart; discount codes and promotional campaigns; support-ticket system; baseline anti-fraud controls; essential order/payment/support notifications. | IMPLEMENTATION_ROADMAP |
| DEP-1 | **APPROVED (conditional)** | Test and apply npm `overrides` as an **independent change**; if it causes any incompatibility, revert and report. `npm audit fix --force` is forbidden. | DEPENDENCY_AUDIT |
| 2b-1a | **AUTHORISED** | Scope: money/Rial primitives, ids, Clock, state-transition engine + history/triggers, idempotency, outbox, database roles and grants. **Excluded:** any business module, real payment, wallet, ledger, identity, operational cryptography, provider connection. No further 2b step starts without separate approval. | PHASE_2B_PLAN §5 |

## Decisions of 2026-11-02 (fifth review) — 2b-1a approved; 2b-1b authorisation
| ID | Status | Decision | Applied in |
|---|---|---|---|
| 2b-1a | **APPROVED** | Commit `addc4d3` and its green CI (run #4) accepted. | PHASE_2B_1A_NOTES |
| H-1 | **APPROVED (requirement)** | **Outbox is AT-LEAST-ONCE, not a general exactly-once guarantee.** Consumers must be idempotent; re-running an event must not duplicate side effects; the "worker stops after the side effect and before recording success" scenario must be tested; the term *exactly-once* may be used only for specific, proven results inside one database transaction. | PHASE_2B_1B_NOTES; outbox module docs |
| H-2 | **APPROVED** | Env name `LATE_PAYMENT_HANDLING_WINDOW_SECONDS` confirmed. Its precise operational use is finalised in step **2b-8**. Until then it must not extend any reservation TTL or cause automatic delivery of expired stock. | D9 |
| 2b-1b | **AUTHORISED** | Scope: `KeyProvider` interface, envelope encryption (AES-GCM), HMAC fingerprints / duplicate detection, separate KEK and HMAC pepper, development KeyProvider for tests, protection of sensitive data in logs, tests for encryption, key rotation, key failure and recovery. **Security constraints:** no real/production key or credential is created or committed; the development provider is explicitly rejected in production; the KEK is never stored in the database or source; the design allows an external KEK and replacing the provider; behaviour when the KEK is lost / replaced / unavailable is documented and tested; nothing is deleted or crypto-shredded; key rotation never loses the ability to decrypt old data. | CRYPTO_DESIGN, PHASE_2B_1B_NOTES |
| 2b-1b-X | **Excluded** | Ledger, wallet, identity, real OTP, payment, supplier, real providers, any later step. | — |
| TOTP | **Design only (not implemented)** | The owner asked for the need to be established first; if no concrete need, document only. Result: see TOTP_DESIGN.md — implementation deferred to step 2b-3 and conditional on the owner's decision B14 (mandatory MFA for admin accounts). | TOTP_DESIGN |
