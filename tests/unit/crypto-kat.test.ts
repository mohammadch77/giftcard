import { createCipheriv, createDecipheriv, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeSealed, openSecret } from "@/platform/crypto";
import type { KeyProvider } from "@/platform/crypto";
import { DevKeyProvider } from "@/platform/crypto/testing/dev-key-provider";

/**
 * SEC-KAT — independent known-answer tests for the production crypto primitives.
 * PROVENANCE of every vector (none was produced by the code under test):
 *  - AES-256-GCM: test cases 13–16 of "The Galois/Counter Mode of Operation (GCM)" (McGrew & Viega, the
 *    vectors adopted by NIST SP 800-38D validation); also reproduced with Python `cryptography` 50.0.1.
 *  - HMAC-SHA-256: RFC 4231 test case 2; the 32-byte-key vector was computed with a from-scratch
 *    pure-Python HMAC (hashlib.sha256 only, no OpenSSL HMAC) and cross-checked against Python's hmac.
 *  - Envelope / KEK-wrap blobs: built in Python from the DOCUMENTED layouts (length-prefixed AAD; "kek:<v>:"+aad),
 *    not by the TypeScript code.
 * These tests must pass before ANY production KeyProvider is connected (OPEN_QUESTIONS SEC-KAT).
 */
const hex = (s: string) => Buffer.from(s, "hex");

describe("AES-256-GCM known answers (Node/OpenSSL against published vectors)", () => {
  const zeroKey = Buffer.alloc(32);
  const gcm = (key: Buffer, iv: Buffer, pt: Buffer, aad?: Buffer) => {
    const c = createCipheriv("aes-256-gcm", key, iv);
    if (aad) c.setAAD(aad);
    const ct = Buffer.concat([c.update(pt), c.final()]);
    return { ct, tag: c.getAuthTag() };
  };
  const K = hex("feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308");
  const IV = hex("cafebabefacedbaddecaf888");
  const P = hex("d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b391aafd255");
  const C = "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662898015ad";

  it("test case 13: empty plaintext -> tag only", () => {
    expect(gcm(zeroKey, Buffer.alloc(12), Buffer.alloc(0)).tag.toString("hex")).toBe("530f8afbc74536b9a963b4f1c4cb738b");
  });
  it("test case 14: one zero block", () => {
    const r = gcm(zeroKey, Buffer.alloc(12), Buffer.alloc(16));
    expect(r.ct.toString("hex")).toBe("cea7403d4d606b6e074ec5d3baf39d18");
    expect(r.tag.toString("hex")).toBe("d0d1c8a799996bf0265b98b5d48ab919");
  });
  it("test case 15: 64-byte plaintext, no AAD", () => {
    const r = gcm(K, IV, P);
    expect(r.ct.toString("hex")).toBe(C);
    expect(r.tag.toString("hex")).toBe("b094dac5d93471bdec1a502270e3cc6c");
  });
  it("test case 16: 60-byte plaintext with AAD; decrypts back; a wrong AAD or a flipped tag bit is rejected", () => {
    const aad = hex("feedfacedeadbeeffeedfacedeadbeefabaddad2");
    const r = gcm(K, IV, P.subarray(0, 60), aad);
    expect(r.tag.toString("hex")).toBe("76fc6ece0f4e1768cddf8853bb2d551b");
    const dec = (tag: Buffer, a: Buffer) => {
      const d = createDecipheriv("aes-256-gcm", K, IV);
      d.setAAD(a);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(r.ct), d.final()]);
    };
    expect(dec(r.tag, aad).equals(P.subarray(0, 60))).toBe(true);
    expect(() => dec(r.tag, Buffer.concat([aad, Buffer.from([0])]))).toThrow();
    const bad = Buffer.from(r.tag);
    bad[0]! ^= 1;
    expect(() => dec(bad, aad)).toThrow();
  });
});

