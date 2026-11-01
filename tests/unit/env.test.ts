import { describe, expect, it } from "vitest";
import { EnvValidationError, parseEnv } from "@/platform/config/env";

const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };

describe("env validation", () => {
  it("accepts a minimal valid environment and applies safe defaults", () => {
    const env = parseEnv(base);
    expect(env.NODE_ENV).toBe("development");
    expect(env.PAYMENT_GATEWAY).toBe("none");
    expect(env.SMS_PROVIDER).toBe("none");
    expect(env.SUPPLIER_ADAPTERS).toBe("none");
    expect(env.LATE_PAYMENT_HANDLING_WINDOW_SECONDS).toBe(300);
    expect(env.DATABASE_POOL_MAX).toBe(10);
  });

  it("fails when DATABASE_URL is missing", () => {
    expect(() => parseEnv({})).toThrow(EnvValidationError);
  });

  it("rejects non-postgres database URLs", () => {
    expect(() => parseEnv({ DATABASE_URL: "mysql://x" })).toThrow(/DATABASE_URL/);
  });

  it("never echoes secret values in error messages", () => {
    try {
      parseEnv({ DATABASE_URL: "mysql://user:SuperSecret123@host/db" });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain("SuperSecret123");
    }
  });

  it("forbids test doubles for providers in production", () => {
    const prod = { ...base, NODE_ENV: "production", APP_URL: "https://shop.example" };
    expect(() => parseEnv({ ...prod, PAYMENT_GATEWAY: "test" })).toThrow(/PAYMENT_GATEWAY/);
    expect(() => parseEnv({ ...prod, SMS_PROVIDER: "test" })).toThrow(/SMS_PROVIDER/);
    expect(() => parseEnv({ ...prod, SUPPLIER_ADAPTERS: "test" })).toThrow(/SUPPLIER_ADAPTERS/);
    expect(parseEnv(prod).NODE_ENV).toBe("production");
  });

  it("allows test doubles outside production", () => {
    expect(parseEnv({ ...base, NODE_ENV: "test", PAYMENT_GATEWAY: "test" }).PAYMENT_GATEWAY).toBe("test");
  });

  it("requires https APP_URL in production", () => {
    expect(() => parseEnv({ ...base, NODE_ENV: "production", APP_URL: "http://shop.example" })).toThrow(/APP_URL/);
  });

  it("rejects unknown provider values (no arbitrary gateway names)", () => {
    expect(() => parseEnv({ ...base, PAYMENT_GATEWAY: "zarinpal" })).toThrow(/PAYMENT_GATEWAY/);
  });

  it("bounds the late-payment handling window (default 300 s, configurable; never a TTL extension)", () => {
    expect(parseEnv({ ...base, LATE_PAYMENT_HANDLING_WINDOW_SECONDS: "120" }).LATE_PAYMENT_HANDLING_WINDOW_SECONDS).toBe(120);
    expect(() => parseEnv({ ...base, LATE_PAYMENT_HANDLING_WINDOW_SECONDS: "-1" })).toThrow();
    expect(() => parseEnv({ ...base, LATE_PAYMENT_HANDLING_WINDOW_SECONDS: "99999" })).toThrow();
  });
});
