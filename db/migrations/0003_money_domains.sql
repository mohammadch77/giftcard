-- Money domains (decisions D1 / P-9). All monetary columns use one of these types so the limits
-- live in PostgreSQL as well as in TypeScript (src/platform/money). A test keeps both in sync.
-- Amounts are integer RIAL. Technical ceiling for one amount: 10^13 Rial (= 10^12 Toman).
-- NULL passes a domain CHECK: money columns must also be declared NOT NULL by their table.

CREATE DOMAIN rial_amount AS bigint
  CONSTRAINT rial_amount_range CHECK (VALUE >= 0 AND VALUE <= 10000000000000);
--> statement-breakpoint

-- Catalogue prices and fixed discounts: a multiple of 10 Rial so the Toman figure is exact.
CREATE DOMAIN rial_price AS bigint
  CONSTRAINT rial_price_range CHECK (VALUE >= 0 AND VALUE <= 10000000000000 AND VALUE % 10 = 0);
--> statement-breakpoint

-- Balances / aggregates (may be signed inside the ledger). Bound = largest exact JS integer.
CREATE DOMAIN rial_balance AS bigint
  CONSTRAINT rial_balance_range CHECK (VALUE >= -9007199254740991 AND VALUE <= 9007199254740991);
