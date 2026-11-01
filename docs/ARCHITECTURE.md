# ARCHITECTURE.md

Status: **DRAFT v0.2 — Phase 1, updated with decisions D1–D7 (`DECISIONS.md`).** Repository state at time of writing: **empty (no commits, no files)**, so this is a greenfield proposal, not an adaptation of existing code.

## 1. Style: modular monolith — verdict
Suitable. One deployable Next.js app + one worker process from the **same codebase and database**. No microservices, no message broker. Justification: single team, single vendor, strong transactional needs (order+payment+ledger+inventory in one DB transaction) which a distributed design would make harder, not easier.

## 2. Process model (no Docker required)

```
            ┌──────────────────────────┐        ┌──────────────────────┐
 Browser ──▶│ web  (Next.js, Node)     │        │ worker (Node script) │
            │  UI + server actions +   │        │  outbox consumer     │
            │  route handlers          │        │  reservation sweeper │
            └───────────┬──────────────┘        │  supplier sync/retry │
                        │                       │  reconciliation jobs │
                        ▼                       └──────────┬───────────┘
                  PostgreSQL  ◀──────────────────────────────┘
                  (source of truth, outbox, locks, rate-limit counters if needed)
```
- **No Docker, no Redis (decision D7).** Run via `systemd`/PM2 behind a reverse proxy. Next.js `output: 'standalone'`. **Final VPS/provider selection and KEK custody method are NOT decided — they require review and approval** (see `OPEN_QUESTIONS.md` D8); nothing in the design depends on a specific provider.
- **Hosting caveat:** Iran-market stores typically need domestic hosting (latency, gateway callbacks, regulatory/e-Namad expectations). This rules out assuming Vercel, hosted Sentry, or S3/R2 by default. Defaults chosen below are self-hostable.
- Background jobs: **Postgres outbox + polling worker (`FOR UPDATE SKIP LOCKED`)**. No Redis/BullMQ in v1. Revisit only if measured throughput requires it.
- Rate limiting: Postgres- or in-process-backed limiter (single instance) behind an interface. Redis is out of scope for v1; revisit only with measured need.
- Object storage: local disk behind a storage interface for v1 (ticket attachments, product images); S3-compatible (e.g. self-hosted MinIO) when needed. Files are served through authenticated routes or signed URLs, never from a public bucket for attachments.
- Error monitoring: structured logs + a pluggable reporter; Sentry (self-hosted or SaaS) is an option, not a given **[OPEN]**.

## 3. Proposed repository layout (not created yet)

```
src/
  app/                       # Next.js routes ONLY: thin, no business logic
    (store)/…  (customer)/…  (auth)/…  admin/…  api/…
  modules/
    identity/    catalog/    inventory/   pricing/     cart/
    orders/      payments/   ledger/      wallet/      fulfillment/
    suppliers/   promotions/ support/     notifications/ audit/ fraud/
      ├─ index.ts            # PUBLIC API: the only importable surface
      ├─ domain/             # entities, value objects, state machines, pure rules
      ├─ application/        # use cases (services), take a Tx + deps
      ├─ infra/              # repositories (SQL), adapters
      └─ schemas.ts          # Zod
  platform/                  # db (Drizzle pool, tx helper), money, crypto, idempotency, outbox, logger, config, authz
                             #   money/: Rial<->Toman conversion + formatting — the ONLY place the two units meet
  worker/                    # worker entrypoint + job registry
  ui/                        # presentational components, design system (no domain logic)
db/
  schema/                    # Drizzle table definitions (typed access)
  migrations/                # reviewed SQL: drizzle-generated + custom (CHECKs, triggers, functions, grants)
  seed/
tests/ (unit, integration, concurrency, e2e)
docs/
```

### Boundary rules (enforced in CI by `dependency-cruiser` or `eslint-plugin-boundaries`)
1. A module may import another module **only through its `index.ts`**.
2. `app/` and `ui/` never import `infra/` or SQL; they call use cases.
3. `ui/` components receive data via props; no DB, no fetch of domain data inside presentational components.
4. Cross-module *writes* happen either (a) via the other module's use case inside the **same transaction** passed in, or (b) asynchronously via outbox events. No module touches another module's tables.
5. Dependency direction (allowed →): `orders → {cart, pricing, inventory, payments, fulfillment, promotions}`; `payments → {ledger, orders-events}`; `fulfillment → {inventory, suppliers, orders-events}`; `wallet → ledger`. `ledger`, `audit`, `platform` depend on nothing in the domain. Cycles are lint errors.

## 4. Transaction & unit-of-work pattern
- `withTransaction(async tx => …)` in `platform/db` (isolation `READ COMMITTED` default; `SERIALIZABLE` not required because correctness relies on row locks, unique constraints and conditional updates, which are simpler to reason about and test).
- Use cases take `tx`; they never open their own transaction when called from another use case.
- Critical operations and their single transaction scope:
  - **Checkout:** price & discount recompute → create order+items → reserve stock → redeem code reservation → create payment (INITIATED) → outbox.
  - **Payment success:** conditional payment transition → reservation ACTIVE→CONSUMED (if LATE: ledger→suspense, order ON_HOLD, stop) → ledger posting → order→PAID → create fulfillment tasks → outbox.
  - **Delivery (auto code):** re-check payment → code RESERVED→SOLD → delivery row → fulfillment COMPLETED → ledger revenue/COGS → outbox notification.
  - **Wallet debit/credit:** ledger transaction with idempotency key.
