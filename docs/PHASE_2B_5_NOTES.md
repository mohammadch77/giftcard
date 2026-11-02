# PHASE_2B_5_NOTES.md — Inventory (implemented)

## 1. Scope delivered
`inventory` module (private tables, one public `index.ts`; depends on catalog + audit only — matrix unchanged). Migrations `0014_inventory_tables`, `0015_inventory_guards` (forward-only; `0000–0013` untouched and hash-pinned). No new dependency. Not built: suppliers, payments, orders, delivery execution, HTTP/UI, deletion/purge/shredding.

## 2. Model
- **Itemised stock** (AUTO_CODE variants): `digital_codes` — sealed envelope (`sealed`, AAD = `digital_codes`/row id/`code|account_credential`), keyed fingerprint `code_fp` + `hmac_version` (unique), `payload_kind CODE|ACCOUNT`, status AVAILABLE/RESERVED/SOLD/VOID/QUARANTINED, `reservation_id`, `reserved_until`, `order_item_ref` (unique, per unit), CHECK `status_links`.
- **Counted stock** (MANUAL variants): `stock_counters(available, reserved ≥ 0)`.
- **Reservations:** `inventory_reservations` (unique `reservation_key`, request hash, ACTIVE/CONSUMED/RELEASED/EXPIRED, immutable `expires_at`) + `inventory_reservation_lines` (kind, quantity, `sold_at`).
- **Evidence:** `inventory_movements` (append-only; qty_delta is the change of AVAILABLE), `inventory_batches`, `code_access_log` (append-only).
- Indexes: partial `(variant_id, id) WHERE AVAILABLE` (reserve = index scan), partial reservation→codes, partial `expires_at WHERE ACTIVE` (sweeper), movement and line lookups.
- Grants: no DELETE anywhere; UPDATE only on named columns; the application role cannot touch `sealed`, `code_fp`, `expires_at`.

## 3. Contracts (public)
`reserve(tx, clock, {reservationKey, orderRef, lines, ttlSeconds?})` · `release` · `consume` → `CONSUMED | LATE` · `markSold(tx, clock, {reservationId, assignments[{variantId, orderItemRef}]})` · `sweepExpired(db, clock)` (worker) · `availability` · `verifyInventory` (consistency report) · `withDeliverySecret` (fulfilment only) · admin: `importCodes`, `setCodeStatus`, `adjustStock`, `getStock` (take an `InventoryAdminContext` whose `authorize` is bound to identity at the composition root).
Orders (2b-8) call `reserve` inside the checkout transaction, `consume` in the payment-success transaction, route `LATE` to the manual hold path (D9), then `markSold` and hand the sold code ids to fulfilment.

## 4. Guarantees and how they are enforced
| Invariant | Mechanism |
|---|---|
| One code never to two orders | `FOR UPDATE SKIP LOCKED` allocation; unique `order_item_ref`; status_links CHECK; SOLD frozen (trigger) |
| Expired reservation never delivered | consume needs `expires_at > now` (conditional UPDATE) and CHECK `consumed_at < expires_at`; code→SOLD only under a CONSUMED reservation (trigger); delivery requires SOLD + exact order item |
| Expiry not extended | `expires_at` immutable (trigger, no grant); no API touches it; D9 unchanged |
| Consume vs sweeper | both are conditional UPDATEs on the reservation row; the row lock lets exactly one win (200-race test) |
| Idempotent reserve | unique `reservation_key` + request hash; same key/same content → same reservation, different content → `IDEMPOTENCY_CONFLICT` |
| All-or-nothing | savepoint around the whole reserve; shortage rolls back only that attempt |
| No external call in a transaction | reserve/consume/sweep are pure SQL; import fingerprints/seals **before** its transaction; delivery opens the secret **after** the logging transaction commits |
| No plaintext | envelope encryption + keyed fingerprints; errors carry paths/codes only; arch test: no I/O or console in the module; canary test over all tables, audit and results |
| Consistency | `verifyInventory` (reserved-without-reservation, sold-without-consumed, line vs codes, closed-with-codes, counted reserved vs lines, movements vs available) is asserted empty after every scenario |

## 5. Tests (real PostgreSQL, least-privilege role)
DB (18): import/dedupe incl. pepper rotation, fail-closed without KeyProvider, canary, reservation (all-or-nothing, usable caller tx, idempotency, rejections, multi-line atomicity, release), counted stock, expiry boundaries (`expires_at` exactly = LATE), opportunistic sweep, sale flow, raw-SQL guard bypass attempts, delivery gate + access log + buffer zeroing, admin status changes and permissions. Concurrency (7): **S1 — 1,000 attempts vs 10 codes → exactly 10, no duplicate code**, 300×3 vs 100 (no partial reservation), counted 500 vs 10, 30 same-key requests, concurrent release, 200 consume/sweeper races, parallel sweepers vs reservers. Architecture: table isolation, matrix, plaintext-path callers, no reveal permission, no I/O.

## 6. Open / not decided
- **B1/B2/C-2** are *not* needed by inventory (see DECISIONS table); they remain yours. **B3** value needed before launch.
- **D8 + SEC-KAT:** with `KEY_PROVIDER=none` (production) imports fail closed; no real codes may be loaded before D8.
- Not implemented: returns to stock, supplier cost/COGS (D10), expiry dates of codes, reconciliation scheduling (INV-1).
- The read-only DB role can SELECT sealed envelopes (no KEK in the DB); restrict by column if policy requires.
- Multi-row writers on `product_variants`/stock must lock in id order (reserve sorts lines by variant id).
