# ADMIN_SETTINGS_ARCHITECTURE.md

Status: **APPROVED architecture (ADM-1, 2026-11-11) · FOUNDATION IMPLEMENTED in P1-A (2026-11-02) for B3 (reservation TTL) and B5 (wallet top-up limits).** No route or UI exists (Phase 4); every other setting in the table below is still IMPLEMENTATION_PENDING. It constrains how later phases add configuration.

## 1. Ownership by module
Each module owns its typed settings and their tables (private schema, P-1; other modules read them only through the owner's `index.ts`). **No single unrestricted key/value settings table.** Examples (initial approved values in DECISIONS, fourteenth review):

| Owner | Settings (examples) |
|---|---|
| orders | reservation TTL (B3: initial 900 s, bounds 60–3600 s) |
| wallet | top-up min / max / daily limit (B5, integer IRR) |
| ledger / orders | financial approval thresholds (B10) — floor: two distinct administrators, never switchable off |
| payments, suppliers, SMS/notifications | provider activation, priority, health, capabilities; fallback SMS; templates and channels (B7: never secrets) |
| identity | role/permission management (protected) |
| retention (per data owner) | non-financial operational periods (RET-1) |
| worker / outbox | job schedules and monitoring (ORD-1) |

## 2. Unified admin interface (future UI capability)
One Admin Settings area aggregates the owners' settings screens. It calls each module's application API only; it adds no storage and no rules of its own. Not part of Phase 2b (no routes, UI or sidebar).

## 3. Validation and authorization
Typed schema (zod) per setting with technical min/max bounds enforced **server-side**; safe defaults or fail-closed when unset (as B3/B5 do today); integer Rial only (D1). Every setting has a permission (granular RBAC); sensitive ones require step-up (B14 MFA) and, where specified, two-person approval.

## 4. Audit and approval
Every change writes an audit record (actor, old → new, reason) in the same transaction. Sensitive financial settings (limits, thresholds, policy versions) need two distinct authorised administrators; the requester never approves their own change.

## 5. Secret handling
Provider credentials, API keys and key material are **write-only**: envelope-encrypted through the `KeyProvider` (D8), never returned, logged, audited or shown in the UI; rotation keeps history. Production fails closed if the key provider is unavailable.

## 6. Historical configuration behaviour
A change affects only the future. It must not extend or mutate existing reservations (D9), rewrite existing orders, or silently change the policy a refund/order was created under: settings that shape history are **versioned** (policy versions, snapshots on the order/refund), as `refund_policy_versions` already does.

## 7. Non-configurable invariants (never settings)
Append-only ledger and audit; double-entry balance; reversals as exact mirrors; D9 late-payment rules (no TTL extension, expired reservation never used); payment verification server-to-server with exact amount; delivery requires a PAID order (DB gate); paid orders cancelled only via a completed refund; secrets never over SMS/email; two-person rule for sensitive financial changes; OTP security controls; step-up and MFA for admins; integer Rial; no deletion/purge without an approved retention policy; critical financial/security jobs cannot be permanently disabled; production never uses test doubles or dev key providers; revenue-recognition mode is not an admin toggle (D10 — a validated, versioned policy change).

## 8. As built in P1-A (what actually exists)
| Aspect | Implementation |
|---|---|
| Storage | One **append-only version table per owning module**, one typed column per setting: `order_settings_versions` (orders), `wallet_limit_versions` (wallet). No generic key/value table (an architecture test scans all migrations). Active value = highest `version` (orders) / highest `approved_seq` among APPROVED rows (wallet). |
| Validation | zod schemas in the owning module (`platform/settings` supplies `parseSetting` / `requireReason`); the same bounds are DB CHECKs (TTL 60–3600 s; limits: integer Rial, multiples of 10, `min <= max <= daily`, ceilings 10^12 / 10^13). Fail closed when nothing valid can be read. |
| Initial values | Written as DATA by migration 0025 as version 1: TTL 900 s; limits 1,000,000 / 100,000,000 / 300,000,000 IRR (owner-approved 2026-11-11). |
| Authorization | `orders.settings.read` / `orders.settings.manage` (sensitive, step-up); `wallet.settings.read` / `.request` (sensitive) / `.approve` (sensitive). Seeded to `owner` only. |
| Two-person (financial) | Wallet limits: REQUESTED by one administrator, APPROVED/REJECTED by another (application check + DB CHECK `decided_by <> requested_by`). A REQUESTED row has no effect. A request made against an older active version is STALE (application + trigger). Approved/rejected rows never change. The TTL is not a financial setting: one administrator with the sensitive permission. |
| Audit | `recordAudit` in the **same transaction** as the version row: actor, action, entity, `before` and `after` values, reason. A failing audit rolls the change back (tested). |
| Historical behaviour | A new version affects only future checkouts / top-ups. Orders keep `expires_at` and a policy snapshot; reservations keep their expiry; each top-up records the `limits_version` it was validated against and an idempotent replay is never re-validated. |
| Concurrency | Version numbering is serialised by a transaction-scoped advisory lock; unique indexes are the backstop. Daily top-up totals are computed under a per-user advisory lock. |
| Daily window | Asia/Tehran calendar day (DW-1), a fixed business rule and not a setting. |
| Not built | Admin UI/routes (Phase 4); other settings (B10 thresholds, retention, notifications, providers, workers); role management UI. |
