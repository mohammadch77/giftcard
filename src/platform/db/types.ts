import { customType } from "drizzle-orm/pg-core";
import { rial, rialAggregate, rialPrice } from "../money";
import type { Rial } from "../money";

/**
 * Drizzle column types bound to the PostgreSQL money domains (migration 0003).
 * Values cross the boundary as `Rial` (branded safe-integer number); pg returns bigint as string,
 * so reads are validated and converted, writes are validated before they reach the database.
 * Usage in a module schema:  amount: rialAmount("amount").notNull()
 */
function toNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return n;
}

export const rialAmount = customType<{ data: Rial; driverData: string }>({
  dataType: () => "rial_amount",
  toDriver: (value) => String(rial(value)),
  fromDriver: (value) => rial(toNumber(value)),
});

export const rialPriceColumn = customType<{ data: Rial; driverData: string }>({
  dataType: () => "rial_price",
  toDriver: (value) => String(rialPrice(value)),
  fromDriver: (value) => rialPrice(toNumber(value)),
});

/** Balances/aggregates (non-negative in TypeScript; the ledger module handles signed deltas itself). */
export const rialBalance = customType<{ data: Rial; driverData: string }>({
  dataType: () => "rial_balance",
  toDriver: (value) => String(rialAggregate(value)),
  fromDriver: (value) => rialAggregate(toNumber(value)),
});
