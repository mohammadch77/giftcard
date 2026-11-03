import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG_PERMISSIONS, FULFILLMENT_COMPATIBILITY, REQUIRED_USAGE_SOURCES, looksLikeCredentialKey } from "@/modules/catalog";
import { attrsSchema, fulfillmentChangeInput, gameAccountAttributesInput, variantUpdate } from "@/modules/catalog/domain/rules";
import { importInput } from "@/modules/inventory/domain/rules";

const repo = process.cwd();
const read = (p: string) => readFileSync(path.join(repo, p), "utf8");

describe("P1-B C-2: the protected fulfilment-method change", () => {
  it("the permission is sensitive (step-up), seeded to `owner` only, and the other catalog permissions are unchanged", () => {
    const p = CATALOG_PERMISSIONS.find((x) => x.key === "catalog.fulfillment.change");
    expect(p?.sensitive).toBe(true);
    expect(CATALOG_PERMISSIONS.map((x) => x.key).sort()).toEqual(["catalog.fulfillment.change", "catalog.prices.manage", "catalog.products.manage", "catalog.products.publish", "catalog.products.read"]);
    const seed = read("db/migrations/0027_p1b_catalog_inventory_guards.sql");
    expect([...seed.matchAll(/\('(catalog\.[a-z.]+)'\)/g)].map((m) => m[1])).toEqual(["catalog.fulfillment.change"]);
    expect(seed.match(/WHERE r\.name = '([a-z_]+)'/g)).toEqual(["WHERE r.name = 'owner'"]);
  });

  it("the ordinary variant update has no fulfilment-method field; the protected input demands a reason and nothing else", () => {
    expect(Object.keys(variantUpdate.shape)).not.toContain("fulfillmentMethod");
    expect(variantUpdate.safeParse({ fulfillmentMethod: "MANUAL" }).success).toBe(false);
    expect(fulfillmentChangeInput.safeParse({ to: "MANUAL", reason: "a proper reason" }).success).toBe(true);
    for (const bad of [{ to: "MANUAL" }, { to: "MANUAL", reason: "short" }, { to: "TELEPORT", reason: "a proper reason" }, { to: "MANUAL", reason: "a proper reason", force: true }]) expect(fulfillmentChangeInput.safeParse(bad).success).toBe(false);
    // the only SQL in the catalog module that assigns fulfillment_method is the protected change
    const admin = read("src/modules/catalog/application/admin.ts");
    expect([...admin.matchAll(/fulfillment_method = /g)]).toHaveLength(1);
    expect(admin).toMatch(/insert into variant_fulfillment_changes[\s\S]*update product_variants set fulfillment_method/);
  });

  it("every module that holds variant-bound facts reports through a probe, and the protected change refuses unless ALL report", () => {
    expect([...REQUIRED_USAGE_SOURCES]).toEqual(["inventory", "fulfillment", "suppliers", "orders"]);
    for (const [mod, probe, source] of [["inventory", "inventoryVariantUsage", "inventory"], ["fulfillment", "fulfillmentVariantUsage", "fulfillment"], ["suppliers", "supplierVariantUsage", "suppliers"], ["orders", "orderVariantUsage", "orders"]] as const) {
      expect(read(`src/modules/${mod}/index.ts`)).toContain(probe);
      const impl = read(mod === "inventory" ? "src/modules/inventory/application/admin.ts" : `src/modules/${mod}/application/usage.ts`);
      expect(impl).toContain(`source: "${source}"`);
      expect(impl.slice(impl.indexOf(`export const ${probe}`))).not.toMatch(/\b(insert\s+into|delete\s+from|update\s+[a-z_]+\s+set)\b/i); // probes only read
    }
    expect(read("src/modules/catalog/application/admin.ts")).toContain("CATALOG_USAGE_UNKNOWN");
  });

  it("the approved matrix is pinned in code and the 0027 migration deletes exactly the disallowed rows", () => {
    expect(FULFILLMENT_COMPATIBILITY).toEqual({
      GIFT_CARD: ["AUTO_CODE"], GAME_ACCOUNT: ["MANUAL"], GAME_SUBSCRIPTION: ["MANUAL", "SUPPLIER_API"], STREAMING_SUBSCRIPTION: ["MANUAL", "SUPPLIER_API"],
      DIGITAL_SERVICE: ["MANUAL", "SUPPLIER_API"], OTHER: ["AUTO_CODE", "MANUAL", "SUPPLIER_API"],
    });
    const sql = read("db/migrations/0027_p1b_catalog_inventory_guards.sql");
    const del = sql.match(/DELETE FROM product_type_fulfillment WHERE \(product_type, method\) IN \(([\s\S]*?)\n\);/)![1]!;
    expect([...del.matchAll(/\('([A-Z_]+)', '([A-Z_]+)'\)/g)].map((m) => `${m[1]}/${m[2]}`).sort()).toEqual(
      ["GAME_ACCOUNT/AUTO_CODE", "GAME_SUBSCRIPTION/AUTO_CODE", "GIFT_CARD/MANUAL", "GIFT_CARD/SUPPLIER_API", "STREAMING_SUBSCRIPTION/AUTO_CODE"],
    );
    expect(sql).not.toMatch(/UPDATE\s+product_variants|DELETE\s+FROM\s+product_variants/i); // no historical variant is ever rewritten by the migration
    expect(sql).not.toMatch(/UPDATE\s+(orders|order_items|digital_codes)\b|DELETE\s+FROM\s+(orders|order_items|digital_codes)\b/i);
  });
});

