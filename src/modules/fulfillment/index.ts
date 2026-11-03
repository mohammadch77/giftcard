/**
 * Module: fulfillment — fulfilment tasks, deliveries, gated reveal. Orchestrates inventory (codes) and suppliers (purchases).
 * PUBLIC API of this module: the only file other code may import (enforced by dependency-cruiser).
 * It is the ONLY caller of inventory.withDeliverySecret and suppliers.withSupplierDeliverable (architecture test).
 * NOT here: orders/checkout (2b-8, which also installs the DB payment gate), refunds (2b-9), any real supplier (X3).
 */
export const MODULE_NAME = "fulfillment" as const;
export { cancelTasksForOrder, claimManualTask, completeManualTask, createTasks, deliverAutoCodes, deliveryStatus, fulfillSupplierTask, getTask, listTasksAdmin, listTasksForOrder, withRevealedSecret } from "./application/fulfillment";
export { fulfillmentVariantUsage } from "./application/usage";
export type { FulfillDeps, FulfillmentAdminContext, RevealRequest, SupplierFulfillOutcome, TaskView } from "./application/fulfillment";
export { FULFILLMENT_PERMISSIONS, REVEAL_LIMIT } from "./domain/types";
export type { DisclosureState, FulfillmentMethod, FulfillmentPermissionDef, TaskStatus } from "./domain/types";
