# IMPLEMENTATION_ROADMAP.md

Status: DRAFT. Each phase ends with a review gate; no phase starts without your approval.

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 Discovery** | repo audit | ✅ done (repo empty) |
| **1 Architecture & DB design** | DATABASE_DESIGN, ARCHITECTURE, SECURITY, STATE_MACHINES, prototypes | 🟡 drafted; **you review**; open decisions in OPEN_QUESTIONS answered (at least D1–D8) |
| **2a Foundation** | scaffold Next.js/TS, lint + boundary rules, config validation, DB tooling, migration runner, test harness against real Postgres | CI green; empty app boots; migrations apply to clean DB |
| **2b Core data layer** | SQL migrations for identity, catalog, inventory, ledger, orders, payments, platform tables; triggers; transition rules | SQL-level tests (C7, C8) pass; schema drift check |
| **2c Ledger + wallet** | ledger service, wallet top-up/debit (using fake gateway), reconciliation job | ledger tests + S2 stress pass |
| **2d Inventory + auto-code fulfillment** | encrypted code import, reservation, expiry sweeper, delivery gate | C1, C6, S1 (real path) pass |
| **2e Orders + payments** | checkout transaction, payment adapter interface, idempotent callback handling | C2, C3 pass; one **real** gateway only after docs/credentials |
| **2f Manual + supplier fulfillment** | manual task queue; supplier adapter framework (fake adapter) | C4, C5; real supplier only after docs |
| **3 Business features** | discounts/campaigns, tickets, notifications, reports, audit UI data | rule-conflict tests |
| **4 Admin + storefront** | functional UI on neutral styling | usable end-to-end flow |
| **5 Visual integration** | six design references → design system → final homepage/dashboard | **only after all six received** |
| **6 Hardening** | full test matrix, security checklist, backups/restore drill, load tests, production config | checklist signed off |

## Cross-cutting rules
- Every critical module ships with its tests in the same phase.
- No real gateway/supplier integration is written before real documentation exists; fakes are labelled and cannot be enabled in production config.
- Migrations are forward-only and reviewed; ledger/inventory triggers are covered by direct SQL tests.
- Estimated relative effort (rough, not a commitment): Phase 2 is the largest (~45 %), Phase 4 ~20 %, Phase 5/6 ~15 % each.

## Immediate next steps (after your review)
1. Answer blocking decisions (OPEN_QUESTIONS D1–D8).
2. Approve or amend DATABASE_DESIGN (esp. §9 chart of accounts and §5.3 late-payment policy).
3. Choose Prisma vs Drizzle.
4. Then start Phase 2a (scaffold only).
