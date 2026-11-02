import { describe, expect, it } from "vitest";
import { CHART, CHART_VERSION, chartEntry, normalSideOf, systemAccount, walletAccount, gatewayReceivable } from "@/modules/ledger";
import { POSTING_RULES, adminWalletCredit, adminWalletDebit, suspenseReceipt, suspenseToWallet, walletTopUp } from "@/modules/ledger";
import { mirror, requestHash, sortForLocking, validateEntries, validateHeader } from "@/modules/ledger/domain/posting";
import { totalOf } from "@/modules/ledger/domain/posting-rules";
import type { ResolvedEntry } from "@/modules/ledger/domain/posting";

const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return (e as { code?: string }).code ?? "OTHER"; }
  return "NO_ERROR";
};
const E = (accountId: number, side: "DEBIT" | "CREDIT", amount: number): ResolvedEntry => ({ accountId, side, amount: amount as never });

describe("proposed chart of accounts (status: PROPOSAL pending the accountant, D10)", () => {
  it("is versioned as proposed and has unique codes", () => {
    expect(CHART_VERSION).toBe("proposed-0");
    expect(new Set(CHART.map((c) => c.code)).size).toBe(CHART.length);
  });
  it("normal sides follow type and contra flag", () => {
    expect(normalSideOf("ASSET")).toBe("DEBIT");
    expect(normalSideOf("EXPENSE")).toBe("DEBIT");
    expect(normalSideOf("LIABILITY")).toBe("CREDIT");
    expect(normalSideOf("EQUITY")).toBe("CREDIT");
    expect(normalSideOf("REVENUE")).toBe("CREDIT");
    expect(normalSideOf("REVENUE", true)).toBe("DEBIT");
  });
  it("customer wallet is a LIABILITY with a zero floor (store debt to the customer, never revenue)", () => {
    const w = chartEntry("CUSTOMER_WALLET");
    expect(w.type).toBe("LIABILITY");
    expect(w.minBalance).toBe(0);
    expect(w.scope).toBe("user");
    expect(CHART.filter((c) => c.type === "REVENUE" && !c.contra).map((c) => c.code)).toEqual(["SALES_REVENUE"]);
  });
  it("only wallets carry a floor; scoped accounts need owners", () => {
    expect(CHART.filter((c) => c.minBalance !== undefined).map((c) => c.code)).toEqual(["CUSTOMER_WALLET"]);
    expect(() => systemAccount("CUSTOMER_WALLET")).toThrow();
    expect(() => chartEntry("NOPE")).toThrow();
    expect(walletAccount("u-1")).toEqual({ code: "CUSTOMER_WALLET", ownerType: "user", ownerId: "u-1" });
    expect(gatewayReceivable("g")).toEqual({ code: "GATEWAY_RECEIVABLE", ownerType: "gateway", ownerId: "g" });
  });
  it("marks undecided items as such (tax reserved, recognition not configurable)", () => {
    expect(chartEntry("TAX_PAYABLE").note).toMatch(/RESERVED/);
    expect(chartEntry("SALES_REVENUE").note).toMatch(/NOT decided/);
  });
});

describe("posting-rule builders", () => {
  it("only recognition-independent rules exist (order payment / delivery / refund / settlement / fees are deliberately absent)", () => {
    expect(Object.keys(POSTING_RULES).sort()).toEqual(["adminWalletCredit", "adminWalletDebit", "suspenseReceipt", "suspenseToWallet", "walletTopUp"]);
  });
  it("wallet top-up credits a LIABILITY and debits the gateway receivable", () => {
    const r = walletTopUp({ userId: "u1", gatewayKey: "gw", amount: 500_000 });
    expect(r).toEqual([
      { account: { code: "GATEWAY_RECEIVABLE", ownerType: "gateway", ownerId: "gw" }, side: "DEBIT", amount: 500_000 },
      { account: { code: "CUSTOMER_WALLET", ownerType: "user", ownerId: "u1" }, side: "CREDIT", amount: 500_000 },
    ]);
  });
  it("every rule is balanced, exact and rejects bad amounts (property check over 2,000 seeded amounts)", () => {
    let seed = 7;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff);
    for (let i = 0; i < 2000; i++) {
      const amount = 1 + (next() % 9_999_999_999_999);
      for (const rule of [walletTopUp({ userId: "u", gatewayKey: "g", amount }), suspenseReceipt({ gatewayKey: "g", amount }), suspenseToWallet({ userId: "u", amount }), adminWalletCredit({ userId: "u", amount }), adminWalletDebit({ userId: "u", amount })]) {
        expect(totalOf(rule, "DEBIT")).toBe(amount);
        expect(totalOf(rule, "CREDIT")).toBe(amount);
        expect(rule.length).toBe(2);
      }
    }
    for (const bad of [0, -5, 1.5, NaN, 10 ** 14]) expect(() => walletTopUp({ userId: "u", gatewayKey: "g", amount: bad })).toThrow();
  });
  it("late-payment money goes to suspense, never to revenue", () => {
    const r = suspenseReceipt({ gatewayKey: "g", amount: 10 });
    expect(r.find((e) => e.side === "CREDIT")?.account.code).toBe("SUSPENSE_UNRESOLVED_RECEIPTS");
  });
});

