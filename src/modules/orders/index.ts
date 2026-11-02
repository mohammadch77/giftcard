/**
 * Module: orders — orders, immutable item snapshots, checkout, payment settlement, late-payment holds, cancellation/expiry.
 * PUBLIC API of this module: the only file other code may import (enforced by dependency-cruiser).
 * The only module that combines inventory, payments, fulfillment and the ledger in one transaction (F6).
 *
 * FAIL-CLOSED business configuration (not defaults):
 *   B3  reservation hold: `reservationTtlSeconds` must be supplied (ORDER_RESERVATION_TTL_NOT_CONFIGURED otherwise).
 *   D10 order-payment accounting: an `OrderPaymentPostingPolicy` must be supplied; the default refuses
 *       (ORDER_ACCOUNTING_NOT_CONFIGURED) so no order can be created or settled while the accountant's decision is open.
 * Blocked until decided: PAYMENT_NEEDS_REVIEW hold resolution and any refund-based resolution (B12/B13, 2b-9).
 */
export const MODULE_NAME = "orders" as const;
export { checkout, confirmGatewayPayment, payOrderWithWallet } from "./application/checkout";
export type { CheckoutResult } from "./application/checkout";
export { cancelOrder, expireOrder, expireStale, resolveHold, syncFulfillment } from "./application/lifecycle";
export type { HoldDecision } from "./application/lifecycle";
export { getOrder, getOrderAdmin, listOpenHolds, listOrdersForUser } from "./application/queries";
export type { OrderAdminView, OrderItemView, OrderView, OrdersAdminContext } from "./application/queries";
export { assertCheckoutConfigured } from "./application/core";
export type { OrdersDeps } from "./application/core";
export { unitRef } from "./application/core";
export { NullOrderPostingPolicy, ORDER_PERMISSIONS, PAID_STATUSES } from "./domain/types";
export type { HoldReason, OrderPaymentPostingPolicy, OrderPermissionDef, OrderPostingRequest, OrderPostingResult, OrderStatus, PaymentMethod } from "./domain/types";
