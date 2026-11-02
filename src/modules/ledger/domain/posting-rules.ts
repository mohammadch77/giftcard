import { addRial, rial } from "@/platform/money";
import type { Rial } from "@/platform/money";
import { DomainError } from "@/platform/errors";
import { gatewayReceivable, systemAccount, walletAccount } from "./chart-of-accounts";
import type { AccountSpec, Side } from "./chart-of-accounts";

/**
 * Posting-rule builders for the PROPOSED chart. Only rules that do NOT depend on the open accounting
 * decisions are provided:
 *   - wallet top-up (cash in => liability to the customer),
 *   - received-but-unattributable money (late payment, D9 => suspense liability) and its resolution
 *     into the customer's wallet,
 *   - administrative wallet adjustments (classification as expense is part of the proposed chart).
 * NOT provided on purpose (they depend on revenue-recognition timing / VAT / COGS / fee policy, D10):
 * order payment, delivery, refunds of recognised revenue, gateway settlement and fees. There is no
 * setting that selects a recognition mode.
 */
export interface RuleEntry {
  account: AccountSpec;
  side: Side;
  amount: Rial;
}

const pair = (debit: AccountSpec, credit: AccountSpec, amount: Rial): RuleEntry[] => {
  if (amount <= 0) throw new DomainError("LEDGER_INVALID", "amount must be positive");
  return [
    { account: debit, side: "DEBIT", amount },
    { account: credit, side: "CREDIT", amount },
  ];
};

/** Verified gateway payment into the wallet: DR gateway receivable / CR customer wallet (liability). */
export function walletTopUp(args: { userId: string; gatewayKey: string; amount: number }): RuleEntry[] {
  return pair(gatewayReceivable(args.gatewayKey), walletAccount(args.userId), rial(args.amount));
}

/** Money received that cannot be attributed to a deliverable order (D9): DR gateway receivable / CR suspense. */
export function suspenseReceipt(args: { gatewayKey: string; amount: number }): RuleEntry[] {
  return pair(gatewayReceivable(args.gatewayKey), systemAccount("SUSPENSE_UNRESOLVED_RECEIPTS"), rial(args.amount));
}

/** Suspense resolved by crediting the customer's wallet: DR suspense / CR customer wallet. */
export function suspenseToWallet(args: { userId: string; amount: number }): RuleEntry[] {
  return pair(systemAccount("SUSPENSE_UNRESOLVED_RECEIPTS"), walletAccount(args.userId), rial(args.amount));
}

/** Administrative credit to a wallet: DR adjustment expense / CR customer wallet. Reason + approval are mandatory upstream. */
export function adminWalletCredit(args: { userId: string; amount: number }): RuleEntry[] {
  return pair(systemAccount("ADJUSTMENT_EXPENSE"), walletAccount(args.userId), rial(args.amount));
}

/** Administrative debit from a wallet: DR customer wallet / CR adjustment expense. */
export function adminWalletDebit(args: { userId: string; amount: number }): RuleEntry[] {
  return pair(walletAccount(args.userId), systemAccount("ADJUSTMENT_EXPENSE"), rial(args.amount));
}

export function totalOf(entries: readonly RuleEntry[], side: Side): Rial {
  return entries.filter((e) => e.side === side).reduce((sum, e) => addRial(sum, e.amount), rial(0));
}

/** Names of every provided rule — a test pins this list so that recognition-dependent rules can't appear silently. */
export const POSTING_RULES = {
  walletTopUp,
  suspenseReceipt,
  suspenseToWallet,
  adminWalletCredit,
  adminWalletDebit,
} as const;
