/**
 * Module: payments — payment records and verification state machine on top of the PaymentGateway port (no gateway selected).
 * PUBLIC API of this module: the only file other code may import (enforced by dependency-cruiser).
 * A payment becomes SUCCEEDED only from a server-to-server verification with an exact Rial match; owners of the paid
 * purpose (wallet, later orders) plug their accounting into `verifyPayment` through the in-transaction `onSucceeded` hook.
 * Manual resolution of NEEDS_REVIEW is NOT implemented (needs refund/accounting policy: B12/B13, D10).
 */
export const MODULE_NAME = "payments" as const;
export { findPaymentByGatewayRef, getPayment, getPaymentAdmin, getPaymentForUser, initiatePayment, listNeedingReview, listVerificationDue, startGatewayPayment, verifyPayment } from "./application/payments";
export type { PaymentsAdminContext, StartOutcome, VerifyDeps, VerifyHooks, VerifyOutcome } from "./application/payments";
export { DEFAULT_MAX_VERIFY_ATTEMPTS, DEFAULT_VERIFY_LEASE_SECONDS, FINAL_STATUSES, PAYMENT_PERMISSIONS } from "./domain/types";
export type { PaymentPermissionDef, PaymentPurpose, PaymentStatus, PaymentView } from "./domain/types";
