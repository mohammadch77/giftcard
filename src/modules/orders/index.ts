/**
 * Module: orders — orders, immutable item snapshots, checkout, payment settlement, late-payment holds, cancellation/expiry.
 * PUBLIC API of this module: the only file other code may import (enforced by dependency-cruiser).
 * The only module that combines inventory, payments, fulfillment and the ledger in one transaction (F6).
 *
 * FAIL-CLOSED business configuration (not defaults):
 *   B3  reservation hold: `reservationTtlSeconds` must be supplied (ORDER_RESERVATION_TTL_NOT_CONFIGURED otherwise).
 *   D10 order-payment accounting: an `OrderPaymentPostingPolicy` must be supplied; the default refuses
 *       (ORDER_ACCOUNTING_NOT_CONFIGURED) so no order can be created or settled while the accountant's decision is open.
 * 2b-9: full-order refunds (policy as data, 'temporary-0'), four-eyes approval, exact-mirror reversal or approved D9 suspense rules only;
 *   delivered items, partial refunds, gateway->wallet and any refund without a settlement posting are REFUND_BLOCKED (D10/B12/B13 open).
 */
export const MODULE_NAME = "orders" as const;
export { checkout, confirmGatewayPayment, payOrderWithWallet } from "./application/checkout";
export type { CheckoutResult } from "./application/checkout";
export { cancelOrder, expireOrder, expireStale, resolveHold, syncFulfillment } from "./application/lifecycle";
export type { HoldDecision } from "./application/lifecycle";
export { getOrder, getOrderAdmin, listOpenHolds, listOrdersForUser } from "./application/queries";
export type { OrderAdminView, OrderItemView, OrderView, OrdersAdminContext } from "./application/queries";
export { approveRefund, executeRefund, getRefund, listRefunds, loadPolicy, rejectRefund, requestRefund } from "./application/refunds";
export type { RefundAdmin, RefundExecResult, RefundRequester, RefundView } from "./application/refunds";
export { ALL_JOBS, listFindings, runChecks, runReconciliation } from "./application/reconciliation";
export type { ReconFinding, ReconJob, ReconOptions } from "./application/reconciliation";
export { evaluateRefundPolicy } from "./domain/refund-policy";
export { assertCheckoutConfigured } from "./application/core";
export type { OrdersDeps } from "./application/core";
export { unitRef } from "./application/core";
export { NullOrderPostingPolicy, ORDER_PERMISSIONS, PAID_STATUSES, REFUND_PERMISSIONS } from "./domain/types";
export type { HoldReason, OrderPaymentPostingPolicy, RefundDecision, RefundDestination, RefundStatus, OrderPermissionDef, OrderPostingRequest, OrderPostingResult, OrderStatus, PaymentMethod } from "./domain/types";
