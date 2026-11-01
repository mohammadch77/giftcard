import { DomainError } from "../errors";
import { MAX_RIAL_AGGREGATE, rialAggregate } from "./rial";
import type { Rial } from "./rial";

/**
 * Rial <-> Toman conversion. 1 Toman = 10 Rial.
 * This file (and UI formatting that calls it) is the ONLY place the two units meet (D1).
 * ESLint forbids `/ 10` and `* 10` elsewhere under src/.
 */
export function rialToToman(amount: Rial): number {
  if (!Number.isSafeInteger(amount)) throw new DomainError("RIAL_INVALID", "amount must be a safe integer");
  if (amount % 10 !== 0) {
    throw new DomainError("RIAL_NOT_TOMAN_EXACT", "amount is not an exact number of Toman");
  }
  return amount / 10;
}

export function tomanToRial(toman: number): Rial {
  if (!Number.isSafeInteger(toman) || toman < 0) {
    throw new DomainError("RIAL_INVALID", "toman must be a non-negative safe integer");
  }
  const rials = toman * 10;
  if (rials > MAX_RIAL_AGGREGATE) throw new DomainError("RIAL_OUT_OF_RANGE", "amount is outside the allowed range");
  return rialAggregate(rials);
}

/** Display string for customers, e.g. "۱٬۲۳۴٬۵۶۰ تومان". Amount must be Toman-exact. */
export function formatToman(amount: Rial, locale: "fa-IR" | "en-US" = "fa-IR"): string {
  const toman = rialToToman(amount);
  const number = new Intl.NumberFormat(locale, { useGrouping: true, maximumFractionDigits: 0 }).format(toman);
  return locale === "fa-IR" ? `${number} تومان` : `${number} Toman`;
}
