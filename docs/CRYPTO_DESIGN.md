# CRYPTO_DESIGN.md — secrets, keys, fingerprints, logging

Status: **implemented in step 2b-1b** (`src/platform/crypto`, `src/platform/logging`, `src/platform/composition`). Custody of the real KEK is **undecided (D8)**; no production provider exists; no real key exists anywhere in this repository.

## 1. Building blocks
| Piece | What it does | File |
|---|---|---|
| `KeyProvider` (port) | Holds the KEK versions and the HMAC pepper versions. **Key material never leaves the provider**: callers ask it to `wrapDek`/`unwrapDek` and to `hmac`. This is what allows an external KMS/HSM/secret manager later. | `crypto/key-provider.ts` |
| Envelope encryption | `sealSecret` / `openSecret` / `withSecret`: AES-256-GCM, a fresh random 256-bit DEK and 96-bit nonce per secret; ciphertext = `nonce \| ct \| tag`; the DEK is wrapped by the provider under the current KEK version. | `crypto/envelope.ts` |
| AAD binding | Data and DEK are bound to `(table, rowId, kind)` with an unambiguous length-prefixed encoding, and the data layer and DEK layer use different AAD. A blob copied to another row/table/purpose fails authentication. | `secretAad` |
| Re-wrap (rotation) | `rewrapSecret`: unwrap the DEK with its old KEK version, wrap under the current one. **The payload ciphertext is not touched. Nothing is deleted.** Idempotent. | `rewrapSecret` |
| Storage encoding | `SealedSecret {format, kekVersion, wrappedDek, ciphertext}` maps to the columns `ciphertext`, `wrapped_dek`, `kek_version` (DATABASE_DESIGN §5.2); `encodeSealed/decodeSealed` give a single-value form. | `envelope.ts` |
| Fingerprints | `fingerprint()` = HMAC-SHA256(pepper[v], len-prefixed purpose \| normalised value); `fingerprintsAllVersions()` for duplicate lookups across a pepper rotation; `digestsEqual` is constant-time. `normalizeCode()` handles NFKC, Persian/Arabic-Indic digits, whitespace and bidi marks; **no case folding / dash stripping by default** (some codes are case-sensitive). | `crypto/fingerprint.ts` |
| Separation of keys | KEKs and peppers are independent secrets with independent version numbers; the dev provider refuses to be constructed if any pepper equals any KEK or any two keys are identical. | `testing/dev-key-provider.ts` |
| `NullKeyProvider` | `KEY_PROVIDER=none` (the default and the only value allowed in production today): every operation throws `KEY_PROVIDER_NOT_CONFIGURED`. Crypto features therefore **fail closed**. | `crypto/null-provider.ts` |
| Dev provider | In-memory KEK/pepper from caller-supplied bytes (random in tests; `DEV_*` env variables in local development). Lives in `testing/`, so production code cannot import it. | `crypto/testing/` |
| Guarded factory | `createKeyProvider(env)` is the **only** production-path file allowed (dependency-cruiser exemption) to import the dev provider, and it refuses at runtime when `NODE_ENV=production`, in addition to env validation. | `composition/key-provider.ts` |
| Log protection | `redact()` / `scrubString()` and a structured JSON `Logger` that passes every field and message through them; see §6. | `logging/` |

## 2. Where the keys come from (and where they never are)
- **Never in the database, never in source control, never in logs.** `.env` is gitignored; `.env.example` contains only `KEY_PROVIDER=none` and instructions.
- Development: `npx tsx scripts/generate-dev-keys.ts` prints *throw-away* random values to stdout (nothing is written to disk) for a local `.env`.
- Production: **no provider is implemented** until D8 is decided. The conformance suite `tests/helpers/key-provider-conformance.ts` is the acceptance test for any future provider (root-only file, secret manager, external KMS/HSM).
- Env validation rejects `KEY_PROVIDER=dev` in production **and any `DEV_*` variable in production**, and rejects KEK/pepper values that repeat; error messages name variables, never values.

