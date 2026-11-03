/**
 * Module: suppliers — suppliers, write-only credentials, product sync, variant routes, supplier orders with explicit UNKNOWN handling.
 * PUBLIC API of this module: the only file other code may import (enforced by dependency-cruiser).
 * GENERIC: the SupplierAdapter port is a hypothesis (no supplier or documentation exists, X3); only a test double implements it.
 * Rules: persist key+state before sending; external calls never inside a transaction; timeout/ambiguity => UNKNOWN, never a blind retry.
 */
export const MODULE_NAME = "suppliers" as const;
export { createSupplier, deactivateRoute, getRoutes, getSupplierAdmin, mapVariantToSupplierProduct, setSupplierCredentials, updateSupplier } from "./application/admin";
export type { RouteView, SupplierAdminContext } from "./application/admin";
export { supplierVariantUsage } from "./application/usage";
export { syncSupplierProducts } from "./application/sync";
export type { SyncResult } from "./application/sync";
export {
  createSupplierOrder, findSupplierOrderByKey, getSupplierOrder, listAgedUnresolvedOrders, reconcileSupplierOrder, resolveSupplierOrderManually, submitSupplierOrder, sweepStuckSubmissions, withSupplierDeliverable,
} from "./application/orders";
export type { ReconcileOutcome, SubmitOutcome, SupplierOrderView } from "./application/orders";
export type { SupplierDeps } from "./application/shared";
export { DEFAULT_SUBMIT_LEASE_SECONDS, DEFAULT_SUBMIT_TIMEOUT_MS, SUPPLIER_PERMISSIONS } from "./domain/rules";
export type { SupplierOrderStatus, SupplierPermissionDef } from "./domain/rules";
