import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import allowed from "../../architecture/module-deps.cjs";
import { FULFILLMENT_PERMISSIONS } from "@/modules/fulfillment";
import { PermissionCatalog } from "@/modules/identity";
import { SUPPLIER_PERMISSIONS } from "@/modules/suppliers";
import { configSchema, normalizeProduct } from "@/modules/suppliers/domain/rules";
import { createSupplierAdapters } from "@/platform/composition";

const repo = path.resolve(__dirname, "../..");
const walk = (d: string, out: string[] = []): string[] => {
  for (const n of readdirSync(d)) {
    const p = path.join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
};
const outside = (mod: string) => walk(path.join(repo, "src")).filter((p) => !p.includes(`${path.sep}modules${path.sep}${mod}${path.sep}`));
const read = (p: string) => readFileSync(p, "utf8");
const rel = (p: string) => path.relative(repo, p);

describe("suppliers / fulfillment boundaries (2b-7)", () => {
  it("tables are private to their modules", () => {
    const S = /\b(from|join|into|update|table)\s+(suppliers|supplier_credentials|supplier_products|supplier_sync_runs|supplier_product_changes|variant_supplier_routes|supplier_orders|supplier_order_secrets|supplier_order_events)\b/i;
    const F = /\b(from|join|into|update|table)\s+(fulfillment_tasks|fulfillment_events|deliveries|delivery_secrets|secret_access_log)\b/i;
    expect(outside("suppliers").filter((p) => S.test(read(p))).map(rel)).toEqual([]);
    expect(outside("fulfillment").filter((p) => F.test(read(p))).map(rel)).toEqual([]);
  });
  it("matrix unchanged: suppliers -> catalog, audit; fulfillment -> inventory, suppliers, ledger, catalog, audit", () => {
    expect(allowed.suppliers).toEqual(["catalog", "audit"]);
    expect(allowed.fulfillment).toEqual(["inventory", "suppliers", "ledger", "catalog", "audit"]);
  });
  it("plaintext paths are used by fulfillment ONLY (inventory.withDeliverySecret, suppliers.withSupplierDeliverable)", () => {
    for (const fn of ["withDeliverySecret", "withSupplierDeliverable"]) {
      const users = outside(fn === "withDeliverySecret" ? "inventory" : "suppliers").filter((p) => new RegExp(fn).test(read(p))).map(rel);
      expect(users.filter((u) => !u.startsWith(`src${path.sep}modules${path.sep}fulfillment${path.sep}`)), fn).toEqual([]);
    }
  });
  it("there is no API that reads supplier credentials back", () => {
    const src = walk(path.join(repo, "src/modules/suppliers")).map(read).join("\n");
    expect(src).not.toMatch(/export (async )?function (get|read|reveal|show)\w*Credential/i);
    expect(read(path.join(repo, "src/modules/suppliers/index.ts"))).not.toMatch(/withCredentials/);
  });
  it("no network or logging primitives in supplier/fulfillment code; adapters cannot be reached except through the port", () => {
    const src = [...walk(path.join(repo, "src/modules/suppliers")), ...walk(path.join(repo, "src/modules/fulfillment"))].map(read).join("\n");
    expect(src).not.toMatch(/\bfetch\(|node:https?|node:net|console\./);
    const offenders = walk(path.join(repo, "src")).filter((p) => !p.includes("composition") && !p.includes(`${path.sep}testing${path.sep}`)).filter((p) => /supplier-adapter\/testing/.test(read(p)));
    expect(offenders.map(rel)).toEqual([]);
  });
  it("adapter factory: 'none' => empty registry (fail closed); 'test' only outside production", () => {
    expect(createSupplierAdapters({ NODE_ENV: "production", SUPPLIER_ADAPTERS: "none" }).size).toBe(0);
    expect(createSupplierAdapters({ NODE_ENV: "test", SUPPLIER_ADAPTERS: "test" }).has("test")).toBe(true);
    expect(() => createSupplierAdapters({ NODE_ENV: "production", SUPPLIER_ADAPTERS: "test" })).toThrow(expect.objectContaining({ code: "SUPPLIER_ADAPTER_FORBIDDEN" }));
  });
  it("config may not carry secrets, hosts or URLs; product normalisation never guesses (IRR integers only)", () => {
    for (const k of ["api_url", "host", "secret", "password", "token", "api_key", "endpoint", "base_domain"]) expect(configSchema.safeParse({ [k]: "x" }).success, k).toBe(false);
    expect(configSchema.safeParse({ region: "eu", retries: 3 }).success).toBe(true);
    const ok = { externalSku: "A-1", name: "n", cost: 1000, currency: "IRR", available: true };
    expect(normalizeProduct(ok)).toMatchObject({ cost: 1000 });
    for (const bad of [{ currency: "USD" }, { cost: 1.5 }, { cost: -1 }, { cost: 10_000_000_000_001 }, { externalSku: "x y" }, { name: "" }]) expect(normalizeProduct({ ...ok, ...bad }), JSON.stringify(bad)).toBeNull();
  });
  it("permissions are namespaced; credentials/resolution/manual completion are sensitive; reveal is registered but never auto-granted", () => {
    const c = new PermissionCatalog();
    c.register([...SUPPLIER_PERMISSIONS, ...FULFILLMENT_PERMISSIONS]);
    for (const k of ["suppliers.credentials.manage", "suppliers.orders.resolve", "fulfillment.manual.complete", "fulfillment.codes.reveal"]) expect(c.get(k)?.sensitive, k).toBe(true);
    expect(read(path.join(repo, "db/migrations/0019_suppliers_fulfillment_guards.sql"))).toMatch(/NOT seeded to any role/);
    expect(read(path.join(repo, "db/migrations/0019_suppliers_fulfillment_guards.sql")).split("INSERT INTO role_permissions")[1]).not.toContain("fulfillment.codes.reveal'),");
  });
});
