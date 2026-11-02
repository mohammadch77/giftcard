# PHASE_2B_1B_NOTES.md — Crypto & secrets plumbing (step 2b-1b)

Scope (authorised 2026-11-02): `KeyProvider` interface, envelope encryption (AES-GCM), HMAC fingerprints / duplicate detection, separate KEK and pepper, development KeyProvider for tests, protection of sensitive data in logs, tests for encryption / rotation / key failure / recovery; plus the outbox at-least-once requirement (H-1). **Not built:** ledger, wallet, identity, real OTP, payment, supplier, any real provider, TOTP (design only), any key or credential, any deletion / crypto-shredding. Design reference: `CRYPTO_DESIGN.md`.

## What was added
| Area | Files |
|---|---|
| KeyProvider port, envelope (AES-256-GCM, AAD binding, re-wrap, codec), fingerprints/normalisation, fail-closed null provider | `src/platform/crypto/{key-provider,envelope,fingerprint,null-provider,index}.ts` |
| Dev/test providers (**in `testing/`, unreachable from production code**) | `src/platform/crypto/testing/{dev-key-provider,flaky-key-provider}.ts` |
| Guarded factory (single exempted bridge; re-checks production at runtime) | `src/platform/composition/{key-provider,index}.ts` |
| Env: `KEY_PROVIDER=none|dev`, `DEV_KEK_V1/V2`, `DEV_PEPPER_V1/V2` (dev only; rejected in production, must be distinct 32-byte base64) | `src/platform/config/env.ts`, `.env.example`, `scripts/generate-dev-keys.ts` (prints throw-away values, writes nothing) |
| Redaction + structured logger (worker and DB pool now use it) | `src/platform/logging/{redact,index}.ts` |
| Outbox: `idempotentHandler(db, consumer, effect)` (effect + idempotency record in one transaction) and documented at-least-once semantics | `src/platform/outbox/index.ts` |
| New error codes | `KEY_PROVIDER_NOT_CONFIGURED`, `KEY_PROVIDER_FORBIDDEN`, `KEY_UNAVAILABLE`, `KEY_VERSION_UNKNOWN`, `DECRYPT_FAILED`, `SEALED_FORMAT_INVALID` |
| Architecture rule | `no-testing-doubles-in-production` now exempts only `src/platform/composition/`; fixture tests prove it |
| Docs | `CRYPTO_DESIGN.md`, `TOTP_DESIGN.md`, this file; DECISIONS, OPEN_QUESTIONS (B14), PLAN, SECURITY updated |
**No migration was added** (no table). **No new dependency** (Node `crypto` only).

## Verification (2026-11-02; PostgreSQL 16.15; Node 22.23)
Application tests, all against real PostgreSQL where a database is involved:
| Suite | Result | Per file |
|---|---|---|
| unit | **127 passed** (was 64) | money 30, crypto-dev-provider 16 (incl. conformance ×2), crypto-envelope 16, crypto-fingerprint 14, boundaries 12, env 11, redact+logger 9, ids/clock 8, key-provider-factory 7, request-hash 4 |
| db | **74 passed** (was 63) | transitions 18, outbox 12, grants 10, idempotency 9, migrations 7, money domains 7, **crypto-store 6**, **outbox-consumers 5** |
| concurrency | **11 passed** (was 7), 3 consecutive stable runs | **crypto 3**, idempotency 3, outbox 3 (+1), transitions 2 |
**Application tests total: 212** (127 + 74 + 11). lint, typecheck, `arch` (64 modules / 94 deps), `db:drift`, `npm audit` and `npm audit --omit=dev` (0 vulnerabilities), `next build`: all clean.
**SQL prototype regression (separate, design reference only): 40 passed, 0 failed** — not evidence of readiness.

