/**
 * Permissions OWNED by inventory (registered on identity's catalog at the composition root).
 * There is deliberately NO permission that reveals a code to an administrator.
 */
export interface InventoryPermissionDef { key: string; description: string; sensitive: boolean }

export const INVENTORY_PERMISSIONS: readonly InventoryPermissionDef[] = [
  { key: "inventory.stock.read", description: "View stock levels (never code values)", sensitive: false },
  { key: "inventory.codes.import", description: "Import codes/accounts into stock", sensitive: true },
  { key: "inventory.codes.manage", description: "Void or quarantine/release individual codes", sensitive: true },
  { key: "inventory.stock.adjust", description: "Adjust manually managed (counted) stock", sensitive: true },
];
