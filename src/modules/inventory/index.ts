/**
 * Module: inventory — codes/accounts (itemised, encrypted) and counted manual stock, reservations, sales.
 * PUBLIC API of this module: the only file other code may import (enforced by dependency-cruiser).
 * No admin can read a code; plaintext is released only by `withDeliverySecret` (fulfilment, logged).
 * External calls never happen inside a database transaction here (KeyProvider work is done before/after).
 */
export const MODULE_NAME = "inventory" as const;
export { adjustStock, expireDueCodes, getStock, importCodes, inventoryVariantUsage, runCodeExpiry, setCodeStatus } from "./application/admin";
export type { ExpiryRun, ImportResult, InventoryAdminContext } from "./application/admin";
export { availability, consume, getReservationStatuses, getSoldCodeRef, markSold, release, reserve, sweepExpired, verifyInventory, withDeliverySecret } from "./application/reservations";
export type { Availability, ConsumeOutcome, DeliveryRequest, IntegrityFinding, ReservationView, SoldAssignment } from "./application/reservations";
export { INVENTORY_PERMISSIONS } from "./domain/permissions";
export type { InventoryPermissionDef } from "./domain/permissions";
export { DEFAULT_RESERVATION_TTL_SECONDS, MAX_RESERVATION_TTL_SECONDS, MIN_RESERVATION_TTL_SECONDS } from "./domain/rules";
export type { CodeStatus, PayloadKind, ReservationStatus } from "./domain/rules";
