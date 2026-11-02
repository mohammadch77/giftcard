/**
 * Module: catalog — categories, brands, regions, products, variants, price history.
 * PUBLIC API of this module: the only file other code may import (enforced by dependency-cruiser).
 * Admin use cases take an AdminContext whose `authorize` is bound to identity at the composition root
 * (catalog does not import identity). Catalog prices are NOT ledger entries.
 */
export const MODULE_NAME = "catalog" as const;
export {
  archiveBrandOrCategory, changePrice, createBrand, createCategory, createProduct, createRegion, createVariant, getProductAdmin, setProductStatus,
  setVariantAvailability, setVariantStatus, updateProduct, updateVariant,
} from "./application/admin";
export type { AdminContext, PriceChange } from "./application/admin";
export { getPriceableVariants, getVariantSnapshot, listPublished } from "./application/queries";
export type { ListFilters, PriceableVariant, VariantSnapshot } from "./application/queries";
export { CATALOG_PERMISSIONS } from "./domain/permissions";
export type { CatalogPermissionDef } from "./domain/permissions";
export { FULFILLMENT_COMPATIBILITY, FULFILLMENT_METHODS, PRODUCT_TYPES, PUBLICATION_TRANSITIONS } from "./domain/rules";
export type { Availability, FulfillmentMethod, ProductType, PublicationStatus } from "./domain/rules";
