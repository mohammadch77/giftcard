import { describe, expect, it } from "vitest";
import { canonicalJson, hashRequest } from "@/platform/idempotency";

describe("canonical request hashing", () => {
  it("is independent of key order and ignores undefined", () => {
    expect(hashRequest({ a: 1, b: { y: 2, x: 1 } })).toBe(hashRequest({ b: { x: 1, y: 2 }, a: 1, z: undefined }));
  });
  it("differs when any value differs", () => {
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
    expect(hashRequest([1, 2])).not.toBe(hashRequest([2, 1]));
    expect(hashRequest({ a: "1" })).not.toBe(hashRequest({ a: 1 }));
  });
  it("produces a 64-char hex digest", () => {
    expect(hashRequest({})).toMatch(/^[0-9a-f]{64}$/);
  });
  it("rejects values that cannot be represented stably", () => {
    expect(() => canonicalJson({ a: NaN })).toThrow();
    expect(() => canonicalJson({ a: 1n })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
  });
});
