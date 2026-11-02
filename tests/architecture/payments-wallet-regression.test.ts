import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import allowed from "../../architecture/module-deps.cjs";
import { PAYMENT_PERMISSIONS } from "@/modules/payments";
import { WALLET_PERMISSIONS } from "@/modules/wallet";
import { PermissionCatalog } from "@/modules/identity";
import { createPaymentGateway } from "@/platform/composition";
import { NullPaymentGateway } from "@/platform/payment-gateway";
import { TestPaymentGateway } from "@/platform/payment-gateway/testing/test-gateway";

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

describe("payments / wallet boundaries (2b-6)", () => {
  it("tables are private to their modules (wallet may not touch payments tables and vice versa)", () => {
    const P = /\b(from|join|into|update|table)\s+(payments|payment_events|payment_status_history)\b/i;
    const W = /\b(from|join|into|update|table)\s+(wallet_topups|wallet_adjustments)\b/i;
    expect(outside("payments").filter((p) => P.test(read(p))).map((p) => path.relative(repo, p))).toEqual([]);
    expect(outside("wallet").filter((p) => W.test(read(p))).map((p) => path.relative(repo, p))).toEqual([]);
  });
  it("matrix unchanged: payments -> ledger, audit; wallet -> ledger, payments, audit; nobody imports identity here", () => {
    expect(allowed.payments).toEqual(["ledger", "audit"]);
    expect(allowed.wallet).toEqual(["ledger", "payments", "audit"]);
    expect(allowed.ledger).toEqual(["audit"]);
  });
  it("the wallet balance is never stored: wallet code has no balance column and reads the ledger", () => {
    const src = walk(path.join(repo, "src/modules/wallet")).map(read).join("\n");
    expect(src).not.toMatch(/\bbalance\s+(bigint|integer|numeric)/i);
    expect(src).toMatch(/getBalance\(/);
  });
  it("no recognition-dependent posting exists: order payment from wallet, revenue, refunds are NOT implemented here (D10/B12)", () => {
    const src = [...walk(path.join(repo, "src/modules/wallet")), ...walk(path.join(repo, "src/modules/payments"))].map(read).join("\n");
    expect(src).not.toMatch(/SALES_REVENUE|CUSTOMER_PREPAYMENTS|REFUNDS_PAYABLE|payFromWallet/);
  });
  it("gateway factory: 'none' fails closed, 'test' only outside production, and no real gateway exists", () => {
    expect(createPaymentGateway({ NODE_ENV: "production", PAYMENT_GATEWAY: "none" })).toBeInstanceOf(NullPaymentGateway);
    expect(createPaymentGateway({ NODE_ENV: "test", PAYMENT_GATEWAY: "test" })).toBeInstanceOf(TestPaymentGateway);
    expect(() => createPaymentGateway({ NODE_ENV: "production", PAYMENT_GATEWAY: "test" })).toThrow(expect.objectContaining({ code: "PAYMENT_GATEWAY_FORBIDDEN" }));
  });
  it("modules and gateway adapters make no direct outbound calls; test double is not imported by production code", () => {
    const mods = [...walk(path.join(repo, "src/modules/payments")), ...walk(path.join(repo, "src/modules/wallet"))].map(read).join("\n");
    expect(mods).not.toMatch(/\bfetch\(|node:https?|node:net|console\./);
    const offenders = walk(path.join(repo, "src")).filter((p) => !p.includes("composition") && !p.includes(`${path.sep}testing${path.sep}`)).filter((p) => /payment-gateway\/testing/.test(read(p)));
    expect(offenders).toEqual([]);
  });
  it("permissions are namespaced, register cleanly, and adjustments are sensitive", () => {
    const c = new PermissionCatalog();
    c.register([...PAYMENT_PERMISSIONS, ...WALLET_PERMISSIONS]);
    expect(c.get("wallet.adjust.request")?.sensitive).toBe(true);
    expect(c.get("wallet.adjust.approve")?.sensitive).toBe(true);
    expect(c.get("payments.read")?.sensitive).toBe(false);
  });
});