- External calls (gateway, supplier, SMS) are **never made inside a DB transaction**. Pattern: persist intent (status `SUBMITTING`/outbox) → commit → call → record result in a new transaction.

## 5. Idempotency
- Inbound HTTP mutations that create money-affecting state accept an `Idempotency-Key`; stored in `idempotency_keys` with request hash.
- Gateway callbacks: dedupe via `payment_events(gateway,event_key)` and the conditional state transition.
- Outbound supplier calls: idempotency key generated and persisted *before* the first attempt; reused on retries (when the supplier supports it; otherwise `UNKNOWN` handling applies).
- Ledger: business-derived `idempotency_key` UNIQUE.

## 5a. Money units (decision D1)
Domain code, SQL, ledger, payments and adapters use **integer Rial** only. Toman appears in exactly two places: UI formatting (`rial / 10`) and admin/customer input that is converted to Rial at the boundary (`tomanToRial`). Prices are multiples of 10 Rial so display is exact. Lint rule: no `/ 10` or `* 10` money arithmetic outside `platform/money`; branded type `Rial` (distinct from plain `number`/`bigint`) prevents accidental unit mixing. API/DB JSON money fields are named `amountRial` explicitly.

## 5b. Payment method rule (decision D6)
Checkout selects exactly one of `WALLET` or `GATEWAY`. No split payments in v1. Wallet payment = one ledger transaction inside the order-paid transaction; gateway payment = payment adapter flow. Wallet top-up is a separate payment purpose.

## 6. Adapters (ports & adapters)

```ts
interface PaymentGateway {            // concrete gateway chosen later
  createPayment(i: CreatePaymentInput): Promise<CreatePaymentResult>;
  verifyPayment(i: VerifyInput): Promise<VerifyResult>;     // server-to-server
  refund?(i: RefundInput): Promise<RefundResult>;           // optional capability
  readonly capabilities: { refund: boolean; webhook: boolean; … };
}
interface SupplierAdapter {           // shape finalised only after real docs
  readonly key: string;
  readonly capabilities: SupplierCapabilities;              // explicit, never assumed
  syncCatalog?(): …; getAvailability?(): …;
  submitOrder(i: SubmitInput): Promise<SubmitResult>;       // result: CONFIRMED|REJECTED|UNKNOWN
  queryOrder?(ref: string): Promise<QueryResult>;
}
```
```ts
interface SmsProvider {               // provider NOT selected (decision D3)
  send(i: { to: string; template: string; params: Record<string,string> }): Promise<SendResult>;
}
```
All three interfaces are **hypotheses**; they are revisited when real documentation/provider choice arrives. **No gateway, supplier or SMS API is implemented or assumed** (decisions D3–D5). Only clearly labelled test doubles (`TestGateway`, `TestSupplier`, `TestSms`) exist for automated tests; the composition root refuses to start in production if one is configured. Supplier scope in v1 includes the *architecture* (adapter framework, mapping tables, retry/UNKNOWN handling, reconciliation, manual fallback); any real supplier integration waits for its authoritative documentation.

## 7. AuthN / AuthZ
- **Mobile OTP is the primary registration/login method (decision D3).** Module `identity` exposes `requestOtp / verifyOtp`; identities are modelled as `user_identities` (PHONE now, EMAIL attachable later without redesign). Server-side sessions. Auth.js vs a small custom session/OTP module is decided at scaffold time: Auth.js's custom-credentials flow for OTP is possible but the OTP, rate-limit and session tables are our own either way; the leaning is a small custom module to avoid fighting the library, **to be confirmed**.
- Authorization via a single `authorize(actor, permission, resource?)` function in `platform/authz`; called in every use case entry, not in UI. Customer-facing repositories require `userId`.
- Admin area in a separate route group + separate layout + stricter middleware (2FA required, shorter session, optional IP allowlist).

## 8. Frontend
- Next.js App Router; server components by default; client components only for interaction.
- RTL-first (`dir="rtl"`, logical CSS properties `ms-/me-/ps-/pe-`), Jalali dates and Persian digits handled in a formatting layer (`ui/format`). Money formatting: integer → Persian-digit grouped string + «تومان».
- Design system: tokens in CSS variables mapped into Tailwind; shadcn/ui primitives. **Final visual design deferred to Phase 5** until all six references arrive (`DESIGN_REFERENCES.md`).

## 9. Observability
Structured JSON logs with correlation id (request/order/payment ids), secret redaction at the logger level, metrics for: reservation conflicts, expired reservations, payment verify failures, supplier UNKNOWN count, ledger drift, outbox lag. Alerts on ledger drift ≠ 0 and outbox lag.

## 10. Evaluation vs. "actual project"
The repository is empty, so there is nothing to conflict with. ORM = Drizzle (decided); the rest of the stack remains a recommendation to confirm (see `TECH_STACK.md`). Risks of the chosen approach:
| Risk | Mitigation |
|---|---|
| ORM can't express every constraint/trigger | Drizzle for typed access + reviewed SQL migrations for CHECK/trigger/function/grants + schema-drift CI check (decision D2) |
| Triggers hide logic from app devs | every trigger documented in DATABASE_DESIGN + tested directly with SQL tests |
| Single Postgres is a SPOF | managed backups + PITR, documented restore drill |
| Polling outbox latency | poll interval 1–2 s + `LISTEN/NOTIFY` wake-up optional |

## 11. Out of scope for v1 (explicit)
Marketplace/vendors, microservices, Kubernetes, Docker requirement, event streaming, search engine (use Postgres FTS/`pg_trgm`), multi-currency FX, mobile app.
