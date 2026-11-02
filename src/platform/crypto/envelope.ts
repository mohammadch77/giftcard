import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DomainError } from "../errors";
import { DEK_BYTES } from "./key-provider";
import type { KeyProvider } from "./key-provider";

/**
 * Envelope encryption (AES-256-GCM, fresh random DEK per secret).
 *
 *   plaintext --AES-256-GCM(DEK, nonce, AAD)--> ciphertext = nonce(12) | ct | tag(16)
 *   DEK       --KeyProvider.wrapDek(KEK vN, AAD')--> wrappedDek
 *
 * AAD binds the ciphertext AND the wrapped DEK to (table, rowId, kind) so a valid blob cannot be
 * moved to another row/column/purpose (swap attack). Because every secret has its own DEK, the
 * random 96-bit nonce is never reused under one key.
 * Storage mapping (see DATABASE_DESIGN §5.2): ciphertext, wrapped_dek, kek_version (+ format).
 * Nothing in this module deletes or shreds data; rotation re-wraps DEKs only.
 */
export const SEALED_FORMAT = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SecretContext {
  /** Owning table (or logical store), e.g. 'digital_codes'. */
  table: string;
  /** Row id (string form). */
  rowId: string;
  /** Purpose of the secret, e.g. 'code', 'account_credential', 'supplier_credential'. */
  kind: string;
}

export interface SealedSecret {
  format: typeof SEALED_FORMAT;
  kekVersion: number;
  wrappedDek: Buffer;
  /** nonce | ciphertext | tag */
  ciphertext: Buffer;
}

const CTX_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Canonical, unambiguous (length-prefixed) AAD. `part` separates the data layer from the DEK layer. */
export function secretAad(ctx: SecretContext, part: "data" | "dek"): Buffer {
  for (const v of [ctx.table, ctx.rowId, ctx.kind]) {
    if (!CTX_RE.test(v)) throw new DomainError("INVALID_ARGUMENT", "invalid secret context");
  }
  const fields = ["gc-secret-v1", part, ctx.table, ctx.rowId, ctx.kind].map((f) => Buffer.from(f, "utf8"));
  return Buffer.concat(fields.flatMap((f) => [Buffer.from([f.length >> 8, f.length & 0xff]), f]));
}

function classifyProviderFailure(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  // Unknown failure from a provider: fail closed, never propagate its message/cause (may be sensitive).
  return new DomainError("KEY_UNAVAILABLE", "key provider failure");
}

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw classifyProviderFailure(e);
  }
}

export async function sealSecret(provider: KeyProvider, plaintext: Buffer | string, ctx: SecretContext): Promise<SealedSecret> {
  const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const dek = randomBytes(DEK_BYTES);
  try {
    const kekVersion = guard(() => provider.currentKekVersion());
    let wrappedDek: Buffer;
    try {
      wrappedDek = await provider.wrapDek(dek, kekVersion, secretAad(ctx, "dek"));
    } catch (e) {
      throw classifyProviderFailure(e);
    }
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", dek, nonce);
    cipher.setAAD(secretAad(ctx, "data"));
    const ct = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { format: SEALED_FORMAT, kekVersion, wrappedDek, ciphertext: Buffer.concat([nonce, ct, tag]) };
  } finally {
    dek.fill(0); // best effort: shorten the DEK's lifetime in memory
  }
}

/** Returns plaintext bytes. The CALLER must `.fill(0)` the buffer when done (or use withSecret). */
export async function openSecret(provider: KeyProvider, sealed: SealedSecret, ctx: SecretContext): Promise<Buffer> {
  if (sealed.format !== SEALED_FORMAT) throw new DomainError("SEALED_FORMAT_INVALID", "unsupported sealed format");
  if (sealed.ciphertext.length < NONCE_BYTES + TAG_BYTES) throw new DomainError("SEALED_FORMAT_INVALID", "ciphertext too short");
  let dek: Buffer;
  try {
    dek = await provider.unwrapDek(sealed.wrappedDek, sealed.kekVersion, secretAad(ctx, "dek"));
  } catch (e) {
    throw classifyProviderFailure(e);
  }
  try {
    const nonce = sealed.ciphertext.subarray(0, NONCE_BYTES);
    const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES);
    const ct = sealed.ciphertext.subarray(NONCE_BYTES, sealed.ciphertext.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", dek, nonce);
    decipher.setAAD(secretAad(ctx, "data"));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
      throw new DomainError("DECRYPT_FAILED", "secret failed authentication");
    }
  } finally {
    dek.fill(0);
  }
}

/** Open, run `fn` with the plaintext, then zero it (even if fn throws). */
export async function withSecret<T>(provider: KeyProvider, sealed: SealedSecret, ctx: SecretContext, fn: (plaintext: Buffer) => Promise<T> | T): Promise<T> {
  const plaintext = await openSecret(provider, sealed, ctx);
  try {
    return await fn(plaintext);
  } finally {
    plaintext.fill(0);
  }
}

/**
 * Key rotation: re-wrap the DEK under the provider's CURRENT KEK version. The payload ciphertext is
 * untouched (no re-encryption, nothing deleted). Idempotent: already-current secrets are returned
 * unchanged. Each secret is independent, so an interrupted run leaves every secret decryptable.
 * The old KEK version must stay available until no stored secret references it (operator check).
 */
export async function rewrapSecret(provider: KeyProvider, sealed: SealedSecret, ctx: SecretContext): Promise<SealedSecret> {
  const target = guard(() => provider.currentKekVersion());
  if (sealed.kekVersion === target) return sealed;
  let dek: Buffer;
  try {
    dek = await provider.unwrapDek(sealed.wrappedDek, sealed.kekVersion, secretAad(ctx, "dek"));
  } catch (e) {
    throw classifyProviderFailure(e);
  }
  try {
    const wrappedDek = await provider.wrapDek(dek, target, secretAad(ctx, "dek")).catch((e: unknown) => {
      throw classifyProviderFailure(e);
    });
    return { ...sealed, kekVersion: target, wrappedDek };
  } finally {
    dek.fill(0);
  }
}

/** Compact single-value encoding: format(1) | kekVersion(4, BE) | wrappedLen(2, BE) | wrapped | ciphertext. */
export function encodeSealed(s: SealedSecret): Buffer {
  const header = Buffer.alloc(7);
  header.writeUInt8(s.format, 0);
  header.writeUInt32BE(s.kekVersion, 1);
  header.writeUInt16BE(s.wrappedDek.length, 5);
  return Buffer.concat([header, s.wrappedDek, s.ciphertext]);
}

export function decodeSealed(buf: Buffer): SealedSecret {
  if (buf.length < 7 + NONCE_BYTES + TAG_BYTES) throw new DomainError("SEALED_FORMAT_INVALID", "sealed value too short");
  const format = buf.readUInt8(0);
  if (format !== SEALED_FORMAT) throw new DomainError("SEALED_FORMAT_INVALID", "unsupported sealed format");
  const kekVersion = buf.readUInt32BE(1);
  const wrappedLen = buf.readUInt16BE(5);
  if (7 + wrappedLen + NONCE_BYTES + TAG_BYTES > buf.length) throw new DomainError("SEALED_FORMAT_INVALID", "inconsistent lengths");
  return {
    format: SEALED_FORMAT,
    kekVersion,
    wrappedDek: Buffer.from(buf.subarray(7, 7 + wrappedLen)),
    ciphertext: Buffer.from(buf.subarray(7 + wrappedLen)),
  };
}
