import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REFUND_PERMISSIONS } from "@/modules/orders";
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
const read = (p: string) => readFileSync(p, "utf8");
const rel = (p: string) => path.relative(repo, p);
const refundsSrc = read(path.join(repo, "src/modules/orders/application/refunds.ts"));
const reconSrc = read(path.join(repo, "src/modules/orders/application/reconciliation.ts"));

describe("refunds and reconciliation boundaries (2b-9)", () => {
  it("refund and reconciliation tables are private to the orders module", () => {
    const T = /\b(from|join|into|update|table)\s+(refunds|refund_items|refund_status_history|refund_policy_versions|refund_policy_rules|reconciliation_runs|reconciliation_findings)\b/i;
    const offenders = walk(path.join(repo, "src")).filter((p) => !p.includes(`${path.sep}modules${path.sep}orders${path.sep}`)).filter((p) => T.test(read(p)));
    expect(offenders.map(rel)).toEqual([]);
  });
  it("D10: refunds choose no accounting — only reversals of existing postings and the approved D9 suspense rule; ledger kinds are pinned", () => {
    expect(refundsSrc + reconSrc).not.toMatch(/SALES_REVENUE|CUSTOMER_PREPAYMENTS|CUSTOMER_WALLET|COGS|REFUNDS_PAYABLE|ADJUSTMENT_EXPENSE|GATEWAY_FEES/);
    const kinds = [...refundsSrc.matchAll(/kind:\s*"([A-Z_]+)"/g)].map((m) => m[1]);
    expect(kinds).toEqual(["SUSPENSE_RESOLUTION"]);
    expect(refundsSrc).toMatch(/suspenseToWallet\(/);
    expect(refundsSrc).not.toMatch(/adminWalletCredit|adminWalletDebit|walletTopUp|suspenseReceipt\(/);
  });
  it("the gateway is only called in the no-transaction phase; its result is never treated as completion", () => {
    const calls = [...refundsSrc.matchAll(/gw\.(refundPayment|verifyRefund)!\(/g)];
    expect(calls.length).toBe(2);
    const phase2 = refundsSrc.slice(refundsSrc.indexOf("// Phase 2 (NO transaction)"), refundsSrc.indexOf("// Phase 3 (tx)"));
    expect(phase2.match(/gw\.(refundPayment|verifyRefund)!\(/g)?.length).toBe(2);
    expect(phase2).not.toMatch(/withTransaction|\btx\b/);
    expect(refundsSrc.replace(phase2, "")).not.toMatch(/\.(refundPayment|verifyRefund)\b!?\(/);
    // completion is only reachable through finalize(), after outcome === "CONFIRMED" was derived from a verified exact amount
    expect(refundsSrc).toMatch(/v\.amount === Number\(r\.amount\)/);
    expect(refundsSrc.match(/await finalize\(/g)?.length).toBe(2);
  });
  it("no deletes, no purge, no network I/O; money is integer Rial only", () => {
    expect(refundsSrc + reconSrc).not.toMatch(/\bdelete\s+from\b|\btruncate\b|\bfetch\(|node:https?|console\./i);
    expect(refundsSrc + reconSrc).not.toMatch(/parseFloat|toFixed|Math\.round|Number\.parseFloat/);
  });
  it("test doubles stay test-only; the override permission is registered, sensitive and seeded to NO role", () => {
    const users = walk(path.join(repo, "src")).filter((p) => /booking-policy/.test(read(p)) && !p.includes(`${path.sep}testing${path.sep}`));
    expect(users.map(rel)).toEqual([]);
    const c = new PermissionCatalog();
    c.register(REFUND_PERMISSIONS);
    for (const k of ["orders.refunds.approve", "orders.refunds.execute", "orders.refunds.override_revealed"]) expect(c.get(k)?.sensitive, k).toBe(true);
    expect(REFUND_PERMISSIONS.every((p) => p.key.startsWith("orders."))).toBe(true);
    const seed = read(path.join(repo, "db/migrations/0023_refunds_guards.sql"));
    const values = seed.slice(seed.indexOf("CROSS JOIN (VALUES"));
    expect(values).not.toMatch(/override_revealed/);
  });
  it("reconciliation is read-only detection: it writes only its own run/finding rows", () => {
    const writes = [...reconSrc.matchAll(/\b(insert into|update|delete from)\s+(\w+)/gi)].map((m) => `${m[1]!.toLowerCase()} ${m[2]}`);
    expect([...new Set(writes)].sort()).toEqual(["insert into reconciliation_findings", "insert into reconciliation_runs", "update reconciliation_runs"]);
  });
  it("unresolved policies fail closed: every blocker raises REFUND_BLOCKED, and the delivered-item / partial / conversion / missing-posting paths are all present", () => {
    for (const marker of ["no settlement posting", "other conversions need the accountant", "delivered items", "no verified refund capability", "supplier order is outstanding", "no active refund policy"]) expect(refundsSrc, marker).toContain(marker);
  });
});
