import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import allowed from "../../architecture/module-deps.cjs";
import { PermissionCatalog } from "@/modules/identity";
import { NullOrderPostingPolicy, ORDER_PERMISSIONS } from "@/modules/orders";

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
const ordersSrc = () => walk(path.join(repo, "src/modules/orders")).filter((p) => !p.includes(`${path.sep}testing${path.sep}`)).map(read).join("\n");

describe("orders boundaries (2b-8)", () => {
  it("order tables are private; orders never touches another module's tables", () => {
    const T = /\b(from|join|into|update|table)\s+(orders|order_items|order_holds|order_status_history)\b/i;
    const offenders = walk(path.join(repo, "src")).filter((p) => !p.includes(`${path.sep}modules${path.sep}orders${path.sep}`)).filter((p) => T.test(read(p)));
    expect(offenders.map(rel)).toEqual([]);
    const foreign = /\b(from|join|into|update)\s+(payments|payment_events|digital_codes|inventory_\w+|stock_counters|fulfillment_\w+|deliveries|delivery_secrets|ledger_\w+|product_variants|products|wallet_\w+|supplier_\w+)\b/i;
    expect(ordersSrc().match(foreign)).toBeNull();
  });
  it("matrix unchanged; orders does not use cart, fraud, promotions, identity or suppliers", () => {
    expect(allowed.orders).toEqual(["cart", "catalog", "pricing", "promotions", "inventory", "payments", "wallet", "fulfillment", "ledger", "fraud", "identity", "audit"]);
    expect(ordersSrc()).not.toMatch(/@\/modules\/(cart|fraud|promotions|identity|suppliers)\b/); // wallet: reconciliation reads incomplete top-ups (allowed by the matrix)
  });
  it("D10: no revenue-recognition account is referenced by orders and the default policy refuses", async () => {
    expect(ordersSrc()).not.toMatch(/SALES_REVENUE|CUSTOMER_PREPAYMENTS|CUSTOMER_WALLET|COGS|REFUNDS_PAYABLE/);
    const p = new NullOrderPostingPolicy();
    expect(p.configured).toBe(false);
    await expect(p.postOrderPayment()).rejects.toMatchObject({ code: "ORDER_ACCOUNTING_NOT_CONFIGURED" });
  });
  it("B3: no default reservation hold is baked into orders (the inventory technical default is not reused)", () => {
    expect(ordersSrc()).not.toMatch(/DEFAULT_RESERVATION_TTL_SECONDS|ttlSeconds:\s*\d+/);
  });
  it("the checkout input has no price field; order-payment settlement is reachable only through verified payments / wallet settlement", () => {
    const checkout = read(path.join(repo, "src/modules/orders/application/checkout.ts"));
    const schema = checkout.slice(checkout.indexOf("const checkoutInput"), checkout.indexOf("export interface CheckoutResult"));
    expect(schema).toMatch(/variantId: z\.string\(\)\.uuid\(\), quantity/);
    expect(schema).not.toMatch(/price|total|amount|cost/i);
    expect(checkout).toMatch(/onSucceeded: \(tx, payment\) => onGatewayPaymentSucceeded/);
  });
  it("no external calls inside orders transactions: the only gateway call is startGatewayPayment/verifyPayment (payments owns the phases)", () => {
    expect(ordersSrc()).not.toMatch(/\bfetch\(|node:https?|node:net|console\.|gateway\.(createPayment|verifyPayment)\(/);
  });
  it("test posting policy is test-only; permissions register and the hold resolution is sensitive", () => {
    const users = walk(path.join(repo, "src")).filter((p) => /test-posting-policy/.test(read(p)) && !p.includes(`${path.sep}testing${path.sep}`));
    expect(users.map(rel)).toEqual([]);
    const c = new PermissionCatalog();
    c.register(ORDER_PERMISSIONS);
    expect(c.get("orders.resolve_hold")?.sensitive).toBe(true);
    expect(ORDER_PERMISSIONS.every((p) => p.key.startsWith("orders."))).toBe(true);
  });
});
