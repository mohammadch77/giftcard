import type { Tx } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import type { Rial } from "@/platform/money";

export type OrderStatus = "PENDING_PAYMENT" | "PAID" | "FULFILLING" | "PARTIALLY_COMPLETED" | "COMPLETED" | "ON_HOLD" | "CANCELLED" | "EXPIRED";
export type PaymentMethod = "WALLET" | "GATEWAY";
export type HoldReason = "LATE_PAYMENT_NO_RESERVATION" | "PAYMENT_NEEDS_REVIEW" | "FRAUD_REVIEW" | "FULFILLMENT_FAILED" | "SUPPLIER_UNKNOWN";
export const PAID_STATUSES: ReadonlySet<OrderStatus> = new Set(["PAID", "FULFILLING", "PARTIALLY_COMPLETED", "COMPLETED"]);

/**
 * D10 BOUNDARY. How a verified order payment is booked in the ledger depends on revenue-recognition timing (wallet:
 * debit of the wallet liability account against an undecided counter-account, gateway: gateway receivable against an undecided counter-account; and for a re-reserved late payment the reclassification
 * out of SUSPENSE_UNRESOLVED_RECEIPTS). That is the accountant's open decision, NOT a setting. This port is where the approved
 * policy will plug in; until then the default `NullOrderPostingPolicy` refuses (fail closed) and checkout is refused up front.
 * The policy runs INSIDE the settlement transaction (so posting and PAID commit together) and must perform no external I/O.
 */
export interface OrderPostingRequest {
  orderId: string;
  userRef: string;
  amount: Rial;
  method: PaymentMethod;
  gatewayKey?: string;
  paymentId?: string;
  /** True when the money was already parked in SUSPENSE_UNRESOLVED_RECEIPTS (late payment re-reserved by a human, D9). */
  fromSuspense: boolean;
}
export interface OrderPostingResult { ledgerTransactionId: number | null }
export interface OrderPaymentPostingPolicy {
  /** False = accounting is undecided; checkout and settlement must refuse. */
  readonly configured: boolean;
  postOrderPayment(tx: Tx, req: OrderPostingRequest): Promise<OrderPostingResult>;
}

export class NullOrderPostingPolicy implements OrderPaymentPostingPolicy {
  readonly configured = false;
  async postOrderPayment(): Promise<OrderPostingResult> {
    throw new DomainError("ORDER_ACCOUNTING_NOT_CONFIGURED", "order payment accounting is not decided (D10): settlement is blocked");
  }
}

export interface OrderPermissionDef { key: string; description: string; sensitive: boolean }
export const ORDER_PERMISSIONS: readonly OrderPermissionDef[] = [
  { key: "orders.read", description: "View any order and its holds", sensitive: false },
  { key: "orders.cancel", description: "Cancel an unpaid order on behalf of a customer", sensitive: false },
  { key: "orders.resolve_hold", description: "Resolve or review an order hold (late payment re-reservation)", sensitive: true },
];
