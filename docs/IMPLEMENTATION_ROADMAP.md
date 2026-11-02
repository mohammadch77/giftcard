# IMPLEMENTATION_ROADMAP.md

Status: DRAFT v0.2 (reflects decisions D1–D7). Each phase ends with a review gate; no phase starts without your approval.

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 Discovery** | repo audit | ✅ done (repo empty) |
| **1 Architecture & DB design** | DATABASE_DESIGN, ARCHITECTURE, SECURITY, STATE_MACHINES, prototypes, DECISIONS | 🟡 v0.2 drafted after decisions D1–D7; **awaiting your approval**; remaining blockers: D8 (hosting/KEK), D9, D10 |
| **2a Foundation** ✅ implemented, **approved**; CI run #1 passed on `a2719c7` | scaffold Next.js/TS, lint + boundary rules, config validation, **Drizzle + SQL-migration workflow (verify custom migrations, `skip locked`, drift check)**, test harness against real Postgres; the prototype SQL suite is ported into it | CI green; empty app boots; migrations apply to clean DB |
| **2b Core backend** *(2b-1a, 2b-1b, 2b-2, 2b-3, 2b-4 and 2b-5 IMPLEMENTED — see PHASE_2B_*_NOTES.md; later steps need separate approval; merges the former 2b–2f; see PHASE_2B_PLAN.md — **plan awaiting approval, nothing implemented**)* | 2b-1a platform primitives → 2b-1b crypto plumbing → 2b-2 audit + ledger → 2b-3 identity → 2b-4 catalog + minimal pricing → 2b-5 inventory → 2b-6 payments + wallet → 2b-7 suppliers + fulfillment → 2b-8 orders/checkout/late-payment path → 2b-9 refunds + reconciliation | each step is its own review gate; per-step acceptance in PHASE_2B_PLAN §5 |
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

## Cross-cutting rules
- Every critical module ships with its tests in the same phase.
- No real gateway/supplier integration is written before real documentation exists; fakes are labelled and cannot be enabled in production config.
- Migrations are forward-only and reviewed; ledger/inventory triggers are covered by direct SQL tests.
- Test reporting: application tests and SQL-prototype regression are always reported separately; prototype success is never evidence of commercial readiness.
- Estimated relative effort (rough, not a commitment): Phase 2 is the largest (~45 %), Phase 4 ~20 %, Phase 5/6 ~15 % each.

## Immediate next steps
1. **2b-1a authorised and in progress** (reported separately); no further 2b step starts without separate approval.
2. 2b-3 Identity (run #7) and 2b-4 Catalog + minimal pricing (run #8) CI-confirmed; 2b-5 Inventory implemented (PHASE_2B_5_NOTES.md); 2b-6 and later need separate approval.
3. Decisions still open: D8, D10, B12/B13, RET-1, B11 (later modules); X1–X3 (X2 needed for production OTP).