describe("P1-B B1/B2: games, platforms and typed game-account attributes", () => {
  it("credential-like names are recognised by whole word, not by accident", () => {
    for (const bad of ["password", "account_password", "login", "login_email", "email", "api_key", "apikey", "secret", "client_secret", "token", "access_token", "pin", "otp", "cvv", "recovery_code", "auth_code", "cookie", "session_id", "username", "passcode", "private_key"]) expect(looksLikeCredentialKey(bad), bad).toBe(true);
    for (const ok of ["edition", "year", "shipping_note", "keyboard_layout", "spinner", "region_note", "level", "platform", "genre", "mailbox_size_gb"]) expect(looksLikeCredentialKey(ok), ok).toBe(false);
    expect(attrsSchema.safeParse({ edition: "deluxe" }).success).toBe(true);
    expect(attrsSchema.safeParse({ account_password: "x" }).success).toBe(false);
  });

  it("the typed account attributes have no free-form or secret field", () => {
    expect(Object.keys(gameAccountAttributesInput.shape).sort()).toEqual(["accountType", "features", "includedItems", "level"]);
    expect(gameAccountAttributesInput.safeParse({ accountType: "FULL_ACCESS", password: "x" }).success).toBe(false);
    const schema = read("src/modules/catalog/infra/schema.ts");
    const table = schema.slice(schema.indexOf('"game_account_attributes"'), schema.indexOf('"variant_fulfillment_changes"'));
    const code = table.split("\n").filter((l) => !/^\s*(\/\*\*|\*|\/\/)/.test(l)).join("\n"); // columns and checks only, not the comments that explain them
    expect(code).not.toMatch(/pass|secret|token|credential|login|sealed|otp/i);
  });

  it("catalog still imports no module except audit (module matrix unchanged) and game data is owned by the catalog schema only", () => {
    const deps = createRequire(import.meta.url)("../../architecture/module-deps.cjs") as Record<string, string[]>;
    expect(deps.catalog).toEqual(["audit"]);
    for (const other of ["inventory", "suppliers", "fulfillment", "orders", "wallet", "payments", "ledger", "identity", "audit"]) {
      expect(read(`src/modules/${other}/infra/schema.ts`)).not.toMatch(/pgTable\(\s*"(games|platforms|game_platforms|game_platform_regions|game_account_attributes|variant_fulfillment_changes)"/);
    }
  });
});

describe("P1-B OPS-2: digital-code expiry", () => {
  it("the sweeper can only select AVAILABLE/QUARANTINED rows with an expiry, never deletes, and takes rows with SKIP LOCKED", () => {
    const admin = read("src/modules/inventory/application/admin.ts");
    const fn = admin.slice(admin.indexOf("export async function expireDueCodes"), admin.indexOf("export async function runCodeExpiry"));
    expect(fn).toContain("status in ('AVAILABLE','QUARANTINED')");
    expect(fn).toContain("expires_at is not null and expires_at <=");
    expect(fn).toContain("for update skip locked");
    expect(fn).not.toMatch(/\bdelete\b/i);
    expect(fn).toContain("CODE_EXPIRE");
    expect(fn).toContain("recordAudit");
    for (const f of ["src/modules/inventory/application/admin.ts", "src/modules/inventory/application/reservations.ts"]) expect(read(f)).not.toMatch(/delete\s+from\s+digital_codes/i);
  });

  it("allocation excludes codes that would expire before the reservation ends, and availability follows the injected clock", () => {
    const r = read("src/modules/inventory/application/reservations.ts");
    expect(r).toMatch(/status = 'AVAILABLE' and \(expires_at is null or expires_at > \$\{iso\(until\)\}::timestamptz\)/);
    expect(r).toMatch(/c\.expires_at is null or c\.expires_at > \$\{at\}/);
  });

  it("import accepts an OPTIONAL batch expiry and per-code expiry as dates only", () => {
    const base = { payloadKind: "CODE" as const };
    expect(importInput.safeParse({ ...base, codes: ["A"] }).success).toBe(true);
    expect(importInput.safeParse({ ...base, codes: ["A", { code: "B", expiresAt: new Date() }, { code: "C", expiresAt: null }], expiresAt: new Date() }).success).toBe(true);
    for (const bad of [{ expiresAt: "2030-01-01" }, { expiresAt: 5 }, { codes: [{ code: "B", expiresAt: "x" }] }, { codes: [{ code: "B", note: "x" }] }]) expect(importInput.safeParse({ ...base, codes: ["A"], ...bad }).success).toBe(false);
  });

  it("the 0027 guard states the invariants: no expired import, reserve only across the hold, sell only if valid at consumption, expire only after expiry", () => {
    const sql = read("db/migrations/0027_p1b_catalog_inventory_guards.sql");
    for (const m of ["a code cannot be imported already expired", "a code that expires before the reservation ends cannot be reserved", "a code that had expired when its reservation was consumed cannot be sold", "a code that has not expired cannot be marked expired"]) expect(sql).toContain(m);
    expect(sql).toMatch(/\('inventory_code', 'AVAILABLE', 'EXPIRED'\), \('inventory_code', 'QUARANTINED', 'EXPIRED'\)/);
    expect(sql).not.toMatch(/'RESERVED', 'EXPIRED'|'SOLD', 'EXPIRED'|'EXPIRED', '/); // RESERVED and SOLD are never expired; EXPIRED is terminal
  });
});
