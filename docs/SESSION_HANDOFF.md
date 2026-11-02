# SESSION_HANDOFF.md — Gaming Store: transition to a new Claude Code session

Written at HEAD `d389a65` (verified; the handoff commit itself is recorded in section C only after it exists). **Source of truth for decisions/open items stays `DECISIONS.md`, `OPEN_QUESTIONS.md`, `IMPLEMENTATION_ROADMAP.md`; this file summarises and points, it does not override them.** No `CLAUDE.md` exists in the repository.

## A. Project overview
- **What:** a single-vendor premium digital-products store (gaming gift cards, digital codes, game accounts, subscriptions, supplier-provided products) for the **Iran market**. Persian RTL storefront later; customer dashboard and admin dashboard.
- **Users:** customers (mobile-OTP login), staff (owner / security_admin / support_agent + module roles; mandatory TOTP MFA, B14).
- **Fulfilment models:** AUTO_CODE (encrypted pre-loaded codes), MANUAL (admin completes), SUPPLIER_API (generic multi-supplier adapter).
- **Stack:** Next.js 16 / React 19 / TypeScript 6 (strict), PostgreSQL via Drizzle ORM + reviewed forward-only SQL migrations, zod 4, pg 8, Vitest 5. **No Docker, no Redis** (D7): PostgreSQL does queues (outbox), rate limiting, idempotency, locks. Zero new dependencies are allowed without approval.
- **Principles:** modular monolith with an import matrix (`architecture/module-deps.cjs`, dependency-cruiser); modules expose only `index.ts`; module schemas private; cross-module FKs created in SQL (P-1); platform imports no module; integer Rial everywhere (D1); append-only double-entry ledger; state machines enforced by DB triggers with history + actor; no external network calls inside DB transactions; fail closed on every unapproved business/security setting; idempotency; secrets envelope-encrypted via `KeyProvider`; test doubles live in `testing/` dirs and can never be enabled in production; no deletion/purge (P-7).
- **Layout:** `src/platform/*` (clock, config, crypto, db, errors, idempotency, ids, logging, money, outbox, payment-gateway, ratelimit, sms, supplier-adapter, transitions, composition); `src/modules/*` — **implemented:** audit, catalog, pricing (minimal quote), identity, inventory, ledger, payments, wallet, suppliers, fulfillment, orders; **empty stubs (index only):** cart, fraud, notifications, promotions, support; `src/worker/index.ts` (outbox runner, empty handler registry); `src/app` (layout, placeholder page, `/api/health` only); `db/migrations/0000–0023`; `tests/{unit-style architecture,db,concurrency,helpers}`; `docs/`.

## B. Completed work
**Previous phases (all CI-confirmed):** 2a foundation · 2b-1a platform primitives · 2b-1b crypto plumbing · 2b-2 audit + ledger · 2b-3 identity · 2b-4 catalog + minimal pricing · 2b-5 inventory · 2b-6 payments + wallet · 2b-7 suppliers + fulfilment · 2b-8 orders/checkout. Per-phase detail: `docs/PHASE_2B_*_NOTES.md`.

