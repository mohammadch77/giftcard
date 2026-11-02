/**
 * PROPOSED chart of accounts — version 'proposed-0'.
 *
 * STATUS: PROPOSAL (decision E4/D10). An accountant must approve the chart, the revenue-recognition
 * timing, VAT and COGS treatment BEFORE LAUNCH. Nothing here decides revenue recognition, and there is
 * deliberately NO setting (env, admin panel or database) that switches it. Accounts that only exist for
 * a recognition mode (e.g. CUSTOMER_PREPAYMENTS) are listed so the chart is complete, but no posting
 * rule for order payment / delivery exists in this step.
 *
 * Wallet money is a LIABILITY of the store towards the customer (CUSTOMER_WALLET), never revenue.
 * Source: docs/DATABASE_DESIGN.md §9.2.
 */
export const CHART_VERSION = "proposed-0";

export type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
export type Side = "DEBIT" | "CREDIT";
export type OwnerScope = "system" | "user" | "gateway" | "supplier";

export interface ChartEntry {
  code: string;
  name: string;
  type: AccountType;
  /** Contra accounts carry the opposite normal side of their type (e.g. refunds against revenue). */
  contra?: boolean;
  scope: OwnerScope;
  /** Lowest allowed balance (in the account's normal-side terms). 0 = may never go below zero. */
  minBalance?: 0;
  note: string;
}

export const CHART: readonly ChartEntry[] = [
  { code: "BANK_SETTLEMENT", name: "Bank settlement", type: "ASSET", scope: "system", note: "cash settled to the business bank account" },
  { code: "GATEWAY_RECEIVABLE", name: "Gateway receivable", type: "ASSET", scope: "gateway", note: "captured by a gateway, not yet settled" },
  { code: "SUPPLIER_PREPAID", name: "Supplier prepaid", type: "ASSET", scope: "supplier", note: "only if a prepaid supplier model applies" },
  { code: "INVENTORY_DIGITAL", name: "Digital inventory (cost)", type: "ASSET", scope: "system", note: "cost basis of unsold codes" },
  { code: "CUSTOMER_WALLET", name: "Customer wallet", type: "LIABILITY", scope: "user", minBalance: 0, note: "store owes the customer; never revenue; never negative" },
  { code: "CUSTOMER_PREPAYMENTS", name: "Customer prepayments", type: "LIABILITY", scope: "system", note: "listed for completeness; use depends on the accountant's decision (D10)" },
  { code: "REFUNDS_PAYABLE", name: "Refunds payable", type: "LIABILITY", scope: "gateway", note: "approved refund not yet paid out" },
  { code: "SUPPLIER_PAYABLE", name: "Supplier payable", type: "LIABILITY", scope: "supplier", note: "only if a pay-later supplier model applies" },
  { code: "SUSPENSE_UNRESOLVED_RECEIPTS", name: "Suspense: unresolved receipts", type: "LIABILITY", scope: "system", note: "money received but not attributable to a deliverable order (late payments, D9)" },
  { code: "TAX_PAYABLE", name: "Tax payable", type: "LIABILITY", scope: "system", note: "RESERVED — tax treatment undecided; no posting rule" },
  { code: "OWNER_EQUITY", name: "Owner equity", type: "EQUITY", scope: "system", note: "opening balances" },
  { code: "SALES_REVENUE", name: "Sales revenue", type: "REVENUE", scope: "system", note: "recognition timing NOT decided (D10)" },
  { code: "SALES_REFUNDS", name: "Sales refunds (contra revenue)", type: "REVENUE", contra: true, scope: "system", note: "refunds of recognised revenue" },
  { code: "COGS", name: "Cost of goods sold", type: "EXPENSE", scope: "system", note: "method undecided" },
  { code: "GATEWAY_FEES", name: "Gateway fees", type: "EXPENSE", scope: "gateway", note: "no fee schedule is assumed" },
  { code: "PROMO_CREDIT_EXPENSE", name: "Promotional credit expense", type: "EXPENSE", scope: "system", note: "goodwill / promotional wallet credits" },
  { code: "ADJUSTMENT_EXPENSE", name: "Administrative adjustments", type: "EXPENSE", scope: "system", note: "manual adjustments (reason + approval mandatory)" },
] as const;

const BY_CODE = new Map(CHART.map((c) => [c.code, c]));

export function chartEntry(code: string): ChartEntry {
  const e = BY_CODE.get(code);
  if (!e) throw new Error(`unknown chart account ${code}`);
  return e;
}

export function normalSideOf(type: AccountType, contra = false): Side {
  return (type === "ASSET" || type === "EXPENSE") !== contra ? "DEBIT" : "CREDIT";
}

export interface AccountSpec {
  code: string;
  ownerType?: string;
  ownerId?: string;
}

/** The customer wallet account of one user. The ledger balance of this account IS the wallet balance (a projection). */
export function walletAccount(userId: string): AccountSpec {
  return { code: "CUSTOMER_WALLET", ownerType: "user", ownerId: userId };
}

export function gatewayReceivable(gatewayKey: string): AccountSpec {
  return { code: "GATEWAY_RECEIVABLE", ownerType: "gateway", ownerId: gatewayKey };
}

export function systemAccount(code: string): AccountSpec {
  if (chartEntry(code).scope !== "system") throw new Error(`${code} is not a system account`);
  return { code };
}
