/**
 * KeyProvider port (decision D8 is OPEN: custody of the KEK is not decided).
 *
 * Design rules:
 *  - The KEK and the HMAC pepper are SEPARATE secrets with SEPARATE version numbers and never leave
 *    the provider: callers ask the provider to wrap/unwrap a DEK and to compute an HMAC. This is
 *    what lets a future provider be an external KMS/HSM, a root-only file, or a secret manager.
 *  - Nothing here persists key material; nothing here deletes anything.
 *  - Providers MUST throw DomainError codes only (never messages containing key bytes, plaintext or
 *    wrapped material):
 *      KEY_UNAVAILABLE        provider/backend cannot be reached or refuses (retry later; fail closed)
 *      KEY_VERSION_UNKNOWN    the requested KEK/pepper version is not available (lost or not loaded)
 *      DECRYPT_FAILED         authentication failed (tampered data, wrong AAD, or a DIFFERENT key
 *                             under the same version number)
 *      KEY_PROVIDER_NOT_CONFIGURED  no provider is configured (the null provider)
 *  - The conformance suite tests/helpers/key-provider-conformance.ts must pass for every provider.
 */
export interface KeyProvider {
  /** Short identifier of the implementation, e.g. 'dev'. Never contains secrets. */
  readonly kind: string;

  /** KEK version used for NEW wraps. */
  currentKekVersion(): number;
  /** All KEK versions currently usable for unwrap (must include the current one). */
  kekVersions(): readonly number[];
  /** Wrap a 32-byte DEK under the given KEK version, bound to `aad`. */
  wrapDek(dek: Buffer, kekVersion: number, aad: Buffer): Promise<Buffer>;
  /** Inverse of wrapDek. Fails (DECRYPT_FAILED) if the wrapped bytes or the AAD were altered. */
  unwrapDek(wrapped: Buffer, kekVersion: number, aad: Buffer): Promise<Buffer>;

  /** Pepper version used for NEW fingerprints. */
  currentHmacVersion(): number;
  /** All pepper versions currently usable (must include the current one). */
  hmacVersions(): readonly number[];
  /** HMAC-SHA256(pepper[version], data) — 32 bytes. The pepper is a different secret from every KEK. */
  hmac(data: Buffer, hmacVersion: number): Promise<Buffer>;
}

export const DEK_BYTES = 32;
export const KEY_BYTES = 32;