**This session's final stretch (detail):**
1. **2b-8 closed** as CI-confirmed (`2b5c4fb`, run #12).
2. **Phase 2b-9 — refunds, reconciliation, closure** (`28a2f91`, follow-up `2e3cfdd`):
   - Migrations `0022_refunds_tables` (generated) and `0023_refunds_guards` (custom): `refund_policy_versions/rules` (seed `temporary-0`, read-only to app), `refunds`, `refund_items`, `refund_status_history`, `reconciliation_runs`, `reconciliation_findings` (append-only); refund state machine; four-eyes CHECK; commit-time "full order + exact total" check (PO002); `orders_cancel_gate` (paid order → CANCELLED only with a COMPLETED refund; added engine edge `FULFILLING → CANCELLED`); `order_holds_refund_gate`; grants; owner seeded routine refund/reconciliation permissions, `orders.refunds.override_revealed` seeded to **no role**.
   - Orders module: `refunds.ts` (request/approve/reject/execute/get/list; 3-phase gateway refund; `finalize` in one transaction), `reconciliation.ts` (read-only jobs), `domain/refund-policy.ts`, `REFUND_PERMISSIONS`, test double `testing/booking-policy.ts` (placeholder balanced posting, test-only).
   - Additive cross-module APIs: gateway port refund capability (`capabilities`, `refundPayment`, `verifyRefund`) + `TestPaymentGateway` support; `ledger.findTransactionByKey`; `payments.closeReviewedPayment`; `fulfillment.cancelTasksForOrder`; `inventory.getReservationStatuses` (an unused `voidSoldCode` was removed again: delivered-item refunds are blocked by D10); `suppliers.listAgedUnresolvedOrders`; `outbox.outboxStats`; `wallet.findIncompleteSucceededTopUps`; error codes `REFUND_INVALID/NOT_FOUND/BLOCKED`.
   - Design points worth remembering: gateway "accepted" ≠ completed; send intent committed (outcome UNKNOWN) before the call so concurrent/crashed executors only verify; completion only on verified exact amount; `orders.payment_status` stays SUCCEEDED after refund (use `refunds` for reporting); supplier-unresolved reconciliation job is injected by the composition root (orders may not import suppliers); refunds are full-order only, one live refund per order.
   - Bugs found/fixed during the phase: concurrent gateway executors could each resend (fixed by committing the UNKNOWN intent under the row lock); outcome regression by racing verifiers (monotonic merge); orders reading payments tables / importing suppliers (replaced by public APIs + injection); comment text tripping D10 regex tests; type errors in reconciliation actor.
   - Tests added: `tests/db/refunds.test.ts` (23), `tests/concurrency/refunds.test.ts` (4), `tests/architecture/refunds-regression.test.ts` (7); updated migration hash pins (0020–0023) and owner-permission seed pin; orders architecture test now allows wallet import, still forbids suppliers.
   - Docs: `PHASE_2B_9_NOTES.md`, DECISIONS (RF-1…RF-6, RC-1, PY-3), STATE_MACHINES (refund machine, payment_status deviation), DATABASE_DESIGN §15b, OPEN_QUESTIONS RF-OPEN-1…3.
3. **Verification commit `2e3cfdd`:** strengthened the test proving `FULFILLING → CANCELLED` is possible only after a completed refund; documented queryability of refund state.
4. **Decision consolidation `d389a65` (documentation only):** owner-approved D10 (working direction `CUSTOMER_PREPAYMENTS`, accountant validation required), B12, B13, B3 (900 s), B5 (1,000,000 / 100,000,000 / 300,000,000 IRR), B10, B7, B1, B2, C-2, D8, RET-1, X1–X3, ORD-1, ADM-1, OPS-1…4; new `docs/ADMIN_SETTINGS_ARCHITECTURE.md`; ARCHITECTURE §12; roadmap work table.
5. **This handoff:** `docs/SESSION_HANDOFF.md` (+ pointer in the roadmap).

## C. Git and CI status
- Branch: `claude/gaming-store-architecture-m95hp0` (remote `origin` = github.com/mohammadch77/giftcard; upstream set).
- Key commits: `addc4d3` 2b-1a · `dd4f058` 2b-1b · `816f89a` 2b-2 · `8c0cd6f` 2b-3 · `e5ae5af` 2b-4 · `5cf88fb` 2b-5 · `e75ebac` 2b-6 · `1a98500` 2b-7 · `2b5c4fb` 2b-8 · `28a2f91` 2b-9 · `2e3cfdd` 2b-9 verification · `d389a65` decisions consolidation.
- **CI verified (GitHub Actions workflow `ci`):** runs #1–#12 success (through `2b5c4fb`); #13 success on `28a2f91`; #14 success on `2e3cfdd`; #15 success on `d389a65` — each confirmed against its exact head SHA. The CI run for the handoff commit is **not** asserted here; check it first (see H).
- At the time of writing: working tree clean, everything pushed, local HEAD = `origin/<branch>` = `d389a65` (before this handoff commit).
- Last local full-suite numbers (at `28a2f91`): unit/architecture 279, db 296, concurrency 61 passed; lint, typecheck, dependency matrix, schema drift, `next build`, `npm audit` (0), SQL prototypes 40/40.

## D. Implementation status (from source and tests)
| Area | Status |
|---|---|
| Identity / mobile OTP / sessions | **Implemented** (module + DB + tests); no HTTP routes or cookies yet (HTTP-1, Phase 4); real SMS absent (`NullSmsProvider`, X2) |
| RBAC, staff TOTP MFA, step-up, recovery | **Implemented** (module-level); role-management UI/ops not built |
| Catalog and pricing | **Implemented** (catalog core, price history, minimal server-side quote); promotions/discounts not started; B1/B2 structured attributes and games/platforms entities not implemented |
| Inventory and reservations | **Implemented** (encrypted itemised codes, counted stock, atomic reservations, consume/sweep per D9, movements); code expiry dates not implemented; voiding SOLD codes has no API |
| Payment gateway abstraction | **Implemented generic port** + test double (incl. refund capability); no real gateway (X1) |
| Payments (3-phase verification) | **Implemented**; NEEDS_REVIEW closable only via refund; accepting a mismatched payment not implemented |
| Wallet and ledger | **Implemented**: ledger append-only double-entry with reversals; wallet top-up, two-person adjustments. **Partial:** top-up min/max via env (fail closed); daily limit not implemented; no cash-out by design |
| Orders and checkout | **Implemented** (checkout, wallet/gateway settlement, D9 late path, cancel/expire, holds, payment gate). **Settlement fails closed** (D10 posting policy not implemented; B3 TTL must be configured) |
| Refunds and reconciliation | **Implemented, financially fail-closed** (2b-9). Delivered/revealed execution, conversions, partial refunds, missing settlement posting, gateways lacking capability are BLOCKED. Reconciliation is manual-run; no scheduler |
| Supplier integration | **Implemented generic** (adapter port, credentials write-only, sync, routing, ambiguity handling); nothing verified against a real supplier (X3) |
| Fulfilment and secure delivery | **Implemented** (tasks, manual flow, supplier fulfilment, deliveries, logged on-site reveal, DB payment gate) |
| Outbox / background processing | **Implemented outbox** (at-least-once, leases, dead-letter) + worker runner with an **empty handler registry**; schedulers/handlers for sweepers, verification retries, refund retries, reconciliation: **not implemented** (ORD-1) |
| Admin settings (ADM-1) | **Documented but not implemented** (`docs/ADMIN_SETTINGS_ARCHITECTURE.md`) |
| Cart, promotions, support, fraud, notifications | **Not started** (empty module stubs) |
| API and frontend | **Not started** beyond `/api/health` and a placeholder page; UI deliberately deferred |

## E. Approved decisions (do not change; see DECISIONS.md for text and status)
D1 Rial integers · D2 Drizzle · D3 mobile OTP · D4 payment adapter · D5 fulfilment scope · D6 no split payment · D7 no Docker/Redis · D8 key management (**requirements approved; provider pending; production blocker**) · D9 late payment (LATE→ON_HOLD→SUSPENSE, manual, no TTL extension) · **D10 working direction approved (`CUSTOMER_PREPAYMENTS`, liabilities, COGS separate, refunds reverse); accountant validation required; production blocker**. P-1…P-9, G-1 (V1 release scope), H-1 (outbox at-least-once), H-2 (window naming), B14 (mandatory admin MFA), I-series (identity), C-2, B1, B2, B3 (900 s), B5 (limits above), B7, B10, B12, B13, RET-1, X1–X3, ORD-1, ADM-1, OPS-1…OPS-4, SEC-KAT gate, RF-1…RF-6, RC-1, SP-/FL-/OR-/PY- implementation records. **Approval of a direction is not implementation and not production readiness**; statuses used: APPROVED, IMPLEMENTATION_PENDING, EXTERNAL_VALIDATION_REQUIRED, PRODUCTION_BLOCKER, COMPLETED.

## F. Outstanding work and blockers
**Approved Phase 1 implementation list (none completed — verify against code before assuming):**
1. D10 posting policy (`OrderPaymentPostingPolicy` class: prepayment → revenue on delivery, supplier COGS, refund reversals) — blocked on accountant validation.
2. B5 wallet limits as admin-managed settings incl. the daily limit (min/max currently env).
3. B10 two-person approvals with configurable thresholds (today: always two people).
4. B12/B13 refund policy final version and real-gateway execution (generic protocol only; defect / duplicate-payment review workflows).
5. Order-time policy snapshots (today only the refund records the version at request time).
6. B1/B2 catalog extensions and game-account attribute schema.
7. C-2 compatibility tightening + protected method-change operation (`product_type_fulfillment` is a permissive superset).
8. Inventory code expiry dates (OPS-2).
9. ADM-1 admin settings (typed, module-owned, audited, versioned) — also B3 TTL setting.
Also: workers/schedulers + daily reconciliation (ORD-1/OPS-3); notifications (B7 — never secrets); holds FRAUD_REVIEW / FULFILLMENT_FAILED / SUPPLIER_UNKNOWN have no resolution path; accepting mismatched payments; supplier-unresolved wiring in the composition root; HTTP routes, cookies, CSRF (Phase 4); cart/promotions/support/fraud (Phase 3/4).
**External / validation:** accountant (D10, VAT, fees, settlement, COGS method); legal (B12 final refund terms, RET-1 periods, consumer-protection, sanctions/publisher ToS, account-sharing risk); **payment provider** choice + merchant approval + official docs + sandbox (X1); **SMS provider** primary + fallback docs (X2); **supplier(s)** + authoritative API docs incl. idempotency guarantees (X3); **production KMS / Secret Manager** KeyProvider + SEC-KAT re-run + backup/recovery (D8); hosting/Postgres version (T2); design references G1–G4.
**Production blockers:** D10 validation + policy; B12 legal; RET-1; D8; X1; X2; X3; schedulers; HTTP/UI; hardening/restore drill (Phase 6).

## G. UI/UX — deferred; preserve for later (do not implement now)
References: **21st.dev** components, **GetLayers / Soda** e-commerce template (licence status unknown), Hero Section (Redrob Labs), Bento Grid, Spotlight Card, Display Cards, Sidebar + Dashboard — see `DESIGN_REFERENCES.md` (only text descriptions were ever received; no source files; Spotlight/Display/Sidebar not yet provided).
Stack for UI: **shadcn/ui**, **Tailwind CSS**, TypeScript, **Lucide** icons, components in `/components/ui`, `cn` helper at `@/lib/utils` (clsx + tailwind-merge).
Identity: background `#0B0D14` · card `#171B29` · primary `#8B5CF6` · secondary `#22D3EE` · text `#F8FAFC` · muted `#94A3B8`. Fonts: **Vazirmatn** (Persian), **Inter** (English), self-hosted (TECH_STACK).
Requirements: premium gaming / dark-luxury look with restrained glow, gradients, glassmorphism; **RTL and LTR**; responsive desktop/tablet/mobile; customer dashboard; admin dashboard; role-aware sidebar; one unified admin settings interface (ADM-1). Visual integration is Phase 5, after all six references are received.

## H. Instructions for the next session
1. Read `README.md` (no `CLAUDE.md` exists), then `docs/SESSION_HANDOFF.md`, `docs/DECISIONS.md`, `docs/OPEN_QUESTIONS.md`, `docs/IMPLEMENTATION_ROADMAP.md`, `docs/ARCHITECTURE.md`, `docs/ADMIN_SETTINGS_ARCHITECTURE.md` (then `PHASE_2B_PLAN.md` and the latest `PHASE_2B_*_NOTES.md` as needed).
2. Verify Git state (`git status`, `git log`, branch vs `origin`) and the latest GitHub Actions run for the actual HEAD SHA; do not trust this file's SHAs blindly.
3. Do a **READ-ONLY** assessment of the Phase 1 list (section F) against the code.
4. Present an implementation plan and **wait for explicit approval**. Do not recreate completed phases; do not assume documented decisions are implemented; do not start UI; do not add dependencies; do not choose open accounting/legal policies.
Working conventions: every phase = close previous (check CI for its commit) → read plan/decisions → implement → one CI-equivalent run (`lint`, `typecheck`, `arch`, `db:drift`, `test:unit`, `test:db`, `test:concurrency`, `build`, `npm audit`, `test:sql-prototypes`) → docs → commit/push → verify CI → report → stop. Commit trailers: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01KuAKMxHWpyGMSok39xbxXT`.
