import { randomBytes } from "node:crypto";
import { systemClock } from "../clock";
import type { Clock } from "../clock";

/**
 * Identifier generators.
 *
 * UUIDv7 (RFC 9562): 48-bit Unix-ms timestamp, version 7, variant 10, remaining bits random.
 * Generated in the application (works on any PostgreSQL version, T2). Strictly monotonic per
 * process: if two ids are requested within the same millisecond (or the clock moves back),
 * the timestamp is held and a 12-bit counter in rand_a is incremented.
 */
let lastMs = -1;
let counter = 0;

export function uuidv7(clock: Clock = systemClock): string {
  let ms = clock.now().getTime();
  if (ms <= lastMs) {
    ms = lastMs;
    counter += 1;
    if (counter > 0xfff) {
      // 4096 ids in one ms: move the embedded timestamp forward by 1 ms (still monotonic).
      ms += 1;
      counter = 0;
    }
  } else {
    counter = randomBytes(2).readUInt16BE(0) & 0x1ff; // start low to leave room for increments
  }
  lastMs = ms;

  const bytes = randomBytes(16);
  // 48-bit big-endian timestamp
  const msBig = BigInt(ms);
  for (let i = 0; i < 6; i++) bytes[i] = Number((msBig >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f); // version 7 + counter high nibble
  bytes[7] = counter & 0xff; // counter low byte
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Embedded millisecond timestamp of a UUIDv7. */
export function uuidv7Timestamp(id: string): number {
  if (!isUuid(id) || id[14] !== "7") throw new Error("not a UUIDv7");
  return parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}

/**
 * Public order number: not sequential, not guessable. 10 symbols from a 31-symbol alphabet without
 * look-alike characters (no 0/O/1/I/L) ≈ 49.5 random bits, shown as XXXXX-XXXXX. Uniqueness is
 * enforced by a DB UNIQUE constraint (caller retries on the astronomically rare collision).
 */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // 31 symbols; no 0 O 1 I L

export function generateOrderNumber(): string {
  // Rejection sampling for an unbiased pick from ALPHABET.
  const n = ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = "";
  while (out.length < 10) {
    for (const byte of randomBytes(16)) {
      if (byte < limit && out.length < 10) out += ALPHABET[byte % n];
    }
  }
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

export const ORDER_NUMBER_PATTERN = new RegExp(`^[${ALPHABET}]{5}-[${ALPHABET}]{5}$`);
