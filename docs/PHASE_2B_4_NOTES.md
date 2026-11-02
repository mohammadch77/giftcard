# PHASE_2B_4_NOTES.md — Catalog & minimal pricing (implemented)

## 1. Scope delivered
`catalog` (private tables, one public `index.ts`) and `pricing` (quote only). Migrations `0012_catalog_tables`, `0013_catalog_guards` (forward-only; `0000–0011` untouched and hash-pinned). No new dependency. Excluded as instructed: inventory, payments, wallet, suppliers, fulfilment, orders, refunds, HTTP/UI, promotions.

## 2. Data model
`categories` (parent link, ≤ 4 levels, no cycles by trigger) · `brands` · `regions` · `products` (type immutable, slug immutable) · `product_variants` (sellable unit; sku unique per product; region; descriptive face value/currency; duration; `fulfillment_method`; `price`, `sale_price` + window; flat bounded `attrs`; `status`; `availability`) · `variant_price_history` (trigger-written) · `product_status_history`, `variant_status_history` · `product_type_fulfillment` (compatibility data).
Money: `rial_price` domain (integer Rial, multiple of 10, ≤ 10^13). CHECKs: sale price > 0 and < price; sale window ordered and requires a sale price; `attrs` is an object ≤ 8 KB. Triggers: category tree, publish rules (variant needs published product and price > 0; product needs active brand/category and cannot leave PUBLISHED while a variant is PUBLISHED), fulfilment compatibility and freeze after DRAFT, immutability, price history (SECURITY DEFINER, requires `app.actor_id`, append-only). Grants: no DELETE anywhere; UPDATE only on named columns; the application role cannot write price history.
Indexes: unique slugs/skus; `products_listing_idx` and `product_variants_published_idx` (partial, published only); parent and category lookups; history `(variant_id, id desc)`.

## 3. Services
Admin (`AdminContext{db, clock, actor, authorize}`; every call: authorize → one transaction → audit): create category/brand/region/product/variant, update product/variant, archive brand/category, `setProductStatus`, `setVariantStatus`, `setVariantAvailability`, **`changePrice`** (the only path that changes money; sensitive permission, mandatory reason), `getProductAdmin`. Reads for other modules: `listPublished` (keyset pagination, explicit DTO, only sellable), `getVariantSnapshot` (what orders will snapshot; works in any state), `getPriceableVariants` (used by pricing; optional `FOR SHARE`).
`pricing.quote(tx, lines, now)`: **no price input exists**; prices come from catalog rows locked `FOR SHARE` in the caller's transaction; effective unit price = sale price inside `[start, end)` else regular price; `mulRial`/`sumRial` only; result `{pricingVersion:'min-0', currency:'IRR', lines, subtotal}`. Quote bounds are technical (≤ 50 lines, qty 1–100, no duplicates).

## 4. Boundaries and integration
Catalog depends on audit only; it does **not** import identity: the composition root binds `authorize` to `identity.authorize(actor, permission)` and registers `CATALOG_PERMISSIONS` on identity's `PermissionCatalog` (integration test `catalog-identity.test.ts`). Migration 0013 seeds the four catalog permissions into the `owner` role (role data, like 0011); no other role changes. Writers that touch several variants must lock rows in id order (quote readers do) to avoid deadlocks.

## 5. Tests (real PostgreSQL, least-privilege role)
Unit: price validation boundaries, effective-price window boundaries, compatibility, lifecycle, input strictness, permission registration. DB: permission matrix (nothing written when denied), tree/uniqueness/compatibility (service + raw SQL + code↔table parity), lifecycle and cascades, availability, price CHECKs, price history/actor/atomicity, audit, public reads/pagination/DTO leak, quotes (window, rejects, overflow), identity binding and step-up. Concurrency: price change blocks behind an in-flight quote; 60 racing quotes never see mixed generations. Architecture: table isolation, matrix, no second money implementation, migration hashes `0000–0011`.

## 6. Limits / not decided
- C-2 fulfilment compatibility is a **proposal** (needs B1/B2). No real catalog data exists.
- Face value/currency is descriptive only; no FX, cost, tax, fee or margin exists in the catalog.
- No images/uploads/SEO/attribute schemas yet (CAT-1); no `catalog_manager` role (B11).
- Sale pricing is a simple window; campaigns/discount codes remain Phase 3.
- Stock/availability from inventory is 2b-5.
