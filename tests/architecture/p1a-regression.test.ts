import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ORDER_PERMISSIONS, RESERVATION_TTL_BOUNDS } from "@/modules/orders";
import { TOPUP_DAILY_TIMEZONE, TOPUP_LIMIT_BOUNDS, WALLET_PERMISSIONS } from "@/modules/wallet";
import { parseEnv } from "@/platform/config/env";
import { parseSetting, requireReason } from "@/platform/settings";
import { z } from "zod";

const repo = process.cwd();
const read = (p: string) => readFileSync(path.join(repo, p), "utf8");

describe("P1-A: settings architecture (ADM-1)", () => {
  it("there is NO generic key/value settings table: every table in every migration lacks a (key, value) column pair and a generic settings name", () => {
    const dir = path.join(repo, "db/migrations");
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
      const sql = readFileSync(path.join(dir, f), "utf8");
      for (const m of sql.matchAll(/CREATE TABLE "([a-z_]+)" \(([\s\S]*?)\n\);/g)) {
        const [, name, body] = m as unknown as [string, string, string];
        const cols = new Set([...body.matchAll(/^\t"([a-z_]+)"/gm)].map((c) => c[1]));
        if (name === "db_meta") continue; // platform bookkeeping (schema/chart versions) created in the 2a baseline, not a business-settings store
        if ((cols.has("key") && cols.has("value")) || /^(settings|app_settings|config|configuration|system_settings)$/.test(name)) offenders.push(`${f}:${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("settings live in module-owned version tables, each owned by exactly the module that uses them", () => {
    expect(read("src/modules/orders/infra/schema.ts")).toContain('"order_settings_versions"');
    expect(read("src/modules/wallet/infra/schema.ts")).toContain('"wallet_limit_versions"');
    for (const other of ["catalog", "inventory", "ledger", "payments", "fulfillment", "suppliers", "identity", "audit"]) {
      expect(read(`src/modules/${other}/infra/schema.ts`)).not.toMatch(/order_settings_versions|wallet_limit_versions/);
    }
    // orders never reads the wallet's settings table and vice versa: other modules go through the owner's public API only
    expect(read("src/modules/orders/application/checkout.ts")).not.toMatch(/wallet_limit_versions/);
    expect(read("src/modules/wallet/application/wallet.ts")).not.toMatch(/order_settings_versions/);
  });

  it("B3 and B5 are no longer environment variables (a second, unaudited source of truth would be a hole)", () => {
    const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };
    const env = parseEnv({ ...base, ORDER_RESERVATION_TTL_SECONDS: "900", WALLET_TOPUP_MIN_RIAL: "1", WALLET_TOPUP_MAX_RIAL: "2" }) as Record<string, unknown>;
    expect(env).not.toHaveProperty("ORDER_RESERVATION_TTL_SECONDS");
    expect(env).not.toHaveProperty("WALLET_TOPUP_MIN_RIAL");
    expect(env).not.toHaveProperty("WALLET_TOPUP_MAX_RIAL");
    expect(read("src/platform/config/env.ts")).not.toMatch(/ORDER_RESERVATION_TTL_SECONDS|WALLET_TOPUP_(MIN|MAX)_RIAL/);
    expect(read("src/modules/orders/application/core.ts")).not.toMatch(/reservationTtlSeconds/);
  });

  it("permissions: changes are sensitive (step-up), reads are not; wallet limits need request AND approve (two-person)", () => {
    const by = (list: readonly { key: string; sensitive: boolean }[], k: string) => list.find((p) => p.key === k);
    expect(by(ORDER_PERMISSIONS, "orders.settings.manage")?.sensitive).toBe(true);
    expect(by(ORDER_PERMISSIONS, "orders.settings.read")?.sensitive).toBe(false);
    expect(by(WALLET_PERMISSIONS, "wallet.settings.request")?.sensitive).toBe(true);
    expect(by(WALLET_PERMISSIONS, "wallet.settings.approve")?.sensitive).toBe(true);
    expect(by(WALLET_PERMISSIONS, "wallet.settings.read")?.sensitive).toBe(false);
    // the seed migration grants exactly these five to `owner`, and nothing to any other role
    const seed = read("db/migrations/0025_p1a_settings_guards.sql");
    expect([...seed.matchAll(/\('((?:orders|wallet)\.settings\.[a-z]+)'\)/g)].map((m) => m[1]).sort()).toEqual(["orders.settings.manage", "orders.settings.read", "wallet.settings.approve", "wallet.settings.read", "wallet.settings.request"]);
    expect(seed.match(/WHERE r\.name = '([a-z_]+)'/g)).toEqual(["WHERE r.name = 'owner'"]);
  });

  it("platform/settings parses typed input and requires a real reason", () => {
    const schema = z.strictObject({ n: z.number().int().min(1).max(5) });
    expect(parseSetting(schema, { n: 3 })).toEqual({ n: 3 });
    for (const bad of [{ n: 0 }, { n: 1.5 }, { n: "3" }, { n: 3, extra: 1 }, null, undefined]) expect(() => parseSetting(schema, bad)).toThrowError(/invalid setting/);
    expect(requireReason("  a proper reason  ")).toBe("a proper reason");
    for (const bad of ["", "short", "x".repeat(501), 5, undefined, null]) expect(() => requireReason(bad)).toThrowError(/reason/);
  });

  it("the approved technical bounds and the Tehran daily window are pinned", () => {
    expect(RESERVATION_TTL_BOUNDS).toEqual({ min: 60, max: 3600 });
    expect(TOPUP_DAILY_TIMEZONE).toBe("Asia/Tehran");
    expect(TOPUP_LIMIT_BOUNDS).toEqual({ minFloorRial: 10, maxCeilingRial: 1_000_000_000_000, dailyCeilingRial: 10_000_000_000_000 });
  });

  it("the approved initial values are written as DATA by migration 0025 (B3 900 s; B5 1,000,000 / 100,000,000 / 300,000,000 IRR)", () => {
    const seed = read("db/migrations/0025_p1a_settings_guards.sql");
    expect(seed).toMatch(/VALUES \(gen_random_uuid\(\), 1, 900, 'SEED'/);
    expect(seed).toMatch(/VALUES \(gen_random_uuid\(\), 1000000, 100000000, 300000000, 'SEED', 'APPROVED'/);
  });

  it("no floating-point money: the wallet settings and top-up code do not use parseFloat/toFixed/Math.round on amounts", () => {
    for (const f of ["src/modules/wallet/application/settings.ts", "src/modules/wallet/application/wallet.ts"]) expect(read(f)).not.toMatch(/parseFloat|toFixed\(|Math\.round|Math\.floor|\* 0\.\d/);
  });

  it("the refund evaluation reads the order's recorded policy version (never silently the active one)", () => {
    const refunds = read("src/modules/orders/application/refunds.ts");
    expect(refunds).toContain("loadPolicy(tx, o.refund_policy_version)");
    expect(refunds).not.toMatch(/await loadPolicy\(tx\)/);
  });
});
