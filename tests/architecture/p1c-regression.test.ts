import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionCatalog } from "@/modules/identity";
import { REFUND_PERMISSIONS, REFUND_REVIEW_REASONS, REFUND_THRESHOLD_BOUNDS } from "@/modules/orders";
import { WALLET_ADJUSTMENT_THRESHOLD_BOUNDS, WALLET_PERMISSIONS } from "@/modules/wallet";

const repo = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(repo, p), "utf8");

describe("P1-C: financial approval thresholds, refund review workflows, refund execution safety (B10, B12, B13)", () => {
  it("settings live in module-owned version tables, not generic key/value tables", () => {
    expect(read("src/modules/wallet/infra/schema.ts")).toContain('"wallet_adjustment_threshold_versions"');
    expect(read("src/modules/orders/infra/schema.ts")).toContain('"refund_threshold_versions"');
    expect(read("src/modules/catalog/infra/schema.ts")).toContain('"catalog_legal_reviews"');

    // Wallet threshold table is never touched by orders, catalog, etc.
    for (const other of ["catalog", "inventory", "ledger", "payments", "fulfillment", "suppliers", "identity", "audit"]) {
      expect(read(`src/modules/${other}/infra/schema.ts`)).not.toMatch(/wallet_adjustment_threshold_versions|refund_threshold_versions/);
    }
  });

  it("two-person floor cannot be disabled: auto_approval_allowed = false is pinned in schemas and migrations", () => {
    const walletSchema = read("src/modules/wallet/infra/schema.ts");
    const ordersSchema = read("src/modules/orders/infra/schema.ts");
    const m28 = read("db/migrations/0028_p1c_thresholds_refund_tables.sql");
    const m29 = read("db/migrations/0029_p1c_thresholds_refund_guards.sql");

    expect(walletSchema).toContain('check("wallet_adj_threshold_auto_approval", sql`${t.autoApprovalAllowed} = false`)');
    expect(ordersSchema).toContain('check("refund_threshold_auto_approval", sql`${t.autoApprovalAllowed} = false`)');
    expect(m28).toContain('"auto_approval_allowed" = false');
    expect(m29).toContain("auto_approval_allowed, source, status");
  });

  it("fail-closed initial seeds: initial threshold = 0 rial (Tier 2 required for all requests until explicit amounts approved)", () => {
    const m29 = read("db/migrations/0029_p1c_thresholds_refund_guards.sql");
    expect(m29).toMatch(/INSERT INTO wallet_adjustment_threshold_versions[^;]+VALUES \([a-z_()]+, 0, false, 'SEED', 'APPROVED'/);
    expect(m29).toMatch(/INSERT INTO refund_threshold_versions[^;]+VALUES \([a-z_()]+, 0, false, 'SEED', 'APPROVED'/);
  });

  it("permissions: tier-2 approvals are sensitive (step-up), two-person required, and registered cleanly", () => {
    const c = new PermissionCatalog();
    c.register([...WALLET_PERMISSIONS, ...REFUND_PERMISSIONS]);

    expect(c.get("wallet.adjust.approve_tier2")?.sensitive).toBe(true);
    expect(c.get("wallet.settings.thresholds.request")?.sensitive).toBe(true);
    expect(c.get("wallet.settings.thresholds.approve")?.sensitive).toBe(true);
    expect(c.get("wallet.settings.thresholds.read")?.sensitive).toBe(false);

    expect(c.get("orders.refunds.approve_tier2")?.sensitive).toBe(true);
    expect(c.get("orders.settings.thresholds.request")?.sensitive).toBe(true);
    expect(c.get("orders.settings.thresholds.approve")?.sensitive).toBe(true);
    expect(c.get("orders.settings.thresholds.read")?.sensitive).toBe(false);

    // override_revealed must remain sensitive and seeded to NO role
    expect(c.get("orders.refunds.override_revealed")?.sensitive).toBe(true);
    const m29 = read("db/migrations/0029_p1c_thresholds_refund_guards.sql");
    const values = m29.slice(m29.indexOf("CROSS JOIN (VALUES"));
    expect(values).not.toMatch(/override_revealed/);
  });

  it("every supported manual review reason is represented in REFUND_REVIEW_REASONS", () => {
    const expected = [
      "DEFECTIVE_PRODUCT",
      "INCORRECT_PRODUCT",
      "MISREPRESENTED_PRODUCT",
      "DUPLICATE_PAYMENT",
      "SUPPLIER_FAILURE",
      "SUPPLIER_UNKNOWN",
      "FRAUD_REVIEW",
      "FULFILLMENT_FAILURE",
      "CUSTOMER_DISPUTE",
      "REVEALED_DISPUTE",
    ];
    expect([...REFUND_REVIEW_REASONS].sort()).toEqual(expected.sort());
  });

  it("technical bounds on thresholds are pinned", () => {
    expect(WALLET_ADJUSTMENT_THRESHOLD_BOUNDS).toEqual({ minFloorRial: 0, maxCeilingRial: 1_000_000_000_000 });
    expect(REFUND_THRESHOLD_BOUNDS).toEqual({ minFloorRial: 0, maxCeilingRial: 1_000_000_000_000 });
  });

  it("no floating-point money in threshold settings or refund logic", () => {
    for (const f of [
      "src/modules/wallet/application/settings.ts",
      "src/modules/wallet/application/wallet.ts",
      "src/modules/orders/application/settings.ts",
      "src/modules/orders/application/refunds.ts",
    ]) {
      expect(read(f)).not.toMatch(/parseFloat|toFixed\(|Math\.round|Math\.floor|\* 0\.\d/);
    }
  });

  it("B13 refund execution safety: exactly 2 gateway calls, exactly 2 finalize calls, no tx in phase 2", () => {
    const refundsSrc = read("src/modules/orders/application/refunds.ts");
    const calls = [...refundsSrc.matchAll(/gw\.(refundPayment|verifyRefund)!\(/g)];
    expect(calls.length).toBe(2);
    expect(refundsSrc.match(/await finalize\(/g)?.length).toBe(2);
    const phase2 = refundsSrc.slice(refundsSrc.indexOf("// Phase 2 (NO transaction)"), refundsSrc.indexOf("// Phase 3 (tx)"));
    expect(phase2).not.toMatch(/withTransaction|\btx\b/);
  });

  it("game account variants are blocked server-side from publication and sale pending approved legal review (B2-LEGAL)", () => {
    const m29 = read("db/migrations/0029_p1c_thresholds_refund_guards.sql");
    expect(m29).toContain("game account products are blocked pending recorded legal review (B2-LEGAL)");
    const queries = read("src/modules/catalog/application/queries.ts");
    expect(queries).toContain("catalog_legal_reviews clr where clr.scope = 'GAME_ACCOUNT' and clr.status = 'APPROVED'");
  });
});
