# OPEN_QUESTIONS.md

**Blocking for Phase 2 start (D1–D8)** · others can be answered later. Each lists my recommendation.

## Blocking
| ID | Question | Recommendation |
|---|---|---|
| D1 | **Money base unit:** store Toman or Rial? (Gateways commonly operate in Rial; UI shows Toman.) | Store **Toman (IRT)** as integer if you never need sub-toman amounts; convert ×10 only inside gateway adapters. Confirm with chosen gateway. |
| D2 | **Payment gateway(s)** for launch, and do you already have merchant approval/credentials/docs? | Pick one; share docs. Adapter stays gateway-agnostic until then. |
| D3 | **Login method:** phone+OTP, email+password, or both? SMS provider? | Phone+OTP primary (local norm) with optional password; needs an SMS provider and cost caps. |
| D4 | **Suppliers:** which, and do you have API docs? Prepaid balance or pay-on-delivery with them? | Launch with auto-code from own stock + manual fulfillment; add supplier API once docs exist. Affects accounts `SUPPLIER_PREPAID/PAYABLE`. |
| D5 | **Late payment policy** (gateway success after reservation expiry, no stock left): auto-credit to wallet vs auto-refund to card vs hold for review? | Re-try reserve; else credit wallet automatically + notify; manual review above a threshold. |
| D6 | **Refund policy** for digital goods, esp. revealed/delivered codes and accounts. | No refund after reveal except admin override with permission; undelivered always refundable. |
| D7 | **Split payment** (wallet + gateway) in v1? | No — all-wallet or all-gateway in v1 (simpler, safer). |
| D8 | **Hosting & ops:** where is it deployed (domestic VPS?), who holds KEK backups, managed Postgres? | Domestic VPS, self-managed PG with PITR, KEK split custody. |

## Product / business
| ID | Question | Note |
|---|---|---|
| B1 | Which gift-card brands, regions and denominations at launch? | seeds catalog + attribute schemas |
| B2 | Are game accounts pre-loaded stock or created per order? | pre-loaded → `digital_codes(ACCOUNT)`; per-order → manual task |
| B3 | Reservation TTL (default 15 min) and cart expiry? | |
| B4 | Discount stacking policy (proposal in DB design §13) acceptable? | |
| B5 | Wallet rules: top-up min/max, wallet balance withdrawable? (assume **no** cash-out) | cash-out would have major legal implications |
| B6 | Ticket reopen window, SLA targets, attachment size/type limits? | |
| B7 | Should delivery show the code on-site only, or also SMS/email it? | recommend on-site only + "ready" notification |
| B8 | Per-order and new-account spend caps, velocity thresholds? | fraud defaults in SECURITY §11 |
| B9 | Accounting: revenue recognised at payment or delivery; VAT handling; chart of accounts review by accountant? | DB design §9.2 assumes delivery |
| B10 | Need 4-eyes approval for ledger adjustments / refunds above X? | |
| B11 | Admin roles list (support, content, finance, super-admin …)? | |

## Technical
| ID | Question | Note |
|---|---|---|
| T1 | Prisma vs Drizzle (TECH_STACK) | |
| T2 | PostgreSQL version available in production (uuidv7 native needs 18) | |
| T3 | Postgres RLS as extra layer for customer data? | |
| T4 | Hash-chained audit log needed? | |
| T5 | Error monitoring: Sentry SaaS/self-hosted/none? | reachability from Iran |
| T6 | Object storage: local disk vs MinIO | |
| T7 | Domain/brand name and language scope (Persian only at launch, English later?) | |

## Legal / compliance (owner + local counsel; no conclusions here)
See `SECURITY.md §12`: sanctions & publisher ToS for selling foreign gaming products to Iran, business licensing / e-Namad, gateway onboarding requirements and permitted categories, tax/VAT, consumer-protection terms, data protection, SMS regulations, account-sharing risks.

## Design
| ID | Question |
|---|---|
| G1 | Please provide source code for design references #1–#3 and the three pending ones (#4 Spotlight Card, #5 Display Cards, #6 Sidebar+Dashboard). |
| G2 | Licence status of Soda/GetLayers (free vs paid)? |
| G3 | Does #6 serve admin, customer dashboard, or both? |
| G4 | Brand identity: logo, name, tone of voice (Persian copy)? |
