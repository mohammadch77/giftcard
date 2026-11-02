import type { Database, Tx } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { mulRial, sumRial } from "@/platform/money";
import type { Rial } from "@/platform/money";
import { getPriceableVariants } from "@/modules/catalog";
import { effectiveUnitPrice } from "../domain/effective-price";

/** Technical bounds (not business policy); revisit with the cart/checkout steps. */
export const MAX_QUOTE_LINES = 50;
export const MAX_LINE_QUANTITY = 100;
export const PRICING_VERSION = "min-0";

export interface QuoteLineInput { variantId: string; quantity: number }
export interface QuoteLine { variantId: string; quantity: number; unitPrice: Rial; lineTotal: Rial; onSale: boolean }
export interface Quote { pricingVersion: string; currency: "IRR"; lines: QuoteLine[]; subtotal: Rial; quotedAt: Date }

/**
 * Server-side quote. There is NO price input: amounts come only from catalog rows read inside the caller's
 * transaction with FOR SHARE (a concurrent price change cannot yield a mixed quote). No discounts, tax, fees
 * or rounding policy exist here — promotions arrive later as a separate capability. A quote is not a ledger entry.
 */
export async function quote(tx: Tx | Database, lines: readonly QuoteLineInput[], now: Date): Promise<Quote> {
  if (lines.length < 1 || lines.length > MAX_QUOTE_LINES) throw new DomainError("CATALOG_INVALID", `1..${MAX_QUOTE_LINES} lines expected`);
  const seen = new Set<string>();
  for (const l of lines) {
    if (!Number.isSafeInteger(l.quantity) || l.quantity < 1 || l.quantity > MAX_LINE_QUANTITY) throw new DomainError("CATALOG_INVALID", `quantity must be 1..${MAX_LINE_QUANTITY}`);
    if (seen.has(l.variantId)) throw new DomainError("CATALOG_INVALID", "duplicate variant in quote");
    seen.add(l.variantId);
  }
  const rows = new Map((await getPriceableVariants(tx, lines.map((l) => l.variantId), { lockShare: true })).map((r) => [r.variantId, r]));
  const out: QuoteLine[] = lines.map((l) => {
    const r = rows.get(l.variantId);
    if (!r) throw new DomainError("CATALOG_NOT_FOUND", "variant not found");
    if (!r.sellable) throw new DomainError("CATALOG_NOT_SELLABLE", "variant is not available for sale");
    const { unit, onSale } = effectiveUnitPrice(r, now);
    return { variantId: l.variantId, quantity: l.quantity, unitPrice: unit, lineTotal: mulRial(unit, l.quantity), onSale };
  });
  return { pricingVersion: PRICING_VERSION, currency: "IRR", lines: out, subtotal: sumRial(out.map((x) => x.lineTotal)), quotedAt: now };
}
