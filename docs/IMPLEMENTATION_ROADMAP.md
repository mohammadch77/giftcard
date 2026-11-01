# IMPLEMENTATION_ROADMAP.md

Status: DRAFT v0.2 (reflects decisions D1–D7). Each phase ends with a review gate; no phase starts without your approval.

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 Discovery** | repo audit | ✅ done (repo empty) |
| **1 Architecture & DB design** | DATABASE_DESIGN, ARCHITECTURE, SECURITY, STATE_MACHINES, prototypes, DECISIONS | 🟡 v0.2 drafted after decisions D1–D7; **awaiting your approval**; remaining blockers: D8 (hosting/KEK), D9, D10 |
| **2a Foundation** | scaffold Next.js/TS, lint + boundary rules, config validation, **Drizzle + SQL-migration workflow (verify custom migrations, `skip locked`, drift check)**, test harness against real Postgres; the prototype SQL suite is ported into it | CI green; empty app boots; migrations apply to clean DB |
| **2b Core data layer** | SQL migrations for identity, catalog, inventory, ledger, orders, payments, platform tables; triggers; transition rules | SQL-level tests (C7, C8) pass; schema drift check |
| **2c Ledger + wallet** | ledger service, `platform/money` (Rial↔Toman), wallet top-up/debit (using `TestGateway`), reconciliation job | ledger tests + S2 stress pass |
| **2d Inventory + auto-code fulfillment** | encrypted code import, reservation, expiry sweeper, delivery gate | C1, C6, S1 (real path) pass |
| **2e Orders + payments** | checkout (wallet **or** gateway, no split), payment adapter interface, idempotent callbacks, **late-payment hold path** | C2, C3, C6, C10 pass; a **real** gateway only after X1 (docs/credentials) |
| **2f Manual + supplier fulfillment** | manual task queue; supplier adapter framework + mapping + UNKNOWN/reconciliation (`TestSupplier`) | C4, C5; real supplier only after X3 |
| **3 Business features** | discounts/campaigns, tickets, notifications, reports, audit UI data | rule-conflict tests |
| **4 Admin + storefront** | functional UI on neutral styling | usable end-to-end flow |
| **5 Visual integration** | six design references → design system → final homepage/dashboard | **only after all six received** |
| **6 Hardening** | full test matrix, security checklist, backups/restore drill, load tests, production config | checklist signed off |

## Cross-cutting rules
- Every critical module ships with its tests in the same phase.
- No real gateway/supplier integration is written before real documentation exists; fakes are labelled and cannot be enabled in production config.
- Migrations are forward-only and reviewed; ledger/inventory triggers are covered by direct SQL tests.
- Estimated relative effort (rough, not a commitment): Phase 2 is the largest (~45 %), Phase 4 ~20 %, Phase 5/6 ~15 % each.

## Also in scope for 2b/2d: OTP identity tables and `SmsProvider` port (no provider), refund snapshot tables.

## Immediate next steps (after your review)
1. Approve or amend DATABASE_DESIGN v0.2 (esp. §5.5 late payment, §9.2 chart of accounts, §10.2 refunds).
2. Settle D8 (hosting/KEK), D9, D10 — or explicitly allow 2a to start without them.
3. Provide design-reference source code (does not block backend phases).
4. Then Phase 2a (scaffold only).
