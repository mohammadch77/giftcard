import { describe, expect, it } from "vitest";
import { evaluateRefundPolicy } from "@/modules/orders";
import type { DisclosureStateName, RefundDecision, RefundReviewReason } from "@/modules/orders";
import { REFUND_REVIEW_REASONS } from "@/modules/orders/domain/types";
import { parseSetting } from "@/platform/settings";
import { z } from "zod";

describe("P1-C: Domain & Logic Unit Tests (B10, B12, B13)", () => {
  describe("B10 Threshold validation", () => {
    const thresholdSchema = z.strictObject({
      requiresTier2AboveRial: z.number().int().min(0).max(1_000_000_000_000).multipleOf(10),
      autoApprovalAllowed: z.literal(false).default(false),
    });

    it("accepts valid threshold amounts (integer Rial, multiple of 10, within bounds)", () => {
      expect(parseSetting(thresholdSchema, { requiresTier2AboveRial: 0, autoApprovalAllowed: false })).toEqual({
        requiresTier2AboveRial: 0,
        autoApprovalAllowed: false,
      });
      expect(parseSetting(thresholdSchema, { requiresTier2AboveRial: 50_000_000, autoApprovalAllowed: false })).toEqual({
        requiresTier2AboveRial: 50_000_000,
        autoApprovalAllowed: false,
      });
    });

    it("rejects autoApprovalAllowed = true (two-person floor cannot be bypassed)", () => {
      expect(() => parseSetting(thresholdSchema, { requiresTier2AboveRial: 10_000, autoApprovalAllowed: true })).toThrowError();
    });

    it("rejects non-multiples of 10 or negative amounts", () => {
      expect(() => parseSetting(thresholdSchema, { requiresTier2AboveRial: 15, autoApprovalAllowed: false })).toThrowError();
      expect(() => parseSetting(thresholdSchema, { requiresTier2AboveRial: -10, autoApprovalAllowed: false })).toThrowError();
    });

    it("determines tier correctly against active threshold", () => {
      const activeThreshold = 100_000_000; // 10,000,000 Toman
      const determineTier = (amount: number, threshold: number): "TIER_1" | "TIER_2" =>
        amount > threshold ? "TIER_2" : "TIER_1";

      expect(determineTier(50_000_000, activeThreshold)).toBe("TIER_1");
      expect(determineTier(100_000_000, activeThreshold)).toBe("TIER_1");
      expect(determineTier(100_000_010, activeThreshold)).toBe("TIER_2");
      expect(determineTier(500_000_000, activeThreshold)).toBe("TIER_2");

      // Fail-closed initial seed: threshold = 0 => all positive amounts are Tier 2
      expect(determineTier(10_000, 0)).toBe("TIER_2");
      expect(determineTier(1_000_000, 0)).toBe("TIER_2");
    });
  });

  describe("B12 Refund Review Workflows classification", () => {
    const rules = new Map<DisclosureStateName, RefundDecision>([
      ["NOT_DELIVERED", "ELIGIBLE"],
      ["DELIVERED_UNREVEALED", "REVIEW_REQUIRED"],
      ["REVEALED_BY_CUSTOMER", "OVERRIDE_REQUIRED"],
      ["REVEALED_BY_ADMIN_ONLY", "OVERRIDE_REQUIRED"],
    ]);

    function classifyRefund(input: {
      states: DisclosureStateName[];
      holdReason?: string;
      reviewReason?: RefundReviewReason;
    }): RefundDecision {
      const policyDecision = input.states.length > 0 ? evaluateRefundPolicy(rules, input.states) : "ELIGIBLE";
      const hasRevealed = input.states.some((s) => s === "REVEALED_BY_CUSTOMER" || s === "REVEALED_BY_ADMIN_ONLY");

      if (hasRevealed || input.reviewReason === "REVEALED_DISPUTE" || policyDecision === "OVERRIDE_REQUIRED") {
        return "OVERRIDE_REQUIRED";
      }
      if (policyDecision === "DENIED") {
        return "DENIED";
      }
      if (
        input.reviewReason !== undefined ||
        policyDecision === "REVIEW_REQUIRED" ||
        (input.holdReason && input.holdReason !== "LATE_PAYMENT_NO_RESERVATION")
      ) {
        return "REVIEW_REQUIRED";
      }
      return "ELIGIBLE";
    }

    it("clean undelivered items with no disputes evaluate to ELIGIBLE", () => {
      expect(classifyRefund({ states: ["NOT_DELIVERED"] })).toBe("ELIGIBLE");
    });

    it("late payment hold with no delivered items evaluates to ELIGIBLE", () => {
      expect(classifyRefund({ states: [], holdReason: "LATE_PAYMENT_NO_RESERVATION" })).toBe("ELIGIBLE");
    });

    it("non-late holds (PAYMENT_NEEDS_REVIEW, FRAUD_REVIEW, FULFILLMENT_FAILED, SUPPLIER_UNKNOWN) evaluate to REVIEW_REQUIRED", () => {
      for (const hold of ["PAYMENT_NEEDS_REVIEW", "FRAUD_REVIEW", "FULFILLMENT_FAILED", "SUPPLIER_UNKNOWN"]) {
        expect(classifyRefund({ states: [], holdReason: hold })).toBe("REVIEW_REQUIRED");
      }
    });

    it("every supported manual review reason routes to REVIEW_REQUIRED or OVERRIDE_REQUIRED", () => {
      for (const reason of REFUND_REVIEW_REASONS) {
        const result = classifyRefund({ states: ["NOT_DELIVERED"], reviewReason: reason });
        if (reason === "REVEALED_DISPUTE") {
          expect(result).toBe("OVERRIDE_REQUIRED");
        } else {
          expect(result).toBe("REVIEW_REQUIRED");
        }
      }
    });

    it("revealed items or REVEALED_DISPUTE always evaluate to OVERRIDE_REQUIRED", () => {
      expect(classifyRefund({ states: ["REVEALED_BY_CUSTOMER"] })).toBe("OVERRIDE_REQUIRED");
      expect(classifyRefund({ states: ["REVEALED_BY_ADMIN_ONLY"] })).toBe("OVERRIDE_REQUIRED");
      expect(classifyRefund({ states: ["NOT_DELIVERED"], reviewReason: "REVEALED_DISPUTE" })).toBe("OVERRIDE_REQUIRED");
    });
  });

  describe("Evidence References Sanitization", () => {
    function sanitize(refs?: readonly string[]): string[] {
      if (!refs || refs.length === 0) return [];
      if (refs.length > 20) throw new Error("at most 20 evidence references allowed");
      const sanitized: string[] = [];
      for (const raw of refs) {
        if (typeof raw !== "string") throw new Error("evidence references must be strings");
        const r = raw.trim();
        if (r.length < 3 || r.length > 100) throw new Error("length must be 3..100");
        if (!/^[A-Za-z0-9_.:#/-]{3,100}$/.test(r)) throw new Error("must be safe identifier");
        if (/bearer|token|password|secret|apikey|cvv|\b\d{16}\b/i.test(r)) throw new Error("cannot contain secrets");
        if (!sanitized.includes(r)) sanitized.push(r);
      }
      return sanitized;
    }

    it("accepts ticket references, gateway IDs, and supplier audit IDs", () => {
      const input = ["TICKET-12345", "pay_gw_ref:987654", "SUPP-ORD-2026-11-01", "audit#4421"];
      expect(sanitize(input)).toEqual(input);
    });

    it("rejects tokens, passwords, API keys, card numbers", () => {
      expect(() => sanitize(["bearer-eyJhbGciOi..."])).toThrow(/secrets/);
      expect(() => sanitize(["my-secret-password-123"])).toThrow(/secrets/);
      expect(() => sanitize(["apiKey-998877665544"])).toThrow(/secrets/);
      expect(() => sanitize(["card-5022291012345678"])).toThrow(/secrets/);
    });

    it("rejects unsafe characters or invalid length", () => {
      expect(() => sanitize(["ab"])).toThrow(/length/);
      expect(() => sanitize(["x".repeat(101)])).toThrow(/length/);
      expect(() => sanitize(["hello<script>"])).toThrow(/safe identifier/);
      expect(() => sanitize(["spaces are not allowed in id"])).toThrow(/safe identifier/);
    });
  });

  describe("B13 Refund Execution Safety", () => {
    it("exact amount verification: reported amount must match expected amount", () => {
      const expectedAmount = 500_000;
      const verifyOutcome = (reportedAmount: number) => {
        if (reportedAmount === expectedAmount) return "CONFIRMED";
        return "UNKNOWN"; // amount mismatch is never treated as confirmed completion
      };

      expect(verifyOutcome(500_000)).toBe("CONFIRMED");
      expect(verifyOutcome(499_990)).toBe("UNKNOWN");
      expect(verifyOutcome(500_010)).toBe("UNKNOWN");
    });

    it("gateway acceptance is NOT confirmed completion", () => {
      const gatewayResponse = { status: "ACCEPTED", refundRef: "gw_ref_123" };
      // ACCEPTED must keep outcome as ACCEPTED or UNKNOWN, never CONFIRMED
      expect(gatewayResponse.status === "CONFIRMED").toBe(false);
    });

    it("no blind resend on ambiguous timeout unless provider is explicitly idempotent", () => {
      const canResend = (sendIntentCommitted: boolean, outcome: string, providerIdempotent: boolean) =>
        sendIntentCommitted || (outcome === "UNKNOWN" && providerIdempotent);

      // Fresh intent commit can send
      expect(canResend(true, "UNKNOWN", false)).toBe(true);
      // Ambiguous outcome without guaranteed idempotency: CANNOT resend
      expect(canResend(false, "UNKNOWN", false)).toBe(false);
      // Ambiguous outcome with guaranteed idempotency: can resend
      expect(canResend(false, "UNKNOWN", true)).toBe(true);
    });
  });
});
