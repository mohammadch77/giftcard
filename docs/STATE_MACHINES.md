# STATE_MACHINES.md

Status: **DRAFT v0.1.** Terminal states are marked ■. Each machine is seeded into `state_transition_rules` and enforced by DB trigger (see `DATABASE_DESIGN.md` §8). Every transition writes a history row with actor + reason.

Order status, payment status and fulfillment status are **independent**; the order machine reacts to the others through domain events, never by direct field edits.

## 1. Order (`orders.status`)

| From | To | Trigger |
|---|---|---|
| — | `PENDING_PAYMENT` | checkout created, stock reserved |
| `PENDING_PAYMENT` | `PAID` | payment `SUCCEEDED` (verified) |
| `PENDING_PAYMENT` | `CANCELLED` ■ | customer/admin cancels (reservation released) |
| `PENDING_PAYMENT` | `EXPIRED` ■ | reservation TTL elapsed, no payment |
| `PAID` | `FULFILLING` | fulfillment tasks created |
| `PAID` | `ON_HOLD` | fraud/manual review flag, late payment w/o stock |
| `FULFILLING` | `COMPLETED` ■ | all items fulfillment `COMPLETED` |
| `FULFILLING` | `PARTIALLY_COMPLETED` | some items done, others `FAILED` |
| `FULFILLING` | `ON_HOLD` | needs attention |
| `PARTIALLY_COMPLETED` | `COMPLETED` ■ | failed items resolved |
| `PARTIALLY_COMPLETED` / `ON_HOLD` / `PAID` | `CANCELLED` ■ | only via approved refund of all undelivered items |
| `ON_HOLD` | `PAID` / `FULFILLING` | review passed |

Refunds do not change `orders.status` into a "refunded" lifecycle state; they are tracked by `refunds` and surfaced as `orders.payment_status ∈ PARTIALLY_REFUNDED | REFUNDED`.

## 2. Payment (`payments.status`)

| From | To | Notes |
|---|---|---|
| — | `INITIATED` | row created, idempotency key stored |
| `INITIATED` | `PENDING` | gateway request created, customer redirected |
| `INITIATED` | `FAILED` ■ | gateway request creation failed |
| `PENDING` | `VERIFYING` | callback/return received; verify call in flight (conditional UPDATE = lock) |
| `PENDING` | `EXPIRED` ■ / `CANCELLED` ■ | user abandoned / cancelled at gateway |
| `VERIFYING` | `SUCCEEDED` | verified server-to-server, amount+ref match |
| `VERIFYING` | `FAILED` ■ | gateway says failed |
| `VERIFYING` | `NEEDS_REVIEW` | amount/ref mismatch, ambiguous reply, verify timeout (retry verify; do not fail) |
| `NEEDS_REVIEW` | `SUCCEEDED` / `FAILED` ■ | manual resolution (requires permission, audited) |
| `SUCCEEDED` | `PARTIALLY_REFUNDED` → `REFUNDED` ■ | via completed refunds |

Wallet payments skip `PENDING`: `INITIATED → SUCCEEDED` inside the ledger-posting transaction.

## 3. Fulfillment task (`fulfillment_tasks.status`, one per order item)

Created only after the order is `PAID`.

| From | To | Notes |
|---|---|---|
| — | `PENDING` | task created |
| `PENDING` | `PROCESSING` | auto: codes allocated / supplier submitted; manual: admin picks up |
| `PROCESSING` | `COMPLETED` ■ | delivery record + secret stored (payment gate re-checked) |
| `PROCESSING` | `FAILED` | error / supplier rejected / no stock |
| `FAILED` | `PENDING` | safe retry |
| `FAILED` | `PROCESSING` | manual fallback assigned |
| `FAILED` | `CANCELLED` ■ | refund approved |
| `PENDING`/`PROCESSING` | `CANCELLED` ■ | refund approved before delivery |

Customer-visible labels: PENDING→"در انتظار", PROCESSING→"در حال انجام", COMPLETED→"تحویل شد", FAILED→"نیازمند بررسی".

## 4. Inventory reservation (`inventory_reservations.status`)

| From | To | Notes |
|---|---|---|
| — | `ACTIVE` | created with order, has `expires_at` |
| `ACTIVE` | `CONSUMED` ■ | payment verified, codes → SOLD |
| `ACTIVE` | `RELEASED` ■ | order cancelled |
| `ACTIVE` | `EXPIRED` ■ | TTL sweep |

## 5. Supplier order (`supplier_orders.status`)

| From | To | Notes |
|---|---|---|
| — | `CREATED` | idempotency key fixed before first send |
| `CREATED` | `SUBMITTING` | request about to be sent (persisted *before* the call) |
| `SUBMITTING` | `CONFIRMED` ■ | explicit supplier confirmation |
| `SUBMITTING` | `REJECTED` ■ | explicit supplier rejection (safe to try next supplier) |
| `SUBMITTING` | `UNKNOWN` | timeout/5xx/connection loss — **outcome unknown, no blind retry** |
| `UNKNOWN` | `CONFIRMED` / `REJECTED` | via status query or manual reconciliation |
| `UNKNOWN` | `CREATED` | only if supplier guarantees idempotent resubmit with same key (per its docs) |

## 6. Refund (`refunds.status`)

`REQUESTED → APPROVED | REJECTED■ → PROCESSING → COMPLETED■ | FAILED`; `FAILED → PROCESSING` (retry). Completion posts the ledger reversal. Items whose secrets were revealed need an explicit override permission.

## 7. Support ticket (`tickets.status`)

`OPEN → IN_PROGRESS → ANSWERED → WAITING_FOR_CUSTOMER → (customer reply) → IN_PROGRESS`; any → `CLOSED`; `CLOSED → OPEN` (reopen within N days, **[OPEN]**). Customer reply on `ANSWERED`/`WAITING_FOR_CUSTOMER` → `OPEN`/`IN_PROGRESS`.

## 8. Code (`digital_codes.status`)

`AVAILABLE ↔ RESERVED → SOLD ■`; `AVAILABLE|RESERVED → VOID ■`; `AVAILABLE → QUARANTINED → AVAILABLE|VOID` (suspected bad batch). `SOLD` is never reversed except by an explicit audited admin `VOID`.
