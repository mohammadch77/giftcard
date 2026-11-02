import { adminWalletDebit, ensureAccount, gatewayReceivable, post, systemAccount, walletAccount } from "@/modules/ledger";
import type { Tx } from "@/platform/db";
import type { OrderPaymentPostingPolicy, OrderPostingRequest, OrderPostingResult } from "../domain/types";

/**
 * TEST DOUBLE — NOT an accounting policy (D10 stays open) and never used in production code. Unlike TestPostingPolicy it books a
 * BALANCED placeholder posting using the existing ADJUSTMENT_EXPENSE account purely so that tests can exercise exact-mirror
 * reversals. Which accounts the real policy uses is the accountant's decision.
 */
export class TestBookingPolicy implements OrderPaymentPostingPolicy {
  readonly configured = true;
  async postOrderPayment(tx: Tx, req: OrderPostingRequest): Promise<OrderPostingResult> {
    const actor = { type: "SYSTEM" as const, id: "system:test-booking-policy" };
    const debit = req.fromSuspense ? systemAccount("SUSPENSE_UNRESOLVED_RECEIPTS") : req.method === "WALLET" ? walletAccount(req.userRef) : gatewayReceivable(req.gatewayKey ?? "test");
    await ensureAccount(tx, debit, actor);
    await ensureAccount(tx, systemAccount("ADJUSTMENT_EXPENSE"), actor);
    const entries = adminWalletDebit({ userId: req.userRef, amount: req.amount }).map((e) => (e.side === "DEBIT" ? { ...e, account: debit } : e));
    const r = await post(tx, { kind: "TEST_ORDER_PAYMENT", idempotencyKey: `testpay:${req.orderId}`, reference: { type: "order", id: req.orderId }, entries, description: "test placeholder posting", actor });
    return { ledgerTransactionId: r.transactionId };
  }
}
