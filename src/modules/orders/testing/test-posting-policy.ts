import { recordAudit } from "@/modules/audit";
import type { Tx } from "@/platform/db";
import type { OrderPaymentPostingPolicy, OrderPostingRequest, OrderPostingResult } from "../domain/types";

/**
 * TEST DOUBLE — NOT an accounting policy and never used in production code. It books NOTHING in the ledger (no account is chosen,
 * D10 stays open); it only records the call and writes a marker audit row so tests can prove the call happens inside the
 * settlement transaction and rolls back with it.
 */
export class TestPostingPolicy implements OrderPaymentPostingPolicy {
  readonly configured = true;
  readonly calls: OrderPostingRequest[] = [];
  /** Throw AFTER the marker was written, to prove everything rolls back. */
  failAfterMarker = false;

  async postOrderPayment(tx: Tx, req: OrderPostingRequest): Promise<OrderPostingResult> {
    this.calls.push(req);
    await recordAudit(tx, { actor: { type: "SYSTEM", id: "system:test-policy" }, action: "orders.test_policy.posted", entity: { type: "order", id: req.orderId }, metadata: { method: req.method, fromSuspense: req.fromSuspense }, occurredAt: new Date() });
    if (this.failAfterMarker) throw new Error("injected failure after posting");
    return { ledgerTransactionId: null };
  }
}
