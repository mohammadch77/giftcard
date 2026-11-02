import { describe, expect, it } from "vitest";
import { createLogger, redact, scrubString, REDACTED } from "@/platform/logging";

const CANARY = "GIFT-CANARY-9F8E7D6C5B4A";
const dump = (v: unknown) => JSON.stringify(v);

describe("redact()", () => {
  it("redacts sensitive keys at any depth and keeps harmless fields", () => {
    const out = redact({
      orderId: "o-1", amount: 100,
      password: "hunter2", apiKey: "k", nested: { Authorization: "Bearer abcdefghijklmnop", token: "t", list: [{ otp: "123456", ok: 1 }] },
      kek: "x", plaintextCode: CANARY, ciphertext: Buffer.from("zz"), cookie: "sid=1", session_id: "s", pepper: "p", voucherCode: CANARY, "set-cookie": "a",
    });
    expect(out).toMatchObject({ orderId: "o-1", amount: 100 });
    expect(dump(out)).not.toContain("hunter2");
    expect(dump(out)).not.toContain(CANARY);
    expect(dump(out)).not.toContain("abcdefghijklmnop");
    expect((out as { nested: { list: { ok: number }[] } }).nested.list[0]?.ok).toBe(1);
  });
  it("scrubs sensitive-looking values even under harmless keys: bearer, JWT, long tokens, card numbers (Luhn)", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = dump(redact({ note: `auth Bearer abcdef1234567890 and ${jwt}`, blob: "A".repeat(40), card: "4111 1111 1111 1111", order: "1234567890123" }));
    expect(out).not.toContain("abcdef1234567890");
    expect(out).not.toContain(jwt);
    expect(out).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAA");
    expect(out).not.toContain("4111");
    expect(out).toContain("1234567890123"); // 13 digits failing Luhn is NOT a card number: kept
  });
  it("never prints binary data", () => {
    const out = dump(redact({ data: Buffer.from(CANARY), u8: new Uint8Array([1, 2, 3]) }));
    expect(out).not.toContain(CANARY);
    expect(out).toContain("REDACTED:binary");
  });
  it("removes registered known secrets from any string, including error messages", () => {
    const err = new Error(`failed to deliver ${CANARY} to user`);
    const out = dump(redact({ msg: `code=${CANARY}`, err }, { knownSecrets: [CANARY] }));
    expect(out).not.toContain(CANARY);
    expect(out).toContain(REDACTED);
  });
  it("handles Errors (with cause and code), cycles, bigint, Map/Set and depth limits without throwing or mutating input", () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    const input = { cyc, big: 10n, map: new Map<string, unknown>([["password", "x"], ["ok", 1]]), set: new Set(["s"]), err: Object.assign(new Error("outer", { cause: new Error("inner") }), { code: "E_X" }), date: new Date("2026-01-01T00:00:00Z") };
    const snapshot = JSON.stringify({ ...input, cyc: undefined, big: undefined, map: undefined, set: undefined });
    const out = redact(input) as Record<string, unknown>;
    expect(dump(out)).toContain("[Circular]");
    expect(dump(out)).toContain("10n");
    expect(dump(out)).not.toContain('"x"');
    expect((out.err as { code: string; cause: { message: string } }).code).toBe("E_X");
    expect((out.err as { cause: { message: string } }).cause.message).toBe("inner");
    expect(JSON.stringify({ ...input, cyc: undefined, big: undefined, map: undefined, set: undefined })).toBe(snapshot);
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 50; i++) { const n: Record<string, unknown> = {}; deep.n = n; deep = n; }
    expect(dump(redact(root))).toContain("[MaxDepth]");
  });
  it("truncates huge strings and survives hostile getters", () => {
    const hostile = { get boom(): string { throw new Error("getter explodes"); } };
    expect(() => redact({ hostile, big: "x".repeat(100_000) })).not.toThrow();
    expect(scrubString("x".repeat(100_000)).length).toBeLessThan(5000);
  });
});

describe("logger", () => {
  const make = (level: "debug" | "info" | "warn" | "error" = "info", extra: { knownSecrets?: string[] } = {}) => {
    const lines: string[] = [];
    return { lines, log: createLogger({ level, sink: { write: (l) => lines.push(l) }, now: () => new Date("2026-01-01T00:00:00Z"), ...extra }) };
  };

  it("writes one JSON object per line with level, time, message and redacted fields", () => {
    const { lines, log } = make();
    log.info("order paid", { orderId: "o-1", token: "abc", code: CANARY, other: "A".repeat(50) });
    const rec = JSON.parse(lines[0] as string);
    expect(rec).toMatchObject({ level: "info", time: "2026-01-01T00:00:00.000Z", msg: "order paid" });
    expect(rec.fields.orderId).toBe("o-1");
    expect(lines[0]).not.toContain("abc\"");
    expect(lines[0]).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });
  it("respects the level and also scrubs the message", () => {
    const { lines, log } = make("warn", { knownSecrets: [CANARY] });
    log.info("ignored");
    log.warn(`leaked ${CANARY}`);
    expect(lines.length).toBe(1);
    expect(lines[0]).not.toContain(CANARY);
  });
  it("never throws, even if the sink or a field misbehaves", () => {
    const log = createLogger({ sink: { write: () => { throw new Error("disk full"); } } });
    expect(() => log.error("x", { a: 1 })).not.toThrow();
    const { log: ok } = make();
    expect(() => ok.error("x", { get bad(): never { throw new Error("no"); } })).not.toThrow();
  });
});
