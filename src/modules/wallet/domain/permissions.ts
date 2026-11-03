export interface WalletPermissionDef { key: string; description: string; sensitive: boolean }
/** Wallet-owned permissions (registered on identity's catalog at the composition root). Adjustments always need two different admins (B10 open). */
export const WALLET_PERMISSIONS: readonly WalletPermissionDef[] = [
  { key: "wallet.read", description: "View a customer's wallet balance", sensitive: false },
  { key: "wallet.adjust.request", description: "Request a manual wallet credit/debit", sensitive: true },
  { key: "wallet.adjust.approve", description: "Approve or reject a manual wallet adjustment requested by someone else", sensitive: true },
  { key: "wallet.settings.read", description: "View wallet top-up limits", sensitive: false },
  { key: "wallet.settings.request", description: "Request a change of the wallet top-up limits (needs a second administrator to approve)", sensitive: true },
  { key: "wallet.settings.approve", description: "Approve or reject a change of the wallet top-up limits requested by someone else", sensitive: true },
];
