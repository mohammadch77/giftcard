# PROJECT_OVERVIEW.md

**Working name:** (TBD) — Digital Gaming & Subscription Store, Iran market.
**Model:** single-vendor, v1. No marketplace features (no vendor accounts, dashboards, commissions, order splitting).
**Primary experience:** Persian / RTL, prices in Toman, Iranian payment gateways.

## Sells
Gaming gift cards · game accounts · gaming subscriptions · streaming & digital-service subscriptions · future digital product types (added via configuration, not redesign).

## v1 capabilities (all in scope; built in phases)
Catalog & variants · three fulfillment methods (auto code / manual / supplier API) · supplier management · cart/checkout/orders · payments via adapter · wallet with double-entry ledger · discount codes & campaigns · support tickets · customer accounts · RBAC admin dashboard · audit logs.

## Guiding priorities (in order)
1. Correctness of money and inventory (database-enforced invariants).
2. Security of codes, credentials and accounts.
3. Maintainable modular architecture.
4. Premium UX/visual design (deferred to Phase 5 pending six design references).

## V1 release scope
Cart, discount codes/campaigns, support tickets, baseline anti-fraud and essential notifications **remain in V1 release scope** even though they are implemented after the core backend (G-1, see IMPLEMENTATION_ROADMAP).

## Decisions
See `DECISIONS.md` (Rial storage / Toman display, Drizzle, mobile OTP, adapters without a chosen gateway/SMS/supplier, no split payment, no Docker/Redis).

## Current status (2026-11-01)
| Item | State |
|---|---|
| Repository | Phase 0 audit: was empty. Now: Phase 2a scaffold (Next.js 16, TS 6, Drizzle) — see PHASE_2A_NOTES.md |
| Phase 0 (discovery) | done — see below |
| Phase 1 (architecture + DB design) | v0.2 — decisions D1–D7 applied; prototypes re-run (see `db-prototypes/LAST_RUN.txt`); **awaiting approval** |
| Application code | Phase 2a scaffold only (structure, config, DB tooling, tests); **no business logic** |
| Design references | 3 named+described, 3 pending; **no source code available to me for any of them** (details in DESIGN_REFERENCES) |
| Payment gateway / SMS provider | not selected |
| Suppliers | none selected; no API docs |

## Phase 0 repository audit
- `git log`: no commits on `claude/gaming-store-architecture-m95hp0`; no remote branches. Working tree empty.
- No `package.json`, lockfile, config, routes, components, styles, DB config or auth. Therefore: no framework, no TypeScript/Tailwind/shadcn setup, no design tokens, no existing code quality issues or conflicts.
- Tooling on the dev machine: Node v22.23, npm 10.9, PostgreSQL 16.15 client/server available (used to validate DB prototypes). Docker not used or required.
- Technical risk register for a greenfield start is in `ARCHITECTURE.md §10` and `SECURITY.md`.

## Document map
| Doc | Status |
|---|---|
| DATABASE_DESIGN, ARCHITECTURE, SECURITY | drafted (depth priority) |
| STATE_MACHINES | drafted |
| TECH_STACK, DESIGN_REFERENCES, IMPLEMENTATION_ROADMAP, OPEN_QUESTIONS | drafted |
| PRODUCT_REQUIREMENTS, PAYMENT_INTEGRATION, SUPPLIER_INTEGRATION, FULFILLMENT_DESIGN, DESIGN_SYSTEM, TESTING_STRATEGY | **intentionally not written yet** (depend on decisions/docs not yet provided; avoiding superficial text) |
| DECISIONS | new — owner decisions log |
| `db-prototypes/` | executable SQL prototypes (001 ledger, 002 inventory, 003 orders/payments/reservations) + test script + `LAST_RUN.txt` |
