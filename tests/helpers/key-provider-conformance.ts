import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { KeyProvider } from "@/platform/crypto";

/**
 * Conformance suite: EVERY KeyProvider (dev today; file/KMS/HSM/secret-manager later, decision D8)
 * must pass these tests. Registers its own describe block.
 */
const code = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return (e as { code?: string }).code ?? "OTHER";
  }
  return "NO_ERROR";
};

export function keyProviderConformance(name: string, make: () => KeyProvider): void {
  describe(`KeyProvider conformance: ${name}`, () => {
    const aad = Buffer.from("conformance-aad");

    it("identifies itself and lists versions that include the current ones", () => {
      const p = make();
      expect(p.kind.length).toBeGreaterThan(0);
      expect(p.kekVersions()).toContain(p.currentKekVersion());
      expect(p.hmacVersions()).toContain(p.currentHmacVersion());
    });

    it("wraps and unwraps a 32-byte DEK; every wrap is different and never equals the DEK", async () => {
      const p = make();
      const dek = randomBytes(32);
      const a = await p.wrapDek(dek, p.currentKekVersion(), aad);
      const b = await p.wrapDek(dek, p.currentKekVersion(), aad);
      expect(a.equals(b)).toBe(false);
      expect(a.includes(dek)).toBe(false);
      expect((await p.unwrapDek(a, p.currentKekVersion(), aad)).equals(dek)).toBe(true);
      expect((await p.unwrapDek(b, p.currentKekVersion(), aad)).equals(dek)).toBe(true);
    });

    it("rejects a different AAD, a flipped bit, a truncated blob (DECRYPT_FAILED)", async () => {
      const p = make();
      const v = p.currentKekVersion();
      const wrapped = await p.wrapDek(randomBytes(32), v, aad);
      expect(await code(p.unwrapDek(wrapped, v, Buffer.from("other-aad")))).toBe("DECRYPT_FAILED");
      for (const i of [0, Math.floor(wrapped.length / 2), wrapped.length - 1]) {
        const flipped = Buffer.from(wrapped);
        flipped[i] = (flipped[i] ?? 0) ^ 0x01;
        expect(await code(p.unwrapDek(flipped, v, aad))).toBe("DECRYPT_FAILED");
      }
      expect(await code(p.unwrapDek(wrapped.subarray(0, wrapped.length - 1), v, aad))).toBe("DECRYPT_FAILED");
    });

    it("unknown KEK/pepper versions fail with KEY_VERSION_UNKNOWN (never a default key)", async () => {
      const p = make();
      expect(await code(p.wrapDek(randomBytes(32), 424242, aad))).toBe("KEY_VERSION_UNKNOWN");
      expect(await code(p.unwrapDek(randomBytes(60), 424242, aad))).toBe("KEY_VERSION_UNKNOWN");
      expect(await code(p.hmac(Buffer.from("x"), 424242))).toBe("KEY_VERSION_UNKNOWN");
    });

    it("HMAC: 32 bytes, deterministic, input-sensitive", async () => {
      const p = make();
      const v = p.currentHmacVersion();
      const a = await p.hmac(Buffer.from("data-1"), v);
      expect(a.length).toBe(32);
      expect((await p.hmac(Buffer.from("data-1"), v)).equals(a)).toBe(true);
      expect((await p.hmac(Buffer.from("data-2"), v)).equals(a)).toBe(false);
    });

    it("exposes no operation that returns key material", () => {
      const p = make();
      const names = new Set([...Object.getOwnPropertyNames(Object.getPrototypeOf(p)), ...Object.getOwnPropertyNames(p)]);
      for (const n of names) expect(n).not.toMatch(/^(get|export|reveal|read|dump)(kek|key|pepper|secret)/i);
    });
  });
}