### What the tests prove (selected)
- **Envelope:** round-trip for text/unicode/binary/empty/1 MiB; 10,000 seals → 10,000 distinct nonces and wrapped DEKs; stored form never contains the plaintext; tampering with nonce, body, tag, wrapped DEK or KEK version is detected; moving a blob to another row/table/kind fails (swap attack, also via raw SQL against PostgreSQL); the generated DEK and the opened plaintext are zeroed (also when the callback throws).
- **Whole-database check:** after storing a canary code, neither the table content nor a **full `pg_dump`** of the database contains the plaintext or its hex form.
- **Duplicates:** keyed fingerprint ≠ plain SHA-256; equal for equivalent spellings (spaces, zero-width marks, Persian/Arabic digits); separated by purpose; PostgreSQL unique index rejects duplicates; **50 concurrent imports of the same code → exactly 1 row**.
- **KEK rotation:** old secrets stay readable after adding a new KEK; new ones use it; re-wrap leaves payload bytes untouched; 500 DB rows re-wrapped with an interruption after 230 → all readable, 270 correctly reported as still on v1, completed run → 0 rows on v1 and everything readable without v1; two concurrent re-wrap workers → each row changed by exactly one of them, all readable.
- **Pepper rotation:** duplicates remain detectable through the all-versions lookup; a naive v2-only insert would *not* collide (shown); after re-hash the unique index protects again.
- **Failure behaviour:** provider unavailable → `KEY_UNAVAILABLE`, nothing produced, works again when it returns; KEK lost → `KEY_VERSION_UNKNOWN`, stored data byte-for-byte unchanged (table digest), restoring the key restores access; KEK replaced under the same version → `DECRYPT_FAILED` (never garbage); no provider → `KEY_PROVIDER_NOT_CONFIGURED`; unexpected provider errors are replaced so their message/cause (which could contain key material) never leaks.
- **Production guards:** `KEY_PROVIDER=dev` and any `DEV_*` variable rejected by env validation in production; the factory refuses again at runtime even if validation is bypassed; production source cannot import `testing/` (only `src/platform/composition/` can — fixture-tested); the key conformance suite passes for the dev provider (single and rotated).
- **Logs:** nested sensitive keys, Bearer/JWT/long tokens/Luhn card numbers, Buffers, known secrets (also inside error messages), cycles, bigint, hostile getters, huge strings; the logger never throws.
- **Outbox at-least-once (H-1):** worker stops after the side effect and before the ack → the event is re-delivered (attempts = 2) → a *naive* consumer duplicates its effect (shown deliberately), an *idempotent* consumer applies it once; a handler that throws after committing is retried without a duplicate; two consumers of the same event are independent; 25 concurrent deliveries of one event apply the effect once. "Exactly once" is claimed only for these specific transaction-scoped results, never for delivery.

## Findings during implementation
1. My own tests twice encoded wrong expectations (rewrap of an unavailable provider; pepper-loss setup) — fixed the tests, not the code; a concurrency test's "one row" assertion was initially vacuous (table not truncated) and was rewritten.
2. Env validation originally had no way to stop `DEV_*` keys appearing in production when `KEY_PROVIDER=none`; added.
3. `pg` pools emit idle-client errors on the pool (already handled in 2b-1a); the logger replaces the previous `console` call.

## NOT tested / not covered (explicit)
- No production KeyProvider exists; the conformance suite has only run against the dev provider. KMS/HSM/file/secret-manager behaviour (latency, rate limits, outages, permissions) is untested.
- Memory erasure is best-effort (strings, GC, heap dumps, swap are outside our control); no heap-dump test.
- AES-GCM and HMAC come from Node's OpenSSL; no independent known-answer test vectors were added beyond round-trip/tamper tests.
- Throughput / latency of sealing at scale, and DB growth of sealed values, not measured.
- Key backup / restore *procedure* (who holds shares, drills) is design only (D8).
- `redact` is heuristic (e.g. a field named plain `code` is not redacted; short secrets can pass); it is a safety net and not proven against every log shape.
- Nothing stops a privileged DB user from deleting or rolling back rows (that is grants/append-only/backups, outside this layer).
- The `pg_dump` test requires `pg_dump` on PATH (present locally and on the GitHub runner).

## Remaining risks
- **D8 still open: the KEK custody/backup decision gates storing any real secret.** Losing every copy of a KEK makes the affected secrets unrecoverable by design.
- Operators must follow the retirement check (no rows on the old KEK version in *any* table, and backups) — easy to get wrong; consider automating the check in Phase 6.
- The dev provider in a developer's `.env` keeps keys in plain text on disk; developers must not reuse those values anywhere.
- TOTP is undecided (B14); privileged accounts would rely on SMS OTP alone if skipped.
