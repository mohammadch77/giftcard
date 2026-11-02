# SUPPLIER_INTEGRATION.md — contract for supplier adapters

**Status: GENERIC. No supplier and no supplier documentation exist (X3).** Nothing below has been verified against a real supplier; the contract is a hypothesis implemented only by `TestSupplier`.

## Port (`src/platform/supplier-adapter`)
`listProducts(credentials)`, `submitOrder({idempotencyKey, externalSku, quantity, credentials})`, `queryOrder({idempotencyKey, externalRef?, credentials})`, plus explicit **capabilities**: `idempotentSubmit`, `statusQuery`, `deliversCodes`. Prices are integer Rial in `IRR`; anything else is rejected by the sync.

## Outcome rules every adapter must satisfy
| Situation | Adapter returns/throws | System state |
|---|---|---|
| Supplier explicitly confirmed | `CONFIRMED` (+ reference, optional codes) | `CONFIRMED`, codes sealed in the same transaction |
| Supplier explicitly refused | `REJECTED(reason)` | `REJECTED` → next route may be tried |
| Timeout / 5xx / connection loss / malformed reply / any other error | throw (or garbage) | **`UNKNOWN`** — never retried blindly |
| Adapter can PROVE nothing was transmitted | `SupplierNotSentError` | back to `CREATED` (safe retry) |
Adapters never log bodies or credentials, never open DB transactions, and take outbound hosts only from deployment configuration (never from data).

## Safe-retry decision tree for `UNKNOWN`
1. `statusQuery`? ask: `CONFIRMED`/`REJECTED` are applied; `NOT_FOUND`/unknown prove nothing.
2. `idempotentSubmit` (a documented supplier guarantee)? resubmit with the **same** key.
3. Otherwise a human decides (`resolveSupplierOrderManually`, sensitive, noted, audited).
While an item's order is ambiguous, **no other supplier is tried** for that item.

## Writing a real adapter (checklist, once documentation exists)
Official docs in hand → map auth/endpoints/fields **inside the adapter file only** → declare capabilities exactly as documented (default all `false`) → test against the supplier's sandbox → add a conformance test that replays the outcome table above → register it in `platform/composition` behind the production guard → record the verified facts here.
