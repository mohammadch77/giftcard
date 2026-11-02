import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeSealed, encodeSealed, openSecret, rewrapSecret, sealSecret, secretAad, withSecret } from "@/platform/crypto";
import type { SealedSecret, SecretContext } from "@/platform/crypto";
import { DevKeyProvider } from "@/platform/crypto/testing/dev-key-provider";
import { FlakyKeyProvider } from "@/platform/crypto/testing/flaky-key-provider";

const ctx: SecretContext = { table: "digital_codes", rowId: "row-1", kind: "code" };
const CANARY = "STEAM-CANARY-AAAA-BBBB-CCCC-1234";

const errOf = async (p: Promise<unknown>): Promise<Error & { code?: string; cause?: unknown }> => {
  try {
    await p;
  } catch (e) {
    return e as Error & { code?: string; cause?: unknown };
  }
  throw new Error("expected the promise to reject");
};

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? "OTHER";
  }
  return "NO_ERROR";
};

describe("envelope encryption (AES-256-GCM)", () => {
  it("round-trips text, unicode, binary, empty and 1 MiB payloads", async () => {
    const p = DevKeyProvider.generate(1);
    for (const data of [CANARY, "کد هدیه ۱۲۳۴ ☃", randomBytes(1000), Buffer.alloc(0), randomBytes(1024 * 1024)]) {
      const sealed = await sealSecret(p, data, ctx);
      const plain = await openSecret(p, sealed, ctx);
      expect(plain.equals(typeof data === "string" ? Buffer.from(data, "utf8") : data)).toBe(true);
    }
  });

  it("the stored form contains no plaintext and a fresh nonce+DEK every time (10,000 seals)", async () => {
    const p = DevKeyProvider.generate(1);
    const nonces = new Set<string>();
    const wraps = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const s = await sealSecret(p, CANARY, { ...ctx, rowId: `r-${i % 3}` });
      expect(s.ciphertext.includes(Buffer.from(CANARY))).toBe(false);
      expect(encodeSealed(s).includes(Buffer.from("CANARY"))).toBe(false);
      nonces.add(s.ciphertext.subarray(0, 12).toString("hex"));
      wraps.add(s.wrappedDek.toString("hex"));
    }
    expect(nonces.size).toBe(10_000);
    expect(wraps.size).toBe(10_000);
  });

  it("detects tampering in every part (ciphertext, tag, nonce, wrapped DEK, KEK version)", async () => {
    const p = DevKeyProvider.generate(2);
    const sealed = await sealSecret(p, CANARY, ctx);
    const flip = (b: Buffer, i: number) => { const c = Buffer.from(b); c[i] = (c[i] ?? 0) ^ 1; return c; };
    const variants: SealedSecret[] = [
      { ...sealed, ciphertext: flip(sealed.ciphertext, 0) }, // nonce
      { ...sealed, ciphertext: flip(sealed.ciphertext, 15) }, // body
      { ...sealed, ciphertext: flip(sealed.ciphertext, sealed.ciphertext.length - 1) }, // tag
      { ...sealed, wrappedDek: flip(sealed.wrappedDek, 20) },
      { ...sealed, kekVersion: 1 }, // wrong (but existing) version
    ];
    for (const v of variants) expect(await codeOf(openSecret(p, v, ctx))).toMatch(/^(DECRYPT_FAILED)$/);
    expect((await openSecret(p, sealed, ctx)).toString()).toBe(CANARY); // original still fine
  });

  it("binds the secret to its context: moving it to another row, table or kind fails (swap attack)", async () => {
    const p = DevKeyProvider.generate(1);
    const sealed = await sealSecret(p, CANARY, ctx);
    for (const other of [{ ...ctx, rowId: "row-2" }, { ...ctx, table: "supplier_credentials" }, { ...ctx, kind: "account_credential" }]) {
      expect(await codeOf(openSecret(p, sealed, other))).toBe("DECRYPT_FAILED");
    }
  });

  it("AAD is unambiguous (length-prefixed): shifting characters between fields yields a different AAD", () => {
    const a = secretAad({ table: "ab", rowId: "c", kind: "k" }, "data");
    const b = secretAad({ table: "a", rowId: "bc", kind: "k" }, "data");
    expect(a.equals(b)).toBe(false);
    expect(secretAad(ctx, "data").equals(secretAad(ctx, "dek"))).toBe(false);
  });

  it("rejects invalid contexts and unsupported formats", async () => {
    const p = DevKeyProvider.generate(1);
    await expect(sealSecret(p, "x", { table: "bad table", rowId: "1", kind: "k" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const sealed = await sealSecret(p, "x", ctx);
    await expect(openSecret(p, { ...sealed, format: 2 as never }, ctx)).rejects.toMatchObject({ code: "SEALED_FORMAT_INVALID" });
    await expect(openSecret(p, { ...sealed, ciphertext: Buffer.alloc(5) }, ctx)).rejects.toMatchObject({ code: "SEALED_FORMAT_INVALID" });
  });

  it("encode/decode round-trips and malformed input is rejected", async () => {
    const p = DevKeyProvider.generate(1);
    const sealed = await sealSecret(p, CANARY, ctx);
    const back = decodeSealed(encodeSealed(sealed));
    expect(back.kekVersion).toBe(sealed.kekVersion);
    expect((await openSecret(p, back, ctx)).toString()).toBe(CANARY);
    expect(() => decodeSealed(Buffer.alloc(3))).toThrow();
    const bad = encodeSealed(sealed);
    bad[0] = 9;
    expect(() => decodeSealed(bad)).toThrow();
    const lying = encodeSealed(sealed);
    lying.writeUInt16BE(60000, 5);
    expect(() => decodeSealed(lying)).toThrow();
  });

  it("zeroes the DEK it generated after sealing, and withSecret zeroes the plaintext after use", async () => {
    const flaky = new FlakyKeyProvider(DevKeyProvider.generate(1));
    const sealed = await sealSecret(flaky, CANARY, ctx);
    expect(flaky.wrapInputs.length).toBe(1);
    expect(flaky.wrapInputs[0]?.every((b) => b === 0)).toBe(true);
    let leaked: Buffer | undefined;
    await withSecret(flaky, sealed, ctx, (plain) => { leaked = plain; expect(plain.toString()).toBe(CANARY); });
    expect(leaked?.every((b) => b === 0)).toBe(true);
    // zeroed even if the callback throws
    let leaked2: Buffer | undefined;
    await expect(withSecret(flaky, sealed, ctx, (plain) => { leaked2 = plain; throw new Error("callback failed"); })).rejects.toThrow("callback failed");
    expect(leaked2?.every((b) => b === 0)).toBe(true);
  });
});

describe("KEK rotation (re-wrap) keeps every secret readable", () => {
  it("old secrets stay readable after rotation; new secrets use the new KEK; re-wrap leaves the payload bytes untouched", async () => {
    const v1 = DevKeyProvider.generate(1);
    const old = await sealSecret(v1, CANARY, ctx);
    expect(old.kekVersion).toBe(1);
    const v2 = v1.withRotation({ newKek: true });
    expect((await openSecret(v2, old, ctx)).toString()).toBe(CANARY); // old data still opens
    const fresh = await sealSecret(v2, "new-secret", { ...ctx, rowId: "row-2" });
    expect(fresh.kekVersion).toBe(2);

    const rewrapped = await rewrapSecret(v2, old, ctx);
    expect(rewrapped.kekVersion).toBe(2);
    expect(rewrapped.ciphertext.equals(old.ciphertext)).toBe(true); // payload NOT re-encrypted, nothing deleted
    expect(rewrapped.wrappedDek.equals(old.wrappedDek)).toBe(false);
    expect((await openSecret(v2, rewrapped, ctx)).toString()).toBe(CANARY);
    expect((await rewrapSecret(v2, rewrapped, ctx))).toBe(rewrapped); // idempotent
  });

  it("an interrupted re-wrap run leaves ALL secrets decryptable; the old KEK may only be retired after the run completes", async () => {
    const v1 = DevKeyProvider.generate(1);
    const rows = await Promise.all(Array.from({ length: 200 }, async (_, i) => {
      const c = { ...ctx, rowId: `row-${i}` };
      return { c, sealed: await sealSecret(v1, `secret-${i}`, c) };
    }));
    const v2 = v1.withRotation({ newKek: true });
    for (const r of rows.slice(0, 100)) r.sealed = await rewrapSecret(v2, r.sealed, r.c); // ...crash after 100
    for (const r of rows) expect((await openSecret(v2, r.sealed, r.c)).toString()).toMatch(/^secret-/);

    // Retiring v1 now would strand the remaining 100 rows — this is why retirement needs a check:
    const v2Only = v2.derive({ dropKek: [1] });
    let stranded = 0;
    for (const r of rows) if ((await codeOf(openSecret(v2Only, r.sealed, r.c))) === "KEY_VERSION_UNKNOWN") stranded += 1;
    expect(stranded).toBe(100);

    for (const r of rows) r.sealed = await rewrapSecret(v2, r.sealed, r.c); // resume and finish
    for (const r of rows) expect((await openSecret(v2Only, r.sealed, r.c)).toString()).toMatch(/^secret-/); // now safe to retire v1
    expect(rows.every((r) => r.sealed.kekVersion === 2)).toBe(true);
  });
});

describe("failure behaviour: lost, replaced and unavailable KEK (fail closed, data never destroyed)", () => {
  it("KEK unavailable: seal and open fail with KEY_UNAVAILABLE, produce nothing, and work again when the provider returns", async () => {
    const flaky = new FlakyKeyProvider(DevKeyProvider.generate(1));
    const sealed = await sealSecret(flaky, CANARY, ctx);
    flaky.available = false;
    expect(await codeOf(sealSecret(flaky, CANARY, ctx))).toBe("KEY_UNAVAILABLE");
    expect(await codeOf(openSecret(flaky, sealed, ctx))).toBe("KEY_UNAVAILABLE");
    expect(await codeOf(rewrapSecret(flaky, sealed, ctx))).toBe("KEY_UNAVAILABLE");
    flaky.available = true; // provider is back
    expect((await openSecret(flaky, sealed, ctx)).toString()).toBe(CANARY);
    expect((await sealSecret(flaky, CANARY, ctx)).kekVersion).toBe(1);
  });

  it("KEK lost (version missing): KEY_VERSION_UNKNOWN, ciphertext stays intact, restoring the key restores access", async () => {
    const full = DevKeyProvider.generate(1);
    const sealed = await sealSecret(full, CANARY, ctx);
    const before = encodeSealed(sealed).toString("hex");
    const lost = new DevKeyProvider({ keks: new Map([[2, randomBytes(32)]]), peppers: new Map([[1, randomBytes(32)]]), currentKek: 2, currentPepper: 1 });
    expect(await codeOf(openSecret(lost, sealed, ctx))).toBe("KEY_VERSION_UNKNOWN");
    expect(encodeSealed(sealed).toString("hex")).toBe(before); // nothing was modified or deleted
    expect((await openSecret(full, sealed, ctx)).toString()).toBe(CANARY); // KEK restored from backup => recovered
  });

  it("KEK replaced by a different key under the same version: DECRYPT_FAILED, never garbage plaintext", async () => {
    const p = DevKeyProvider.generate(1);
    const sealed = await sealSecret(p, CANARY, ctx);
    const replaced = p.withReplacedKek(1);
    expect(await codeOf(openSecret(replaced, sealed, ctx))).toBe("DECRYPT_FAILED");
  });

  it("no key provider configured: sealing and opening are refused", async () => {
    const { NullKeyProvider } = await import("@/platform/crypto");
    expect(await codeOf(sealSecret(new NullKeyProvider(), CANARY, ctx))).toBe("KEY_PROVIDER_NOT_CONFIGURED");
  });

  it("an unexpected provider failure is reported as KEY_UNAVAILABLE WITHOUT leaking its message or cause", async () => {
    const flaky = new FlakyKeyProvider(DevKeyProvider.generate(1));
    flaky.failWith = new Error("backend exploded; kek=AAAA-SECRET-KEY-MATERIAL");
    const err = await errOf(sealSecret(flaky, CANARY, ctx));
    expect(err.code).toBe("KEY_UNAVAILABLE");
    expect(JSON.stringify([err.message, String(err.cause ?? ""), err.stack ?? ""])).not.toContain("SECRET-KEY-MATERIAL");
  });

  it("errors never contain the plaintext", async () => {
    const p = DevKeyProvider.generate(1);
    const sealed = await sealSecret(p, CANARY, ctx);
    const err = await errOf(openSecret(p, sealed, { ...ctx, rowId: "other" }));
    expect(`${err.message}${err.stack}`).not.toContain("CANARY");
  });
});
