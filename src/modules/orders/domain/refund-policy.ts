import type { DisclosureStateName, RefundDecision } from "./types";

/**
 * Refund policy evaluation. The RULES are data (tables refund_policy_versions / refund_policy_rules, versioned); this function only applies
 * them. The active version 'temporary-0' holds the documented SAFE PLACEHOLDERS (B12, legal review pending). It contains no deadlines, fees or
 * partial-refund logic — those do not exist and must not be invented here.
 */
const STRICTNESS: Record<RefundDecision, number> = { ELIGIBLE: 0, REVIEW_REQUIRED: 1, OVERRIDE_REQUIRED: 2, DENIED: 3 };

export function evaluateRefundPolicy(rules: ReadonlyMap<DisclosureStateName, RefundDecision>, states: readonly DisclosureStateName[]): RefundDecision {
  let worst: RefundDecision = "ELIGIBLE";
  for (const s of states) {
    const d = rules.get(s);
    if (!d) return "DENIED"; // a state without a rule is never refundable (fail closed)
    if (STRICTNESS[d] > STRICTNESS[worst]) worst = d;
  }
  return worst;
}

const DISCLOSURE_ORDER: DisclosureStateName[] = ["NOT_DELIVERED", "DELIVERED_UNREVEALED", "REVEALED_BY_ADMIN_ONLY", "REVEALED_BY_CUSTOMER"];
/** The most disclosed state among the units of one item. */
export function worstDisclosure(states: readonly DisclosureStateName[]): DisclosureStateName {
  return states.reduce((a, b) => (DISCLOSURE_ORDER.indexOf(b) > DISCLOSURE_ORDER.indexOf(a) ? b : a), "NOT_DELIVERED" as DisclosureStateName);
}
