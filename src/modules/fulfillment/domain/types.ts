export type TaskStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type FulfillmentMethod = "AUTO_CODE" | "MANUAL" | "SUPPLIER_API";
export type DisclosureState = "NOT_DELIVERED" | "DELIVERED_UNREVEALED" | "REVEALED_BY_CUSTOMER" | "REVEALED_BY_ADMIN_ONLY";

/** Technical default for the reveal rate limit (not policy): 20 reveals per actor per 10 minutes. */
export const REVEAL_LIMIT = { limit: 20, windowSeconds: 600 };

export interface FulfillmentPermissionDef { key: string; description: string; sensitive: boolean }
export const FULFILLMENT_PERMISSIONS: readonly FulfillmentPermissionDef[] = [
  { key: "fulfillment.tasks.read", description: "View the fulfilment queue (never secrets)", sensitive: false },
  { key: "fulfillment.manual.claim", description: "Pick up a manual fulfilment task", sensitive: false },
  { key: "fulfillment.manual.complete", description: "Enter credentials for a manual delivery", sensitive: true },
  // Defined so the catalog knows it, but NOT granted to any role by default: admins reading delivered secrets is an explicit, logged exception.
  { key: "fulfillment.codes.reveal", description: "Reveal a delivered secret to an administrator (logged)", sensitive: true },
];
