export interface WalletPermissionDef { key: string; description: string; sensitive: boolean }
/** Wallet-owned permissions (registered on identity's catalog at the composition root). Adjustments always need two different admins (B10 open). */
export const WALLET_PERMISSIONS: readonly WalletPermissionDef[] = [
  { key: "wallet.read", description: "View a customer's wallet balance", sensitive: false },
  { key: "wallet.adjust.request", description: "Request a manual wallet credit/debit", sensitive: true },
  { key: "wallet.adjust.approve", description: "Approve or reject a manual wallet adjustment requested by someone else", sensitive: true },
];

/** Operator-supplied top-up bounds in Rial. B5 is OPEN: there is no default; missing limits make top-ups fail closed. */
export interface TopUpLimits { minRial?: number | undefined; maxRial?: number | undefined }
