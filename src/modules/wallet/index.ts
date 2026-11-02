/**
 * Module: wallet — customer wallet on top of the ledger (balance = CUSTOMER_WALLET account; a store LIABILITY, never revenue).
 * PUBLIC API of this module: the only file other code may import (enforced by dependency-cruiser).
 * 2b-6 scope: top-up (via payments), balance, two-person administrative adjustments.
 * NOT here (blocked by open decisions): paying an order from the wallet (needs the revenue-recognition posting, D10),
 * refunds (B12/B13, 2b-9), cash-out (B5: confirmed absent).
 */
export const MODULE_NAME = "wallet" as const;
export { completeTopUp, decideAdjustment, getTopUp, getWalletBalance, getWalletBalanceAdmin, requestAdjustment, startTopUp } from "./application/wallet";
export type { StartTopUpResult, TopUpView, WalletAdminContext } from "./application/wallet";
export { WALLET_PERMISSIONS } from "./domain/permissions";
export type { TopUpLimits, WalletPermissionDef } from "./domain/permissions";
