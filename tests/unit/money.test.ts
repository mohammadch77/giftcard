import { describe, expect, it } from "vitest";
import { DomainError } from "@/platform/errors";
import {
  MAX_RIAL_AGGREGATE, MAX_RIAL_AMOUNT, ZERO_RIAL, addRial, basisPointsFloor, compareRial, floorToToman, formatToman,
  isMultipleOfTen, mulDivFloor, mulRial, percentFloor, rial, rialAggregate, rialPrice, rialToToman, subRial, sumRial, tomanToRial,
} from "@/platform/money";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof DomainError ? e.code : "OTHER";
  }
  return "NO_ERROR";
};

describe("rial() guard", () => {
  it("accepts integers in range including both bounds", () => {
    expect(rial(0)).toBe(0);
    expect(rial(MAX_RIAL_AMOUNT)).toBe(MAX_RIAL_AMOUNT);
  });
  it.each([0.5, 1.1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, 2 ** 53])("rejects non-safe-integer %s", (v) => {
    expect(code(() => rial(v))).toBe("RIAL_INVALID");
  });
  it("rejects negatives and amounts above the ceiling", () => {
    expect(code(() => rial(-1))).toBe("RIAL_OUT_OF_RANGE");
    expect(code(() => rial(MAX_RIAL_AMOUNT + 1))).toBe("RIAL_OUT_OF_RANGE");
  });
  it("rejects non-numbers at runtime", () => {
    expect(code(() => rial("100" as unknown as number))).toBe("RIAL_INVALID");
    expect(code(() => rial(10n as unknown as number))).toBe("RIAL_INVALID");
  });
  it("aggregates allow up to MAX_SAFE_INTEGER", () => {
    expect(rialAggregate(MAX_RIAL_AGGREGATE)).toBe(MAX_RIAL_AGGREGATE);
    expect(code(() => rialAggregate(MAX_RIAL_AGGREGATE + 1))).toBe("RIAL_INVALID");
  });
});

describe("prices", () => {
  it("must be multiples of 10 Rial", () => {
    expect(rialPrice(1_000_000)).toBe(1_000_000);
    expect(code(() => rialPrice(1_000_005))).toBe("RIAL_NOT_TOMAN_EXACT");
    expect(isMultipleOfTen(0)).toBe(true);
    expect(isMultipleOfTen(15)).toBe(false);
  });
});

describe("integer arithmetic", () => {
  it("adds, subtracts and sums exactly", () => {
    expect(addRial(rial(1), rial(2))).toBe(3);
    expect(subRial(rial(5), rial(5))).toBe(0);
    expect(sumRial([rial(1), rial(2), rial(3)])).toBe(6);
    expect(sumRial([])).toBe(ZERO_RIAL);
  });
  it("never produces negatives or leaves the safe range", () => {
    expect(code(() => subRial(rial(1), rial(2)))).toBe("RIAL_OUT_OF_RANGE");
    expect(code(() => addRial(rialAggregate(MAX_RIAL_AGGREGATE), rial(1)))).toBe("RIAL_OUT_OF_RANGE");
  });
  it("0.1 + 0.2 style float traps are impossible (floats are rejected)", () => {
    expect(code(() => addRial(0.1 as never, 0.2 as never))).toBe("RIAL_INVALID");
  });
  it("mulRial is exact and bounded", () => {
    expect(mulRial(rial(1_234_560), 3)).toBe(3_703_680);
    expect(mulRial(rial(MAX_RIAL_AMOUNT), 900)).toBe(9_000_000_000_000_000);
    expect(code(() => mulRial(rial(MAX_RIAL_AMOUNT), 901))).toBe("RIAL_OUT_OF_RANGE");
    expect(code(() => mulRial(rial(1), -1))).toBe("RIAL_INVALID");
    expect(code(() => mulRial(rial(1), 1.5))).toBe("RIAL_INVALID");
  });
  it("compares", () => {
    expect(compareRial(rial(1), rial(2))).toBe(-1);
    expect(compareRial(rial(2), rial(2))).toBe(0);
    expect(compareRial(rial(3), rial(2))).toBe(1);
  });
});

