import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { digestsEqual, fingerprint, fingerprintsAllVersions, normalizeCode } from "@/platform/crypto";
import { DevKeyProvider } from "@/platform/crypto/testing/dev-key-provider";

describe("normalizeCode", () => {
  it.each([
    ["  ABCD-1234 5678 ", "ABCD-12345678"],
    ["۱۲۳۴-ABCD", "1234-ABCD"],
    ["١٢٣٤٥", "12345"],
    ["ＡＢＣ１２３", "ABC123"], // full-width -> ASCII (NFKC)
    ["AB‌CD‏", "ABCD"], // zero-width / bidi marks removed
  ])("%j -> %j", (raw, expected) => {
    expect(normalizeCode(raw)).toBe(expected);
  });
  it("does NOT fold case or strip dashes by default (some codes are case-sensitive); both are explicit opt-ins", () => {
    expect(normalizeCode("abC-12")).toBe("abC-12");
    expect(normalizeCode("abC-12", { foldCase: true, stripDashes: true })).toBe("ABC12");
  });
  it("rejects empty input", () => {
    expect(() => normalizeCode("  ​ ")).toThrow(/empty/);
  });
});

describe("keyed fingerprints for duplicate detection", () => {
  const code = "STEAM-CANARY-AAAA-BBBB";

  it("are deterministic, 32 bytes, and equal for equivalent spellings of the same code", async () => {
    const p = DevKeyProvider.generate(1);
    const a = await fingerprint(p, "code", normalizeCode(code));
    const b = await fingerprint(p, "code", normalizeCode(` ${code.slice(0, 5)} ${code.slice(5)} `));
    expect(a.digest.length).toBe(32);
    expect(digestsEqual(a.digest, b.digest)).toBe(true);
  });
  it("are KEYED: different from a plain SHA-256 of the code and different under another pepper", async () => {
    const p = DevKeyProvider.generate(1);
    const q = DevKeyProvider.generate(1);
    const fp = await fingerprint(p, "code", code);
    expect(fp.digest.equals(createHash("sha256").update(code).digest())).toBe(false);
    expect(digestsEqual(fp.digest, (await fingerprint(q, "code", code)).digest)).toBe(false);
  });
  it("are separated by purpose (same value, different purpose => different digest) and validate the purpose", async () => {
    const p = DevKeyProvider.generate(1);
    expect(digestsEqual((await fingerprint(p, "code", code)).digest, (await fingerprint(p, "account", code)).digest)).toBe(false);
    await expect(fingerprint(p, "Bad Purpose", code)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
  it("different values give different digests (no trivial collisions over 5,000 values)", async () => {
    const p = DevKeyProvider.generate(1);
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add((await fingerprint(p, "code", `CODE-${i}`)).digest.toString("hex"));
    expect(seen.size).toBe(5000);
  });

  it("pepper rotation: a duplicate stored under pepper v1 is still found via the all-versions lookup, and a re-hash moves it to v2", async () => {
    const v1 = DevKeyProvider.generate(1);
    const stored = await fingerprint(v1, "code", code); // row written under pepper v1
    const v2 = v1.withRotation({ newPepper: true });
    expect(v2.currentHmacVersion()).toBe(2);

    const candidates = await fingerprintsAllVersions(v2, "code", code);
    expect(candidates.map((c) => c.hmacVersion)).toEqual([1, 2]);
    expect(candidates.some((c) => c.hmacVersion === stored.hmacVersion && digestsEqual(c.digest, stored.digest))).toBe(true); // duplicate detected

    const current = await fingerprint(v2, "code", code); // re-hash (needs the plaintext, obtained by decrypting the sealed secret)
    expect(current.hmacVersion).toBe(2);
    expect(digestsEqual(current.digest, stored.digest)).toBe(false);
  });

  it("pepper lost: the old digest can no longer be recomputed (KEY_VERSION_UNKNOWN) but nothing is corrupted — the sealed secret is a separate key", async () => {
    const full = DevKeyProvider.generate(1);
    const lost = full.withRotation({ newPepper: true }).derive({ dropPepper: [1] });
    await expect(fingerprint(lost, "code", code, 1)).rejects.toMatchObject({ code: "KEY_VERSION_UNKNOWN" });
    expect((await fingerprint(lost, "code", code)).hmacVersion).toBe(2); // new fingerprints still work
  });

  it("digestsEqual is length-safe", () => {
    expect(digestsEqual(Buffer.alloc(32), Buffer.alloc(31))).toBe(false);
  });
});
