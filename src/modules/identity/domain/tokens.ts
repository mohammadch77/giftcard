import { createHash, randomBytes, randomInt } from "node:crypto";

/** 256-bit session token (base64url). Only its SHA-256 digest is ever stored. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sessionTokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function isWellFormedSessionToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** Uniform 6-digit code via CSPRNG (randomInt is unbiased). */
export function generateOtpCode(digits = 6): string {
  return String(randomInt(0, 10 ** digits)).padStart(digits, "0");
}

const RC_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols, no 0/O/1/I

/** 16 symbols x 5 bits = 80 bits, displayed as XXXX-XXXX-XXXX-XXXX. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(16);
  const raw = Array.from(bytes, (b) => RC_ALPHABET[b & 31]).join("");
  return raw.match(/.{4}/g)!.join("-");
}

export function normalizeRecoveryCode(input: string): string | null {
  const v = input.normalize("NFKC").toUpperCase().replace(/[\s\-​-‏]/g, "");
  return /^[A-HJ-NP-Z2-9]{16}$/.test(v) ? v : null;
}