describe("percentage rounding: always floor, exact", () => {
  it.each([
    [1_000_000, 15, 150_000],
    [999, 10, 99], // 99.9 -> 99
    [1, 99, 0],
    [123_456_789, 33, 40_740_740], // 40_740_740.37
    [MAX_RIAL_AMOUNT, 100, MAX_RIAL_AMOUNT],
    [MAX_RIAL_AMOUNT, 99, 9_900_000_000_000],
  ])("percentFloor(%s, %s%%) = %s", (amount, pct, expected) => {
    expect(percentFloor(rial(amount), pct)).toBe(expected);
  });
  it("is exact where double arithmetic would drift (large amount x basis points)", () => {
    // 9_999_999_999_999 * 3333 / 10000 = 3_332_999_999_999.6667 -> floor
    expect(basisPointsFloor(rial(9_999_999_999_999), 3333)).toBe(3_332_999_999_999);
    expect(mulDivFloor(rial(MAX_RIAL_AMOUNT), 1, 3)).toBe(3_333_333_333_333);
  });
  it("validates ratio inputs", () => {
    expect(code(() => percentFloor(rial(100), 101))).toBe("RIAL_INVALID");
    expect(code(() => percentFloor(rial(100), -1))).toBe("RIAL_INVALID");
    expect(code(() => percentFloor(rial(100), 12.5))).toBe("RIAL_INVALID");
    expect(code(() => mulDivFloor(rial(100), 1, 0))).toBe("RIAL_INVALID");
  });
  it("floorToToman rounds down to a multiple of 10", () => {
    expect(floorToToman(rial(99))).toBe(90);
    expect(floorToToman(rial(100))).toBe(100);
    expect(floorToToman(rial(0))).toBe(0);
  });
  it("a property check over 20,000 seeded random cases: result == BigInt reference, never above the exact value", () => {
    let seed = 123456789;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff);
    for (let i = 0; i < 20_000; i++) {
      const amount = (next() * 4_657) % MAX_RIAL_AMOUNT;
      const pct = next() % 101;
      const got = percentFloor(rial(amount), pct);
      const ref = (BigInt(amount) * BigInt(pct)) / 100n;
      expect(BigInt(got)).toBe(ref);
      expect(got <= (amount * pct) / 100 + 1e-6).toBe(true);
    }
  });
});

describe("Rial <-> Toman (the only place the units meet)", () => {
  it("converts exactly in both directions", () => {
    expect(rialToToman(rial(12_340))).toBe(1_234);
    expect(tomanToRial(1_234)).toBe(12_340);
    expect(rialToToman(tomanToRial(987_654_321))).toBe(987_654_321);
    expect(rialToToman(rial(0))).toBe(0);
  });
  it("refuses inexact or invalid conversions", () => {
    expect(code(() => rialToToman(rial(15)))).toBe("RIAL_NOT_TOMAN_EXACT");
    expect(code(() => tomanToRial(-1))).toBe("RIAL_INVALID");
    expect(code(() => tomanToRial(1.5))).toBe("RIAL_INVALID");
    expect(code(() => tomanToRial(MAX_RIAL_AGGREGATE))).toBe("RIAL_OUT_OF_RANGE");
  });
  it("formats Toman with Persian digits (fa-IR) and Latin digits (en-US)", () => {
    expect(formatToman(rial(12_345_600))).toMatch(/^[۰-۹٬,٬\s]+ تومان$/u);
    expect(formatToman(rial(12_345_600))).toContain("۱");
    expect(formatToman(rial(12_345_600), "en-US")).toBe("1,234,560 Toman");
    expect(code(() => formatToman(rial(5)))).toBe("RIAL_NOT_TOMAN_EXACT");
  });
});
