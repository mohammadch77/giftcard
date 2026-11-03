/**
 * Module: wallet — customer wallet on top of the ledger (balance = CUSTOMER_WALLET account; a store LIABILITY, never revenue).
 * PUBLIC API of this module: the only file other code may import (enforced by dependency-cruiser).
 * 2b-6 scope: top-up (via payments), balance, two-person administrative adjustments.
 * P1-A: top-up limits (B5) are a versioned, two-person module setting incl. a per-user daily limit over the Asia/Tehran calendar day.
 * NOT here (blocked by open decisions): paying an order from the wallet (needs the revenue-recognition posting, D10),
 * refunds (B12/B13, 2b-9), cash-out (B5: confirmed absent).
 */
export const MODULE_NAME = "wallet" as const;
export { completeTopUp, decideAdjustment, findIncompleteSucceededTopUps, getTopUp, getWalletBalance, getWalletBalanceAdmin, requestAdjustment, startTopUp } from "./application/wallet";
export type { StartTopUpResult, TopUpView, WalletAdminContext } from "./application/wallet";
export { WALLET_PERMISSIONS } from "./domain/permissions";
export type { WalletPermissionDef } from "./domain/permissions";
export { TOPUP_DAILY_TIMEZONE, TOPUP_LIMIT_BOUNDS, dailyTopUpTotal, decideLimitChange, getTopUpLimits, getTopUpLimitsAdmin, requestLimitChange, tehranDayWindow } from "./application/settings";
export type { TopUpLimitValues, TopUpLimits, WalletSettingsAdmin } from "./application/settings";
