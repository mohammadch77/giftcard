import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import allowed from "../../architecture/module-deps.cjs";

const repo = path.resolve(__dirname, "../..");
const walk = (d: string, out: string[] = []): string[] => {
  for (const n of readdirSync(d)) {
    const p = path.join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
};

describe("catalog / pricing boundaries (2b-4)", () => {
  it("catalog tables are private: nothing outside src/modules/catalog mentions them", () => {
    const TABLES = /\b(product_variants|variant_price_history|product_status_history|variant_status_history|product_type_fulfillment)\b|\b(from|join|into|update)\s+(products|categories|brands|regions)\b/i;
    const offenders = walk(path.join(repo, "src")).filter((p) => !p.includes(`${path.sep}modules${path.sep}catalog${path.sep}`)).filter((p) => TABLES.test(readFileSync(p, "utf8")));
    expect(offenders.map((p) => path.relative(repo, p))).toEqual([]);
  });
  it("matrix unchanged: catalog depends only on audit, pricing on catalog/promotions, and catalog does not import identity", () => {
    expect(allowed.catalog).toEqual(["audit"]);
    expect(allowed.pricing).toEqual(["catalog", "promotions"]);
  });
  it("pricing has no money implementation of its own and never reads a price from its input", () => {
    const src = walk(path.join(repo, "src/modules/pricing")).map((p) => readFileSync(p, "utf8")).join("\n");
    expect(src).not.toMatch(/parseFloat|toFixed|Math\.(round|floor|ceil)/);
    expect(readFileSync(path.join(repo, "src/modules/pricing/application/quote.ts"), "utf8")).toMatch(/interface QuoteLineInput \{ variantId: string; quantity: number \}/);
  });
});
