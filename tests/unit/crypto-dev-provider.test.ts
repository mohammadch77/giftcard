import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { DevKeyProvider } from "@/platform/crypto/testing/dev-key-provider";
import { NullKeyProvider } from "@/platform/crypto";
import { keyProviderConformance } from "../helpers/key-provider-conformance";

keyProviderConformance("DevKeyProvider (single version)", () => DevKeyProvider.generate(1));
keyProviderConformance("DevKeyProvider (rotated: KEK v2 + pepper v2)", () => DevKeyProvider.generate(1).withRotation({ newKek: true, newPepper: true }));

describe("DevKeyProvider specifics", () => {
  it("refuses a pepper that equals a KEK, duplicate keys, and wrong key sizes (separation of duties)", () => {
    const k = randomBytes(32);
    expect(() => new DevKeyProvider({ keks: new Map([[1, k]]), peppers: new Map([[1, Buffer.from(k)]]), currentKek: 1, currentPepper: 1 })).toThrow(/distinct/);
    expect(() => new DevKeyProvider({ keks: new Map([[1, randomBytes(16)]]), peppers: new Map([[1, randomBytes(32)]]), currentKek: 1, currentPepper: 1 })).toThrow(/32 bytes/);
    expect(() => new DevKeyProvider({ keks: new Map([[1, randomBytes(32)]]), peppers: new Map([[1, randomBytes(32)]]), currentKek: 2, currentPepper: 1 })).toThrow(/current/);
  });
  it("KEK wraps and pepper HMACs use unrelated secrets: HMAC output is not derivable from wrap material", async () => {
    const p = DevKeyProvider.generate(1);
    const h = await p.hmac(Buffer.from("same"), 1);
    const w = await p.wrapDek(randomBytes(32), 1, Buffer.from("aad"));
    expect(w.includes(h)).toBe(false);
  });
  it("two independent providers cannot open each other's wraps", async () => {
    const a = DevKeyProvider.generate(1);
    const b = DevKeyProvider.generate(1);
    const wrapped = await a.wrapDek(randomBytes(32), 1, Buffer.from("aad"));
    await expect(b.unwrapDek(wrapped, 1, Buffer.from("aad"))).rejects.toMatchObject({ code: "DECRYPT_FAILED" });
  });
});

describe("NullKeyProvider (KEY_PROVIDER=none) fails closed", () => {
  it("every operation refuses with KEY_PROVIDER_NOT_CONFIGURED", async () => {
    const p = new NullKeyProvider();
    expect(() => p.currentKekVersion()).toThrow(expect.objectContaining({ code: "KEY_PROVIDER_NOT_CONFIGURED" }));
    expect(() => p.hmacVersions()).toThrow(expect.objectContaining({ code: "KEY_PROVIDER_NOT_CONFIGURED" }));
    await expect(p.wrapDek()).rejects.toMatchObject({ code: "KEY_PROVIDER_NOT_CONFIGURED" });
    await expect(p.unwrapDek()).rejects.toMatchObject({ code: "KEY_PROVIDER_NOT_CONFIGURED" });
    await expect(p.hmac()).rejects.toMatchObject({ code: "KEY_PROVIDER_NOT_CONFIGURED" });
  });
});
