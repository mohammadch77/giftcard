import { describe, expect, it } from "vitest";
import { ManualClock } from "@/platform/clock/testing";
import { systemClock } from "@/platform/clock";
import { ORDER_NUMBER_PATTERN, generateOrderNumber, isUuid, uuidv7, uuidv7Timestamp } from "@/platform/ids";

describe("uuidv7", () => {
  it("has version 7 and RFC variant bits, and embeds the clock time", () => {
    const clock = new ManualClock("2026-05-06T07:08:09.123Z");
    const id = uuidv7(clock);
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe("7");
    expect("89ab").toContain(id[19] as string);
    expect(uuidv7Timestamp(id)).toBe(Date.parse("2026-05-06T07:08:09.123Z"));
  });
  it("is strictly increasing even when 10,000 ids are requested in the same millisecond or the clock goes back", () => {
    const clock = new ManualClock("2030-01-01T00:00:00.000Z");
    const ids: string[] = [];
    for (let i = 0; i < 10_000; i++) ids.push(uuidv7(clock));
    clock.set("2029-12-31T23:59:59.000Z"); // clock moves backwards
    for (let i = 0; i < 100; i++) ids.push(uuidv7(clock));
    for (let i = 1; i < ids.length; i++) expect((ids[i] as string) > (ids[i - 1] as string)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("orders by time across milliseconds", () => {
    const clock = new ManualClock("2031-01-01T00:00:00.000Z");
    const a = uuidv7(clock);
    clock.advance(5);
    const b = uuidv7(clock);
    expect(b > a).toBe(true);
  });
  it("rejects non-v7 ids for timestamp extraction", () => {
    expect(() => uuidv7Timestamp("00000000-0000-4000-8000-000000000000")).toThrow();
  });
});

describe("order numbers", () => {
  it("match the pattern, avoid look-alike characters and are unique over 50,000 draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50_000; i++) {
      const n = generateOrderNumber();
      expect(n).toMatch(ORDER_NUMBER_PATTERN);
      expect(n).not.toMatch(/[01OIL]/);
      seen.add(n);
    }
    expect(seen.size).toBe(50_000);
  });
  it("uses the whole alphabet (no obvious bias)", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 20_000; i++) for (const ch of generateOrderNumber().replace("-", "")) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(31);
    const values = [...counts.values()];
    expect(Math.max(...values) / Math.min(...values)).toBeLessThan(1.15);
  });
});

describe("clock", () => {
  it("ManualClock advances only when told to", () => {
    const c = new ManualClock("2026-01-01T00:00:00.000Z");
    expect(c.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    c.advance(1500);
    expect(c.now().toISOString()).toBe("2026-01-01T00:00:01.500Z");
    expect(() => c.advance(-1)).toThrow();
  });
  it("systemClock returns real time", () => {
    expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(1000);
  });
});