describe("posting validation (domain layer; the database re-checks at COMMIT)", () => {
  it("accepts balanced entries", () => {
    expect(() => validateEntries([{ side: "DEBIT", amount: 10 }, { side: "CREDIT", amount: 4 }, { side: "CREDIT", amount: 6 }])).not.toThrow();
  });
  it.each([
    ["unbalanced", [{ side: "DEBIT", amount: 10 }, { side: "CREDIT", amount: 9 }], "LEDGER_UNBALANCED"],
    ["one entry", [{ side: "DEBIT", amount: 10 }], "LEDGER_INVALID"],
    ["debit only", [{ side: "DEBIT", amount: 5 }, { side: "DEBIT", amount: 5 }], "LEDGER_UNBALANCED"],
    ["zero amount", [{ side: "DEBIT", amount: 0 }, { side: "CREDIT", amount: 0 }], "LEDGER_INVALID"],
    ["negative", [{ side: "DEBIT", amount: -5 }, { side: "CREDIT", amount: -5 }], "RIAL_OUT_OF_RANGE"],
    ["fractional", [{ side: "DEBIT", amount: 1.5 }, { side: "CREDIT", amount: 1.5 }], "RIAL_INVALID"],
    ["over ceiling", [{ side: "DEBIT", amount: 10 ** 14 }, { side: "CREDIT", amount: 10 ** 14 }], "RIAL_OUT_OF_RANGE"],
    ["empty", [], "LEDGER_INVALID"],
  ] as const)("rejects %s", (_n, entries, expected) => {
    expect(code(() => validateEntries(entries as never))).toBe(expected);
  });
  it("rejects more than 50 entries and bad sides", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ side: i % 2 ? "DEBIT" : "CREDIT", amount: 1 }));
    expect(code(() => validateEntries(many as never))).toBe("LEDGER_INVALID");
    expect(code(() => validateEntries([{ side: "LEFT", amount: 1 }, { side: "CREDIT", amount: 1 }] as never))).toBe("LEDGER_INVALID");
  });
  it("validates kind, key and reference formats", () => {
    expect(() => validateHeader("WALLET_TOPUP", "topup:pay-1234", { type: "payment", id: "p1" })).not.toThrow();
    for (const [k, key, ref] of [["lower", "topup:pay-1234", { type: "payment", id: "p" }], ["KIND", "short", { type: "payment", id: "p" }], ["KIND", "topup:pay-1234", { type: "Bad", id: "p" }], ["KIND", "topup:pay-1234", { type: "payment", id: "" }]] as const) {
      expect(code(() => validateHeader(k, key, ref))).toBe("LEDGER_INVALID");
    }
  });
});

describe("request fingerprint, lock ordering and reversal mirror", () => {
  const base = { kind: "K", reference: { type: "t", id: "1" } };
  it("is independent of entry order and sensitive to every field", () => {
    const a = [E(2, "CREDIT", 5), E(1, "DEBIT", 5)];
    const b = [E(1, "DEBIT", 5), E(2, "CREDIT", 5)];
    expect(requestHash({ ...base, entries: a })).toBe(requestHash({ ...base, entries: b }));
    expect(requestHash({ ...base, entries: b })).not.toBe(requestHash({ ...base, entries: [E(1, "DEBIT", 6), E(2, "CREDIT", 6)] }));
    expect(requestHash({ ...base, entries: b })).not.toBe(requestHash({ ...base, kind: "K2", entries: b }));
    expect(requestHash({ ...base, entries: b })).not.toBe(requestHash({ ...base, entries: b, reversesId: 9 }));
  });
  it("orders entries by account id so every caller locks accounts in the same order", () => {
    expect(sortForLocking([E(9, "CREDIT", 1), E(3, "DEBIT", 1), E(3, "CREDIT", 1)]).map((e) => [e.accountId, e.side])).toEqual([[3, "CREDIT"], [3, "DEBIT"], [9, "CREDIT"]]);
  });
  it("mirror flips every side and keeps accounts and amounts", () => {
    const m = mirror([E(1, "DEBIT", 5), E(2, "CREDIT", 5)]);
    expect(m).toEqual([E(1, "CREDIT", 5), E(2, "DEBIT", 5)]);
  });
});
