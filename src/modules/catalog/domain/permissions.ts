/**
 * Permissions OWNED by the catalog module. They are registered on the identity PermissionCatalog at the
 * composition root (catalog does not import identity). No role receives them automatically: an owner grants
 * them explicitly (identity.grantRolePermission). A `catalog_manager` role is a proposal under B11.
 */
export interface CatalogPermissionDef { key: string; description: string; sensitive: boolean }

export const CATALOG_PERMISSIONS: readonly CatalogPermissionDef[] = [
  { key: "catalog.products.read", description: "View draft and archived catalog data", sensitive: false },
  { key: "catalog.products.manage", description: "Create and edit categories, brands, regions, products, variants (not prices, not publication)", sensitive: false },
  { key: "catalog.products.publish", description: "Publish, unpublish and archive products and variants", sensitive: true },
  { key: "catalog.prices.manage", description: "Set and change prices and sale prices", sensitive: true },
];
