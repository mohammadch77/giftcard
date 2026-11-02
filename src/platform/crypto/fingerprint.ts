import { timingSafeEqual } from "node:crypto";
import { DomainError } from "../errors";
import type { KeyProvider } from "./key-provider";

/**
 * Duplicate detection for secrets (codes/credentials) WITHOUT storing anything reversible.
 * fingerprint = HMAC-SHA256(pepper[v], len-prefixed(purpose) | normalized value).
 * A KEYED hash is required: gift codes are low-entropy, so a plain SHA-256 column would be
 * brute-forceable after a database leak. The pepper is a different secret from every KEK and is
 * held by the KeyProvider.
 */
export interface Fingerprint {
  hmacVersion: number;
  digest: Buffer;
}

const PURPOSE_RE = /^[a-z][a-z0-9_.:-]{0,63}$/;

/** Numerals normalisation + whitespace removal. Deliberately NO case folding and NO dash stripping
 *  by default: some codes are case-sensitive, and folding could create false "duplicates".
 *  Per-variant rules can opt in later. */
export function normalizeCode(raw: string, options: { foldCase?: boolean; stripDashes?: boolean } = {}): string {
  let v = raw.normalize("NFKC");
  v = v.replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0)); // Persian digits
  v = v.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)); // Arabic-Indic digits
  v = v.replace(/[\s​-‏‪-‮⁦-⁩﻿]/g, ""); // whitespace + bidi/zero-width marks
  if (options.stripDashes) v = v.replace(/[-‐-―−]/g, "");
  if (options.foldCase) v = v.toUpperCase();
  if (v.length === 0) throw new DomainError("INVALID_ARGUMENT", "empty value");
  return v;
}

function message(purpose: string, normalized: string): Buffer {
  if (!PURPOSE_RE.test(purpose)) throw new DomainError("INVALID_ARGUMENT", "invalid fingerprint purpose");
  const p = Buffer.from(purpose, "utf8");
  return Buffer.concat([Buffer.from([p.length]), p, Buffer.from(normalized, "utf8")]);
}

export async function fingerprint(provider: KeyProvider, purpose: string, normalized: string, hmacVersion?: number): Promise<Fingerprint> {
  const version = hmacVersion ?? provider.currentHmacVersion();
  const msg = message(purpose, normalized);
  try {
    return { hmacVersion: version, digest: await provider.hmac(msg, version) };
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw new DomainError("KEY_UNAVAILABLE", "key provider failure");
  }
}

/** Fingerprints under EVERY available pepper version: use for duplicate lookups so a pepper rotation
 *  never hides an existing duplicate. */
export async function fingerprintsAllVersions(provider: KeyProvider, purpose: string, normalized: string): Promise<Fingerprint[]> {
  let versions: readonly number[];
  try {
    versions = provider.hmacVersions();
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw new DomainError("KEY_UNAVAILABLE", "key provider failure");
  }
  return Promise.all(versions.map((v) => fingerprint(provider, purpose, normalized, v)));
}

export function digestsEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
