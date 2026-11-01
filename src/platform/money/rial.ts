import { DomainError } from "../errors";

/**
 * Money primitives (decisions D1 and P-9, APPROVED).
 *
 * - All money is integer RIAL. `Rial` is a branded `number` that is always a safe integer.
 * - Single amounts are limited to [0, MAX_RIAL_AMOUNT]; aggregates (balances, totals) to
 *   [0, MAX_RIAL_AGGREGATE]. The SAME limits exist in PostgreSQL (domains rial_amount /
 *   rial_balance, migration 0003) and a test keeps them in sync.
 * - Arithmetic is done only through these functions, on integers; floats are rejected.
 * - Toman exists only at the edges (see ./toman.ts).
 */
declare const rialBrand: unique symbol;
export type Rial = number & { readonly [rialBrand]: true };

/** Largest single amount (price, payment, ledger entry): 10^13 Rial = 10^12 Toman. Technical ceiling. */
export const MAX_RIAL_AMOUNT = 10_000_000_000_000;
/** Largest aggregate (balance/total): the largest integer a JS number holds exactly. */
export const MAX_RIAL_AGGREGATE = Number.MAX_SAFE_INTEGER;

function assertSafeInteger(value: number, what: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DomainError("RIAL_INVALID", `${what} must be a safe integer`);
  }
}

/** A single monetary amount (>= 0, <= MAX_RIAL_AMOUNT). */
export function rial(value: number): Rial {
  assertSafeInteger(value, "amount");
  if (value < 0 || value > MAX_RIAL_AMOUNT) {
    throw new DomainError("RIAL_OUT_OF_RANGE", "amount is outside the allowed range");
  }
  return value as Rial;
}

/** An aggregate/balance (>= 0, <= MAX_RIAL_AGGREGATE). Use for sums, not for single prices. */
export function rialAggregate(value: number): Rial {
  assertSafeInteger(value, "aggregate");
  if (value < 0 || value > MAX_RIAL_AGGREGATE) {
    throw new DomainError("RIAL_OUT_OF_RANGE", "aggregate is outside the allowed range");
  }
  return value as Rial;
}

export const ZERO_RIAL = 0 as Rial;

export function addRial(a: Rial, b: Rial): Rial {
  assertSafeInteger(a, "left operand");
  assertSafeInteger(b, "right operand");
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw new DomainError("RIAL_OUT_OF_RANGE", "sum overflows the safe range");
  return rialAggregate(sum);
}

/** a - b; throws if the result would be negative (use signed deltas only inside the ledger module). */
export function subRial(a: Rial, b: Rial): Rial {
  assertSafeInteger(a, "left operand");
  assertSafeInteger(b, "right operand");
  if (b > a) throw new DomainError("RIAL_OUT_OF_RANGE", "subtraction would be negative");
  return rialAggregate(a - b);
}

export function sumRial(values: readonly Rial[]): Rial {
  let total = ZERO_RIAL;
  for (const v of values) total = addRial(total, v);
  return total;
}

/** amount * quantity, quantity a positive safe integer. Exact (BigInt intermediate). */
export function mulRial(amount: Rial, quantity: number): Rial {
  assertSafeInteger(amount, "amount");
  assertSafeInteger(quantity, "quantity");
  if (quantity < 0) throw new DomainError("RIAL_INVALID", "quantity must not be negative");
  const product = BigInt(amount) * BigInt(quantity);
  if (product > BigInt(MAX_RIAL_AGGREGATE)) throw new DomainError("RIAL_OUT_OF_RANGE", "product overflows the safe range");
  return rialAggregate(Number(product));
}

/**
 * floor(amount * numerator / denominator) in exact integer arithmetic.
 * Rounding always goes DOWN (the store keeps the sub-unit remainder). Use for percentage discounts:
 *   percentFloor(amount, 15n) => 15 %.   `basisPoints` variant avoids fractional percents.
 */
export function mulDivFloor(amount: Rial, numerator: number, denominator: number): Rial {
  assertSafeInteger(amount, "amount");
  assertSafeInteger(numerator, "numerator");
  assertSafeInteger(denominator, "denominator");
  if (numerator < 0 || denominator <= 0) throw new DomainError("RIAL_INVALID", "invalid ratio");
  const result = (BigInt(amount) * BigInt(numerator)) / BigInt(denominator); // BigInt division floors for non-negatives
  if (result > BigInt(MAX_RIAL_AGGREGATE)) throw new DomainError("RIAL_OUT_OF_RANGE", "result overflows the safe range");
  return rialAggregate(Number(result));
}

/** floor(amount * percent / 100), percent an integer 0..100. */
export function percentFloor(amount: Rial, percent: number): Rial {
  assertSafeInteger(percent, "percent");
  if (percent < 0 || percent > 100) throw new DomainError("RIAL_INVALID", "percent must be 0..100");
  return mulDivFloor(amount, percent, 100);
}

/** floor(amount * bps / 10_000), bps an integer 0..10_000. */
export function basisPointsFloor(amount: Rial, bps: number): Rial {
  assertSafeInteger(bps, "basis points");
  if (bps < 0 || bps > 10_000) throw new DomainError("RIAL_INVALID", "basis points must be 0..10000");
  return mulDivFloor(amount, bps, 10_000);
}

/** Round DOWN to a multiple of 10 Rial (so the Toman figure is exact). */
export function floorToToman(amount: Rial): Rial {
  assertSafeInteger(amount, "amount");
  return (amount - (amount % 10)) as Rial;
}

export function isMultipleOfTen(amount: number): boolean {
  return Number.isSafeInteger(amount) && amount % 10 === 0;
}

/** A catalogue price: valid amount AND a multiple of 10 Rial (mirrors DB domain rial_price). */
export function rialPrice(value: number): Rial {
  const amount = rial(value);
  if (!isMultipleOfTen(amount)) throw new DomainError("RIAL_NOT_TOMAN_EXACT", "price must be a multiple of 10 Rial");
  return amount;
}

export function compareRial(a: Rial, b: Rial): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}
