# STATE_MACHINES.md

Status: **DRAFT v0.2 (late-payment / hold paths, refund snapshot).** Terminal states are marked ■. Each machine is seeded into `state_transition_rules` and enforced by DB trigger (see `DATABASE_DESIGN.md` §8). Every transition writes a history row with actor + reason.

Order status, payment status and fulfillment status are **independent**; the order machine reacts to the others through domain events, never by direct field edits.

## 1. Order (`orders.status`)

| From | To | Trigger |
|---|---|---|
| — | `PENDING_PAYMENT` | checkout created, stock reserved |
| `PENDING_PAYMENT` | `PAID` | payment `SUCCEEDED` (verified) |
| `PENDING_PAYMENT` | `CANCELLED` ■ | customer/admin cancels (reservation released) |
| `PENDING_PAYMENT` | `EXPIRED` ■ | reservation TTL elapsed, no payment |
| `PAID` | `FULFILLING` | fulfillment tasks created |
| `PENDING_PAYMENT` | `ON_HOLD` | **late payment**: payment verified but reservation lapsed (hold reason `LATE_PAYMENT_NO_RESERVATION`); money in suspense; no fulfillment |
| `EXPIRED` / `CANCELLED` | `ON_HOLD` | **only** for a late payment arriving after expiry/cancellation (hold reason `LATE_PAYMENT_NO_RESERVATION`). These two states are otherwise terminal; the transition-rule table must encode this exception explicitly |
| `PAID` | `ON_HOLD` | fraud/manual review flag |
| `FULFILLING` | `COMPLETED` ■ | all items fulfillment `COMPLETED` |
| `FULFILLING` | `PARTIALLY_COMPLETED` | some items done, others `FAILED` |
| `FULFILLING` | `ON_HOLD` | needs attention |
| `PARTIALLY_COMPLETED` | `COMPLETED` ■ | failed items resolved |
| `PARTIALLY_COMPLETED` / `ON_HOLD` / `PAID` | `CANCELLED` ■ | only via approved refund of all undelivered items |
| `ON_HOLD` | `PAID` | hold resolved by **re-reservation** (new reservation consumed) or review passed; then normal fulfillment |
| `ON_HOLD` | `CANCELLED` ■ | hold resolved by completed refund (wallet or gateway) |

Every `ON_HOLD` has an open row in `order_holds` (reason, opener, resolver, resolution, note). Resolution requires `orders.resolve_hold`; the transition and the hold closure are one transaction. Late-payment orders never reach `FULFILLING` except through `PAID` after a successful re-reservation.

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
| `VERIFYING` | `NEEDS_REVIEW` | amount/ref mismatch, ambiguous reply, verify timeout (retry verify; do not fail). Money, if any, is posted to suspense |
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
| `ACTIVE` | `CONSUMED` ■ | payment verified **while ACTIVE and unexpired** (conditional update); only then may codes → SOLD |
| `ACTIVE` | `RELEASED` ■ | order cancelled |
| `ACTIVE` | `EXPIRED` ■ | TTL sweep. **No extension of any kind exists** (D9): a payment in `VERIFYING` does not delay expiry |

A reservation in `EXPIRED`/`RELEASED` is never revived. Late-payment recovery creates a **new** reservation.

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

`REQUESTED → APPROVED | REJECTED■ → PROCESSING → COMPLETED■ | FAILED`; `FAILED → PROCESSING` (retry). At `REQUESTED` the per-item delivery/disclosure state is snapshotted (`NOT_DELIVERED | DELIVERED_UNREVEALED | REVEALED_BY_CUSTOMER | REVEALED_BY_ADMIN_ONLY`). `APPROVED` for any item beyond `NOT_DELIVERED` follows the configurable policy; launch default = review required, and revealed items need `refunds.override_revealed` + written reason. Completion posts the ledger entries; a delivered code is voided, never restocked. Final rules pending business/legal decision.

## 7. Support ticket (`tickets.status`)

`OPEN → IN_PROGRESS → ANSWERED → WAITING_FOR_CUSTOMER → (customer reply) → IN_PROGRESS`; any → `CLOSED`; `CLOSED → OPEN` (reopen within N days, **[OPEN]**). Customer reply on `ANSWERED`/`WAITING_FOR_CUSTOMER` → `OPEN`/`IN_PROGRESS`.

## 8. Code (`digital_codes.status`)

`AVAILABLE ↔ RESERVED → SOLD ■`; `AVAILABLE|RESERVED → VOID ■`; `AVAILABLE → QUARANTINED → AVAILABLE|VOID` (suspected bad batch). `SOLD` is never reversed except by an explicit audited admin `VOID`. **P1-B (OPS-2):** `AVAILABLE|QUARANTINED → EXPIRED ■` (terminal) once the supplier-provided `expires_at` has passed — done only by the expiry sweeper, never for `RESERVED` or `SOLD` (a sold code stays `SOLD`; a reserved code must outlive its reservation, so it cannot expire while held). Counted stock has no per-unit status.


## Refund (implemented in 2b-9, machine `refund`)
`(none) → REQUESTED → APPROVED | REJECTED ■`; `APPROVED → PROCESSING → COMPLETED ■ | FAILED`; `FAILED → PROCESSING` (retry). Every transition needs an actor (engine + history `refund_status_history`). Extra DB rules: COMPLETED needs a ledger transaction and (gateway) external outcome CONFIRMED; DENIED cannot leave REQUESTED/REJECTED; an ADMIN requester cannot also decide. Gateway outcome (`external_outcome`) is separate from status: NONE → UNKNOWN (intent committed before the call) → ACCEPTED → CONFIRMED, or REJECTED.
**Deviation recorded:** the order `payment_status` cache is NOT changed to `PARTIALLY_REFUNDED/REFUNDED` in 2b-9 (partial refunds do not exist; the refund record + the CANCELLED order are the truth). `orders.status` gains `FULFILLING → CANCELLED` (only through `orders_cancel_gate`: a COMPLETED refund must exist).
