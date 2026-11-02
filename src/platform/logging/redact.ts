/**
 * Log/error redaction. Defence in depth for SECURITY.md: secrets must never reach logs, audit rows,
 * error reports or test output. It is a SAFETY NET, not a licence to log secrets:
 *  - sensitive KEY names are replaced wholesale;
 *  - sensitive-looking STRING values (bearer tokens, long opaque tokens, card numbers, JWTs) are scrubbed;
 *  - runtime-known secrets (e.g. a code just decrypted for delivery) can be registered and are then
 *    removed from ANY string, even inside messages;
 *  - Buffers/typed arrays are never printed;
 *  - input is never mutated; cycles and depth are bounded; the function never throws.
 */
export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY =
  /(pass(word|wd|phrase)?|secret|token|authorization|cookie|set-cookie|api[-_]?key|otp|pin\b|cvv|cvc|card[-_]?(number|no)?|pan\b|kek|dek|pepper|credential|private[-_]?key|plaintext|ciphertext|wrapped|signature|session|voucher|redeem|serial|seed|mnemonic)/i;

const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const LONG_TOKEN = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_=-])/g;
const PAN = /\b(?:\d[ -]?){13,19}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export interface RedactOptions {
  /** Exact secret strings known at runtime; removed from every string value. */
  knownSecrets?: readonly string[];
  maxDepth?: number;
  maxStringLength?: number;
}

export function scrubString(value: string, options: RedactOptions = {}): string {
  let out = value.length > (options.maxStringLength ?? 4000) ? `${value.slice(0, options.maxStringLength ?? 4000)}…[truncated]` : value;
  for (const secret of options.knownSecrets ?? []) {
    if (secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  out = out.replace(BEARER, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  out = out.replace(JWT, REDACTED);
  out = out.replace(PAN, (m) => {
    const digits = m.replace(/[ -]/g, "");
    return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? "[REDACTED:pan]" : m;
  });
  out = out.replace(LONG_TOKEN, "[REDACTED:token]");
  return out;
}

export function redact(input: unknown, options: RedactOptions = {}): unknown {
  const seen = new WeakSet<object>();
  const maxDepth = options.maxDepth ?? 8;

  const walk = (value: unknown, depth: number, keyIsSensitive: boolean): unknown => {
    try {
      if (keyIsSensitive && value !== null && value !== undefined) return REDACTED;
      if (value === null || value === undefined) return value;
      switch (typeof value) {
        case "string":
          return scrubString(value, options);
        case "number":
        case "boolean":
          return value;
        case "bigint":
          return `${value}n`;
        case "symbol":
        case "function":
          return `[${typeof value}]`;
        default:
          break;
      }
      const obj = value as object;
      if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) {
        const len = (obj as { byteLength: number }).byteLength;
        return `[REDACTED:binary ${len} bytes]`;
      }
      if (seen.has(obj)) return "[Circular]";
      if (depth >= maxDepth) return "[MaxDepth]";
      seen.add(obj);
      if (obj instanceof Date) return obj.toISOString();
      if (obj instanceof Error) {
        const e = obj as Error & { code?: unknown; cause?: unknown };
        return {
          name: e.name,
          ...(typeof e.code === "string" || typeof e.code === "number" ? { code: e.code } : {}),
          message: scrubString(e.message ?? "", options),
          ...(e.cause !== undefined ? { cause: walk(e.cause, depth + 1, false) } : {}),
        };
      }
      if (obj instanceof Map) return Object.fromEntries([...obj].map(([k, v]) => [String(k), walk(v, depth + 1, SENSITIVE_KEY.test(String(k)))]));
      if (obj instanceof Set) return [...obj].map((v) => walk(v, depth + 1, false));
      if (Array.isArray(obj)) return obj.map((v) => walk(v, depth + 1, false));
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = walk(v, depth + 1, SENSITIVE_KEY.test(k));
      return out;
    } catch {
      return "[unserialisable]";
    }
  };

  return walk(input, 0, false);
}