## 3. Failure behaviour (tested)
| Situation | Behaviour | Data | Recovery |
|---|---|---|---|
| Provider unreachable / refuses / throws something unexpected | `KEY_UNAVAILABLE`; no plaintext, no partial write; an unexpected provider error is **replaced** (its message/cause are dropped, they may contain key data) | untouched | retry when the provider is back (tested: works again) |
| KEK version **lost** (not loaded / backup missing) | `KEY_VERSION_UNKNOWN` for every secret that references it | ciphertext and wrapped DEK stay intact in the database; nothing is modified or deleted (tested by table digest) | restore the KEK from backup → reads work again (tested). **Without a backup of the KEK the secrets are unrecoverable by design — KEK backup custody is the #1 operational risk (D8).** |
| KEK **replaced** by different bytes under the same version number | `DECRYPT_FAILED` (GCM authentication) — never garbage plaintext | untouched | restore the correct KEK |
| Data or AAD tampered / moved to another row | `DECRYPT_FAILED` | untouched | restore from backup; investigate |
| No provider configured (`none`) | `KEY_PROVIDER_NOT_CONFIGURED` for seal, open and fingerprint | — | configure a provider |
| Pepper version lost | old fingerprints cannot be recomputed (`KEY_VERSION_UNKNOWN`); new ones work; sealed secrets are unaffected (different key) | untouched | restore the pepper, or re-hash after decrypting (needs the KEK) |
All errors are typed `DomainError`s with stable codes and contain no key material, plaintext or wrapped bytes (tested with canaries).

## 4. Key rotation runbook (design; the mechanism is tested)
**KEK rotation**
1. Add KEK v(n+1) to the provider and make it current. Old versions stay available.
2. New secrets are sealed under v(n+1); old ones remain readable (tested).
3. Run a background re-wrap job: per row `rewrapSecret`, then `UPDATE … SET wrapped_dek, kek_version WHERE id = :id AND kek_version = :old` (optimistic; tested with two concurrent workers). Each row is independent, so an interrupted run leaves everything readable (tested with a crash after 230 of 500 rows).
4. **Retirement check** (operator, never automatic): `SELECT count(*) FROM … WHERE kek_version = n` must be 0 across **every** table that stores sealed secrets, and a backup containing the old KEK must be kept for as long as any backup/snapshot of the database that references version n exists. Only then may v(n) stop being loaded. (Tested: retiring too early strands exactly the not-yet-re-wrapped rows.)
5. Nothing is deleted or shredded at any point (decision: no crypto-shred without an approved policy).

**Pepper rotation**: add pepper v(n+1) as current; duplicate lookups use `fingerprintsAllVersions` (tested); a maintenance job decrypts each secret and stores the new fingerprint; only after all rows are re-hashed may the old pepper be retired. Until then the unique index does not protect against duplicates written under a different version, which is why `isDuplicate` (all-versions lookup) must run before inserts.

## 5. Limits and honest caveats
- **JavaScript cannot guarantee memory erasure.** DEKs and plaintext Buffers are zeroed after use (tested), but strings are immutable and the GC/heap dumps/swap are out of our control. Callers should handle secrets as Buffers, keep their lifetime short and use `withSecret`.
- The dev provider holds keys in process memory: a heap dump of a dev process exposes them. It is not a custody solution.
- Fingerprints protect against a database leak, not against someone who has the pepper *and* can guess codes: low-entropy codes remain guessable by whoever holds the pepper.
- `normalizeCode` defaults are conservative; per-variant normalisation (case folding, dash stripping) must be an explicit, tested catalogue setting, otherwise duplicate detection is weaker (not wrong).
- Authenticated encryption protects confidentiality/integrity of each blob; it does not prevent **deletion or rollback** of rows by someone with database write access (covered by grants, append-only guards and backups, not by this layer).
- Side-channel and timing attacks on Node's OpenSSL bindings are out of scope.
- Real custody (backup shares, access control, audit of KEK use, HSM) is **D8** and requires a decision before any real secret is stored.

## 6. Log and error protection
- `redact(value, {knownSecrets})`: replaces values under sensitive key names (password, token, authorization, cookie, otp, pin, cvv, card, kek, dek, pepper, credential, private key, plaintext, ciphertext, wrapped, signature, session, voucher, redeem, serial, seed, …) and scrubs sensitive-looking strings (Bearer/Basic, JWT, long opaque tokens ≥ 32 chars, Luhn-valid card numbers). `Buffer`/typed arrays are never printed. A runtime-known secret (e.g. a code just decrypted for delivery) can be passed as `knownSecrets` and is removed from **any** string, including error messages. Input is not mutated; cycles/depth/size are bounded; it never throws.
- The `Logger` (`createLogger`, `configureLogger`, `getLogger`) writes one JSON line per record and redacts message and fields; a failing sink or hostile field cannot break the caller. `src/worker` and the DB pool use it; ESLint forbids `console.log`.
- It is a **safety net**: the rule remains that secrets must not be passed to loggers at all. A field named plainly `code` is *not* auto-redacted (it collides with error codes) — name secret fields `secret…`, `plaintext…`, `voucher…`.
- Outbox `last_error` stores a classification only (never a message).

## 7. What is NOT in this step
No business table, no inventory/credential storage, no real provider, no TOTP, no OTP, no ledger/wallet, no key deletion or crypto-shredding.
