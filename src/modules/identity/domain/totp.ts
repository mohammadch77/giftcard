import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** RFC 4648 base32 (no padding on output; padding/spaces/case tolerated on input). */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export type TotpAlgorithm = "sha1" | "sha256" | "sha512";
export interface TotpParams { digits?: number; periodSeconds?: number; algorithm?: TotpAlgorithm }

/** RFC 4226 HOTP with dynamic truncation. */
export function hotp(secret: Buffer, counter: number, digits = 6, algorithm: TotpAlgorithm = "sha1"): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac(algorithm, secret).update(msg).digest();
  const offset = h[h.length - 1]! & 0x0f;
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** RFC 6238 time step T = floor(unixSeconds / period). */
export function totpStep(at: Date, periodSeconds = 30): number {
  return Math.floor(at.getTime() / 1000 / periodSeconds);
}

export function totp(secret: Buffer, at: Date, p: TotpParams = {}): string {
  return hotp(secret, totpStep(at, p.periodSeconds ?? 30), p.digits ?? 6, p.algorithm ?? "sha1");
}

/**
 * Returns the matching time step (within ±`window` steps of `at`) or null. All candidate steps are
 * compared in constant time and without early exit. The CALLER must reject steps <= last used step
 * (replay) with an atomic conditional UPDATE.
 */
export function verifyTotp(secret: Buffer, code: string, at: Date, window = 1, p: TotpParams = {}): number | null {
  const digits = p.digits ?? 6;
  if (code.length !== digits || !/^\d+$/.test(code)) return null;
  const given = Buffer.from(code);
  const base = totpStep(at, p.periodSeconds ?? 30);
  let match: number | null = null;
  for (let d = -window; d <= window; d++) {
    const expected = Buffer.from(hotp(secret, base + d, digits, p.algorithm ?? "sha1"));
    if (timingSafeEqual(given, expected) && match === null) match = base + d;
  }
  return match;
}

export function generateTotpSecret(): Buffer {
  return randomBytes(20); // 160 bits, the RFC 4226 recommended size
}

export function otpauthUri(o: { issuer: string; account: string; secretBase32: string }): string {
  const label = `${encodeURIComponent(o.issuer)}:${encodeURIComponent(o.account)}`;
  return `otpauth://totp/${label}?secret=${o.secretBase32}&issuer=${encodeURIComponent(o.issuer)}&algorithm=SHA1&digits=6&period=30`;
}
