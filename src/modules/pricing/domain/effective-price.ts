import { rialPrice } from "@/platform/money";
import type { Rial } from "@/platform/money";

export interface PriceFacts {
  price: number;
  salePrice: number | null;
  saleStartsAt: Date | null;
  saleEndsAt: Date | null;
}

/** The sale applies in [start, end): start inclusive, end exclusive; open ends are unbounded. */
export function saleActive(f: PriceFacts, now: Date): boolean {
  if (f.salePrice === null) return false;
  if (f.saleStartsAt && now.getTime() < f.saleStartsAt.getTime()) return false;
  if (f.saleEndsAt && now.getTime() >= f.saleEndsAt.getTime()) return false;
  return true;
}

/** Unit price a customer pays right now: the sale price while its window is open, else the regular price. */
export function effectiveUnitPrice(f: PriceFacts, now: Date): { unit: Rial; onSale: boolean } {
  const onSale = saleActive(f, now);
  return { unit: rialPrice(onSale ? f.salePrice! : f.price), onSale };
}