describe("HMAC-SHA-256 known answers", () => {
  it("RFC 4231 test case 2", () => {
    expect(createHmac("sha256", "Jefe").update("what do ya want for nothing?").digest("hex")).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });
  it("the KeyProvider pepper path (DevKeyProvider.hmac) matches an independently computed 32-byte-key vector", async () => {
    const pepper = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    const p = new DevKeyProvider({ keks: new Map([[1, Buffer.alloc(32, 9)]]), peppers: new Map([[1, pepper]]), currentKek: 1, currentPepper: 1 });
    expect((await p.hmac(Buffer.from("abc"), 1)).toString("hex")).toBe("f0133729c4163dede81e21cd47839256da58171238c8a0d874397c73b14e1e47");
    // A different pepper VERSION must not reproduce it (key separation by version).
    const p2 = new DevKeyProvider({ keks: new Map([[1, Buffer.alloc(32, 9)]]), peppers: new Map([[1, pepper], [2, Buffer.alloc(32, 7)]]), currentKek: 1, currentPepper: 2 });
    expect((await p2.hmac(Buffer.from("abc"), 2)).toString("hex")).not.toBe("f0133729c4163dede81e21cd47839256da58171238c8a0d874397c73b14e1e47");
  });
});

describe("KEK wrap and envelope: externally built blobs open; every kind of tampering fails", () => {
  const kek = Buffer.from(Array.from({ length: 32 }, (_, i) => 32 + i));
  const dek = Buffer.from(Array.from({ length: 32 }, (_, i) => 100 + i));
  const provider = new DevKeyProvider({ keks: new Map([[1, kek], [2, Buffer.alloc(32, 5)]]), peppers: new Map([[1, Buffer.alloc(32, 6)]]), currentKek: 1, currentPepper: 1 });

  it("unwraps a DEK wrapped independently ('kek:<version>:' + aad, AES-256-GCM, iv|ct|tag)", async () => {
    const wrapped = hex(KAT_WRAP);
    expect((await provider.unwrapDek(wrapped, 1, Buffer.from("test-aad"))).equals(dek)).toBe(true);
    await expect(provider.unwrapDek(wrapped, 1, Buffer.from("other-aad"))).rejects.toMatchObject({ code: "DECRYPT_FAILED" }); // AAD check
    await expect(provider.unwrapDek(wrapped, 2, Buffer.from("test-aad"))).rejects.toMatchObject({ code: "DECRYPT_FAILED" }); // key version binding
    await expect(provider.unwrapDek(wrapped, 9, Buffer.from("test-aad"))).rejects.toMatchObject({ code: "KEY_VERSION_UNKNOWN" });
    for (const pos of [0, 12, 30, wrapped.length - 1]) {
      const t = Buffer.from(wrapped);
      t[pos]! ^= 0x80;
      await expect(provider.unwrapDek(t, 1, Buffer.from("test-aad"))).rejects.toMatchObject({ code: "DECRYPT_FAILED" }); // auth-tag failures
    }
  });

  it("openSecret decrypts an envelope built independently from the documented AAD layout, and rejects any change", async () => {
    // Stub provider: returns the known DEK (isolates the AES-GCM + AAD layer of the envelope).
    const stub: KeyProvider = { ...provider, unwrapDek: async () => Buffer.from(dek) } as unknown as KeyProvider;
    const sealed = decodeSealed(Buffer.concat([Buffer.from([1, 0, 0, 0, 1, 0, 4]), Buffer.from("wrap"), hex(KAT_ENVELOPE)]));
    const ctx = { table: "admin_totp", rowId: "row-1", kind: "totp_secret" };
    expect((await openSecret(stub, sealed, ctx)).toString()).toBe("kat-secret-value");
    await expect(openSecret(stub, sealed, { ...ctx, rowId: "row-2" })).rejects.toMatchObject({ code: "DECRYPT_FAILED" });
    await expect(openSecret(stub, sealed, { ...ctx, kind: "other" })).rejects.toMatchObject({ code: "DECRYPT_FAILED" });
    const flipped = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext) };
    flipped.ciphertext[flipped.ciphertext.length - 1]! ^= 1;
    await expect(openSecret(stub, flipped, ctx)).rejects.toMatchObject({ code: "DECRYPT_FAILED" });
  });
});

const KAT_ENVELOPE = "000102030405060708090a0bf4ca4c61ce28a29bf867b3bef7f6fdd787e6540b946438e9aee720f53f753700";
const KAT_WRAP = "000102030405060708090a0b38373bc0225c8187d094a7a956022c4f67059f131268dc6a5870adc53b00491b9ecf4ba8e1cd048973e4a7602f80df73";
