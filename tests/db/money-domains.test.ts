import { pgTable, text } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "@/platform/errors";
import { MAX_RIAL_AGGREGATE, MAX_RIAL_AMOUNT, rial } from "@/platform/money";
import { rialAmount, rialBalance, rialPriceColumn } from "@/platform/db/types";
import { createTestDatabase, pgCode } from "../helpers/db";
import type { TestDatabase } from "../helpers/db";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query(`create table money_probe (
    id int primary key generated always as identity, label text,
    amount rial_amount not null, price rial_price, balance rial_balance)`);
});
afterAll(async () => {
  await t?.drop();
});

const insert = (amount: number | string, price: number | string | null = null, balance: number | string | null = null) =>
  t.pool.query("insert into money_probe (label, amount, price, balance) values ('x', $1, $2, $3)", [amount, price, balance]);

describe("PostgreSQL money domains", () => {
  it("accept boundary values", async () => {
    await insert(0, 0, -9007199254740991);
    await insert(MAX_RIAL_AMOUNT, MAX_RIAL_AMOUNT, 9007199254740991);
  });
  it("rial_amount rejects negative and above-ceiling values (SQLSTATE 23514)", async () => {
    await expect(insert(-1)).rejects.toSatisfy((e) => pgCode(e) === "23514");
    await expect(insert(MAX_RIAL_AMOUNT + 1)).rejects.toSatisfy((e) => pgCode(e) === "23514");
  });
  it("rial_price rejects values that are not a multiple of 10", async () => {
    await expect(insert(10, 15)).rejects.toSatisfy((e) => pgCode(e) === "23514");
    await insert(10, 20);
  });
  it("rial_balance rejects values outside the exact-integer range", async () => {
    await expect(insert(1, null, "9007199254740992")).rejects.toSatisfy((e) => pgCode(e) === "23514");
    await expect(insert(1, null, "-9007199254740992")).rejects.toSatisfy((e) => pgCode(e) === "23514");
  });
  it("TypeScript and SQL limits are identical (kept in sync)", async () => {
    const defs = await t.pool.query(
      "select conname, pg_get_constraintdef(oid) as def from pg_constraint where conname in ('rial_amount_range','rial_price_range','rial_balance_range')",
    );
    const byName = Object.fromEntries(defs.rows.map((r: { conname: string; def: string }) => [r.conname, r.def]));
    const numbers = (def: string) => (def.match(/-?\d{4,}/g) ?? []).map(Number);
    expect(numbers(byName.rial_amount_range ?? '')).toContain(MAX_RIAL_AMOUNT);
    expect(numbers(byName.rial_price_range ?? '')).toContain(MAX_RIAL_AMOUNT);
    expect(numbers(byName.rial_balance_range ?? '')).toEqual(expect.arrayContaining([MAX_RIAL_AGGREGATE, -MAX_RIAL_AGGREGATE]));
  });
});

describe("Drizzle money column types", () => {
  const probe = pgTable("money_probe2", {
    label: text("label"),
    amount: rialAmount("amount").notNull(),
    price: rialPriceColumn("price"),
    balance: rialBalance("balance"),
  });

  beforeAll(async () => {
    await t.pool.query("create table money_probe2 (label text, amount rial_amount not null, price rial_price, balance rial_balance)");
  });

  it("round-trips Rial values as numbers", async () => {
    await t.db.insert(probe).values({ label: "a", amount: rial(1_234_560), price: rial(1_234_560), balance: rial(5) });
    const rows = await t.db.select().from(probe);
    expect(rows[0]?.amount).toBe(1_234_560);
    expect(typeof rows[0]?.amount).toBe("number");
    expect(rows[0]?.balance).toBe(5);
  });
  it("validates before the database is reached", async () => {
    await expect(t.db.insert(probe).values({ label: "b", amount: 1.5 as never })).rejects.toSatisfy(
      (e) => (e as { cause?: unknown }).cause instanceof DomainError || e instanceof DomainError,
    );
    await expect(t.db.insert(probe).values({ label: "c", amount: rial(10), price: 15 as never })).rejects.toBeTruthy();
    expect((await t.db.select().from(probe)).length).toBe(1);
  });
});
