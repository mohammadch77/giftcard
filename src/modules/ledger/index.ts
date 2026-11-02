/**
 * Module: ledger — double-entry, append-only ledger. THE ONLY SOURCE OF FINANCIAL TRUTH.
 * Wallet balances are projections of CUSTOMER_WALLET accounts. PUBLIC API: the only importable surface.
 * Chart of accounts = PROPOSED (D10): revenue-recognition timing is not decided and not configurable.
 */
export const MODULE_NAME = "ledger" as const;
export { ensureAccount, findTransactionByKey, post, reverse, getBalance, trialBalance, verifyIntegrity, getTransaction, SENSITIVE_KINDS } from "./application/ledger-service";
export type {
  AccountInfo, AccountRef, IntegrityFinding, LedgerDeps, PostEntry, PostInput, PostResult, ReverseInput, TransactionView, TrialBalance, TrialBalanceRow,
} from "./application/ledger-service";
export { CHART, CHART_VERSION, chartEntry, walletAccount, gatewayReceivable, systemAccount, normalSideOf } from "./domain/chart-of-accounts";
export type { AccountSpec, AccountType, ChartEntry, Side } from "./domain/chart-of-accounts";
export { POSTING_RULES, walletTopUp, suspenseReceipt, suspenseToWallet, adminWalletCredit, adminWalletDebit } from "./domain/posting-rules";
export type { RuleEntry } from "./domain/posting-rules";
