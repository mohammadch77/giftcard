/**
 * Module: pricing — server-side price calculation (never trusts the client).
 * PUBLIC API of this module: the only file other code may import (enforced by dependency-cruiser).
 * 2b-4 scope: minimal quote (effective unit price × quantity). No promotions, tax or fees.
 */
export const MODULE_NAME = "pricing" as const;
export { MAX_LINE_QUANTITY, MAX_QUOTE_LINES, PRICING_VERSION, quote } from "./application/quote";
export type { Quote, QuoteLine, QuoteLineInput } from "./application/quote";
export { effectiveUnitPrice, saleActive } from "./domain/effective-price";
export type { PriceFacts } from "./domain/effective-price";
