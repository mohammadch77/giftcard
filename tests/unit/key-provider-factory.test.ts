import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createKeyProvider } from "@/platform/composition";
import { parseEnv } from "@/platform/config/env";

const k = () => randomBytes(32).toString("base64");
const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };

describe("createKeyProvider (guarded factory)", () => {
  it("KEY_PROVIDER=none returns the fail-closed provider", async () => {
    const p = createKeyProvider(parseEnv({ ...base }));
    expect(p.kind).toBe("none");
    await expect(p.hmac(Buffer.alloc(1), 1)).rejects.toMatchObject({ code: "KEY_PROVIDER_NOT_CONFIGURED" });
  });
  it("dev provider works outside production, uses the highest configured version as current", () => {
    const p = createKeyProvider(parseEnv({ ...base, KEY_PROVIDER: "dev", DEV_KEK_V1: k(), DEV_PEPPER_V1: k(), DEV_KEK_V2: k() }));
    expect(p.kind).toBe("dev");
    expect(p.currentKekVersion()).toBe(2);
    expect(p.kekVersions()).toEqual([1, 2]);
    expect(p.currentHmacVersion()).toBe(1);
  });
  it("is REFUSED in production at the factory even if env validation were bypassed", () => {
    const bypass = { NODE_ENV: "production" as const, KEY_PROVIDER: "dev" as const, DEV_KEK_V1: k(), DEV_KEK_V2: undefined, DEV_PEPPER_V1: k(), DEV_PEPPER_V2: undefined };
    expect(() => createKeyProvider(bypass)).toThrow(expect.objectContaining({ code: "KEY_PROVIDER_FORBIDDEN" }));
  });
  it("dev provider without key material is a configuration error", () => {
    expect(() => createKeyProvider({ NODE_ENV: "development", KEY_PROVIDER: "dev", DEV_KEK_V1: undefined, DEV_KEK_V2: undefined, DEV_PEPPER_V1: undefined, DEV_PEPPER_V2: undefined })).toThrow(
      expect.objectContaining({ code: "KEY_PROVIDER_NOT_CONFIGURED" }),
    );
  });
  it("a KEK equal to a pepper is rejected by the provider", () => {
    const same = k();
    expect(() => createKeyProvider({ NODE_ENV: "development", KEY_PROVIDER: "dev", DEV_KEK_V1: same, DEV_KEK_V2: undefined, DEV_PEPPER_V1: same, DEV_PEPPER_V2: undefined })).toThrow(/distinct/);
  });
});

describe("env validation of key settings", () => {
  it("defaults to none; dev needs both v1 keys, all distinct, 32 bytes each", () => {
    expect(parseEnv(base).KEY_PROVIDER).toBe("none");
    expect(() => parseEnv({ ...base, KEY_PROVIDER: "dev" })).toThrow(/DEV_KEK_V1/);
    const same = k();
    expect(() => parseEnv({ ...base, KEY_PROVIDER: "dev", DEV_KEK_V1: same, DEV_PEPPER_V1: same })).toThrow(/distinct/);
    expect(() => parseEnv({ ...base, KEY_PROVIDER: "dev", DEV_KEK_V1: "short", DEV_PEPPER_V1: k() })).toThrow(/DEV_KEK_V1/);
  });
  it("production rejects the dev provider and ANY development key variable; error text never contains the key", () => {
    const prod = { ...base, NODE_ENV: "production", APP_URL: "https://shop.example" };
    const key = k();
    expect(() => parseEnv({ ...prod, KEY_PROVIDER: "dev", DEV_KEK_V1: key, DEV_PEPPER_V1: k() })).toThrow(/forbidden in production/);
    let message = "";
    try { parseEnv({ ...prod, DEV_KEK_V1: key }); } catch (e) { message = String(e); }
    expect(message).toMatch(/DEV_KEK_V1/);
    expect(message).not.toContain(key);
    expect(parseEnv({ ...prod }).KEY_PROVIDER).toBe("none");
  });
});
