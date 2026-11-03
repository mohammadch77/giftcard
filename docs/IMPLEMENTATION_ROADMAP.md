# IMPLEMENTATION_ROADMAP.md

Status: DRAFT v0.2 (reflects decisions D1–D7). Each phase ends with a review gate; no phase starts without your approval.

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 Discovery** | repo audit | ✅ done (repo empty) |
| **1 Architecture & DB design** | DATABASE_DESIGN, ARCHITECTURE, SECURITY, STATE_MACHINES, prototypes, DECISIONS | 🟡 v0.2 drafted after decisions D1–D7; **awaiting your approval**; remaining blockers: D8 (hosting/KEK), D9, D10 |
| **2a Foundation** ✅ implemented, **approved**; CI run #1 passed on `a2719c7` | scaffold Next.js/TS, lint + boundary rules, config validation, **Drizzle + SQL-migration workflow (verify custom migrations, `skip locked`, drift check)**, test harness against real Postgres; the prototype SQL suite is ported into it | CI green; empty app boots; migrations apply to clean DB |
| **2b Core backend** *(2b-1a, 2b-1b, 2b-2, 2b-3, 2b-4, 2b-5, 2b-6, 2b-7, 2b-8 and 2b-9 IMPLEMENTED (2b-8 CI-confirmed, run #12) — see PHASE_2B_*_NOTES.md; later steps need separate approval; merges the former 2b–2f; see PHASE_2B_PLAN.md — **plan awaiting approval, nothing implemented**)* | 2b-1a platform primitives → 2b-1b crypto plumbing → 2b-2 audit + ledger → 2b-3 identity → 2b-4 catalog + minimal pricing → 2b-5 inventory → 2b-6 payments + wallet → 2b-7 suppliers + fulfillment → 2b-8 orders/checkout/late-payment path → 2b-9 refunds + reconciliation | each step is its own review gate; per-step acceptance in PHASE_2B_PLAN §5 |
| **3 Business features** | discounts/campaigns, tickets, notifications, reports, audit UI data | rule-conflict tests |
| **4 Admin + storefront** | functional UI on neutral styling | usable end-to-end flow |
| **5 Visual integration** | six design references → design system → final homepage/dashboard | **only after all six received** |
| **6 Hardening** | full test matrix, security checklist, backups/restore drill, load tests, production config | checklist signed off |

## V1 release scope vs implementation order (G-1, APPROVED)
The tables above give **implementation order only**. A feature scheduled later is **not** removed from the first release. Everything below is in **V1 release scope**:

| V1 release feature | Implemented in | Note |
|---|---|---|
| Catalog, variants, pricing | 2b-4 | |
| Inventory (codes, manual stock), reservations | 2b-5 | |
| Payments (adapter) and wallet with double-entry ledger | 2b-2, 2b-6 | real gateway needs X1 |
| Fulfillment: auto code, manual, supplier-API architecture | 2b-7 | real supplier needs X3 |
| Orders, checkout, late-payment handling, refunds | 2b-8, 2b-9 | |
| Customer accounts (mobile OTP), sessions, RBAC | 2b-3 | real SMS needs X2 |
| **Shopping cart** | Phase 4 (storefront); checkout API already accepts explicit lines | **in V1** |
| **Discount codes and promotional campaigns** | Phase 3 (pricing hook) | **in V1** |
| **Support-ticket system** | Phase 3 | **in V1** |
| **Baseline anti-fraud controls** (purchase limits, velocity, manual-review flags) | Phase 3 | **in V1** |
| **Essential notifications** (order, payment, support) | Phase 3 (outbox-driven; SMS provider X2) | **in V1** |
| Admin dashboard, customer dashboard, storefront | Phase 4–5 | |
| Hardening, backups, restore drill | Phase 6 | launch gate |

Launch is blocked until every row above is implemented, tested and reviewed — not merely the 2b rows.

## Remaining implementation work from the 2026-11-11 consolidation (assignment only; each step still needs its own authorisation)
| Work | Phase | Status |
|---|---|---|
| Admin Settings (module-owned typed settings + unified UI): **B3 TTL and B5 limits incl. daily — IMPLEMENTED in P1-A**; still pending: B10 thresholds, retention (non-financial), notification channels/templates, provider activation/priority, worker monitoring, protected role management | Phase 3 (module settings + audit/approval) → Phase 4 (unified UI) | FOUNDATION + B3 + B5 DONE (P1-A); rest IMPLEMENTATION_PENDING |
| D10 `OrderPaymentPostingPolicy` (`CUSTOMER_PREPAYMENTS`, revenue-on-delivery, supplier COGS, refund reversals) | Phase 3, after accountant validation | EXTERNAL_VALIDATION_REQUIRED |
| Notifications (B7: ready-notices only, no secrets), SMS primary + fallback (X2) | Phase 3 | IMPLEMENTATION_PENDING |
| Workers/schedulers (ORD-1, OPS-3 daily reconciliation, refund retries) and worker health view | Phase 3 (jobs) → Phase 4 (view) | IMPLEMENTATION_PENDING |
| Catalog extensions (B1 games/platforms, B2 attribute schema, C-2 tightening + protected method change), OPS-2 code expiry — **IMPLEMENTED in P1-B**; open: C-2b mapping of DIGITAL_SERVICE/OTHER, B2 legal/ToS, OPS-2 follow-ups, scheduling of the expiry sweeper | Phase 3 | DONE (P1-B) — owner/legal inputs outstanding |
| B12 order-time policy snapshot — **IMPLEMENTED in P1-A**; defect/duplicate-payment review flows (P1-C) and the final policy after legal review still pending | Phase 3 | EXTERNAL_VALIDATION_REQUIRED |
| Real gateway, SMS, supplier adapters; production KMS KeyProvider; RET-1 periods | when X1/X2/X3/D8/legal inputs exist | PRODUCTION_BLOCKER |

## Cross-cutting rules
- Every critical module ships with its tests in the same phase.
- No real gateway/supplier integration is written before real documentation exists; fakes are labelled and cannot be enabled in production config.
- Migrations are forward-only and reviewed; ledger/inventory triggers are covered by direct SQL tests.
- Test reporting: application tests and SQL-prototype regression are always reported separately; prototype success is never evidence of commercial readiness.
- Estimated relative effort (rough, not a commitment): Phase 2 is the largest (~45 %), Phase 4 ~20 %, Phase 5/6 ~15 % each.

## Immediate next steps
0. **New session? Start with `docs/SESSION_HANDOFF.md`** (state, blockers, first instructions).
1. **2b-1a authorised and in progress** (reported separately); no further 2b step starts without separate approval.
2. 2b-3 Identity (run #7) and 2b-4 Catalog + minimal pricing (run #8) CI-confirmed; 2b-5 Inventory CI-confirmed (run #9); 2b-6 Payments + Wallet CI-confirmed (run #10); 2b-7 Suppliers + Fulfillment CI-confirmed (run #11; generic adapter only, X3); 2b-8 Orders & Checkout implemented (PHASE_2B_8_NOTES.md; **settlement fails closed until D10, checkout until B3**); 2b-9 and later need separate approval.
3. Decisions: direction APPROVED on 2026-11-11 for D10, B12, B13, B3, B5, B10, B7, B1, B2, C-2, D8, RET-1, X1–X3, ORD-1 (DECISIONS fourteenth review); still blocking production: accountant validation (D10), legal review (B12, RET-1), real gateway/SMS/supplier (X1–X3), production KMS (D8); B11 later modules.

## Phase 1 sub-phases (assessment of 2026-11-02)
| Sub-phase | Scope | Status |
|---|---|---|
| **P1-A** | ADM-1 settings foundation · B3 TTL (900 s) · B5 limits + Asia/Tehran daily limit · order-time policy snapshots (refund policy version, TTL, fulfilment rules) + backfill | **IMPLEMENTED** — migrations 0024/0025; details in DECISIONS (fifteenth review) |
| **P1-B** | C-2 matrix + protected method change (usage probes, change log, DB-enforced) · B1/B2 games, platforms, regions, typed game-account attributes · OPS-2 optional code expiry + sweeper | **IMPLEMENTED (migrations 0026/0027)** — awaiting review; see DECISIONS sixteenth review |
| P1-C | B10 thresholds · B12/B13 review workflows | not started — needs separate approval |
| P1-D | D10 `OrderPaymentPostingPolicy` | not started — blocked on accountant validation |
