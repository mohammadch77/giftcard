import type { Rial } from "@/platform/money";

export type PaymentStatus = "INITIATED" | "PENDING" | "VERIFYING" | "SUCCEEDED" | "FAILED" | "NEEDS_REVIEW" | "EXPIRED" | "CANCELLED";
export type PaymentPurpose = "ORDER" | "WALLET_TOPUP";

export interface PaymentView {
  id: string;
  purpose: PaymentPurpose;
  orderRef: string | null;
  topupRef: string | null;
  userRef: string;
  gateway: string;
  gatewayRef: string | null;
  amount: Rial;
  status: PaymentStatus;
  verifiedAt: Date | null;
  reviewReason: string | null;
  createdAt: Date;
}

export const FINAL_STATUSES: ReadonlySet<PaymentStatus> = new Set(["SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED", "NEEDS_REVIEW"]);

/** Technical defaults for the verification lease and retry budget (not business policy). */
export const DEFAULT_VERIFY_LEASE_SECONDS = 120;
export const DEFAULT_MAX_VERIFY_ATTEMPTS = 5;

export interface PaymentPermissionDef { key: string; description: string; sensitive: boolean }
export const PAYMENT_PERMISSIONS: readonly PaymentPermissionDef[] = [
  { key: "payments.read", description: "View payments (no card data exists)", sensitive: false },
];
