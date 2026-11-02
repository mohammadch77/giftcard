import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import allowed from "../../architecture/module-deps.cjs";
import { INVENTORY_PERMISSIONS } from "@/modules/inventory";
import { PermissionCatalog } from "@/modules/identity";

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

describe("inventory boundaries (2b-5)", () => {
  it("inventory tables are private to the module", () => {
    const T = /\b(from|join|into|update|table)\s+(digital_codes|inventory_reservations|inventory_reservation_lines|inventory_batches|inventory_movements|stock_counters|code_access_log)\b/i;
    expect(outside("inventory").filter((p) => T.test(readFileSync(p, "utf8"))).map((p) => path.relative(repo, p))).toEqual([]);
  });
  it("matrix unchanged: inventory depends on catalog and audit only", () => {
    expect(allowed.inventory).toEqual(["catalog", "audit"]);
  });
  it("only fulfilment (and nobody else in src) may call the plaintext path", () => {
    const users = outside("inventory").filter((p) => /withDeliverySecret/.test(readFileSync(p, "utf8"))).map((p) => path.relative(repo, p));
    expect(users.filter((u) => !u.startsWith(`src${path.sep}modules${path.sep}fulfillment${path.sep}`))).toEqual([]);
  });
  it("no administrator permission reveals codes; every inventory permission is namespaced and registers cleanly", () => {
    expect(INVENTORY_PERMISSIONS.some((p) => /reveal|unseal|read_code|plaintext/i.test(p.key))).toBe(false);
    const c = new PermissionCatalog();
    c.register(INVENTORY_PERMISSIONS);
    expect(INVENTORY_PERMISSIONS.every((p) => p.key.startsWith("inventory."))).toBe(true);
    expect(c.get("inventory.codes.import")?.sensitive).toBe(true);
    expect(c.get("inventory.stock.read")?.sensitive).toBe(false);
  });
  it("inventory code performs no external I/O and does not log secrets", () => {
    const src = walk(path.join(repo, "src/modules/inventory")).map((p) => readFileSync(p, "utf8")).join("\n");
    expect(src).not.toMatch(/\bfetch\(|node:https?|node:net|console\./);
  });
});
