import type { GatewayCapabilities, GatewayRefundRequest, GatewayRefundResult, GatewayRefundVerifyReply, GatewayRefundVerifyRequest, GatewayCreateRequest, GatewayCreateResult, GatewayVerifyReply, GatewayVerifyRequest, PaymentGateway } from "../index";

/**
 * TEST DOUBLE — must never be imported by production code (only src/platform/composition may bridge).
 * Scriptable: success, failure, amount mismatch, timeouts, slow replies, duplicate calls.
 */
export type VerifyScript = { status: "PAID" | "FAILED" | "UNKNOWN"; amount?: number } | "THROW";

export class TestPaymentGateway implements PaymentGateway {
  readonly key = "test";
  capabilities: GatewayCapabilities = { refund: true, refundIdempotent: false };
  /** Refund scripting: how the refund REQUEST behaves, and what a later status query says. */
  refundMode: "accept" | "reject" | "throw" = "accept";
  refundVerify: GatewayRefundVerifyReply["status"] | "THROW" = "REFUNDED";
  refundVerifyAmount: number | undefined;
  readonly refundCalls: GatewayRefundRequest[] = [];
  refundVerifyCalls = 0;
  readonly created: GatewayCreateRequest[] = [];
  verifyCalls = 0;
  createMode: "ok" | "reject" | "throw" = "ok";
  /** Delay applied to every verify call (lets tests overlap callbacks). */
  verifyDelayMs = 0;
  private readonly scripts = new Map<string, VerifyScript>();
  private seq = 0;

  script(gatewayRef: string, s: VerifyScript): void {
    this.scripts.set(gatewayRef, s);
  }

  async createPayment(req: GatewayCreateRequest): Promise<GatewayCreateResult> {
    if (this.createMode === "throw") throw new Error("simulated unknown create failure");
    if (this.createMode === "reject") return { status: "REJECTED" };
    this.created.push(req);
    // Idempotent by paymentId, like a real adapter must be.
    const existing = this.created.findIndex((c) => c.paymentId === req.paymentId);
    const ref = `tg-${req.paymentId.slice(-8)}-${existing >= 0 ? existing : ++this.seq}`;
    return { status: "CREATED", gatewayRef: ref, redirectUrl: `https://gateway.invalid/pay/${ref}` };
  }

  async verifyPayment(req: GatewayVerifyRequest): Promise<GatewayVerifyReply> {
    this.verifyCalls++;
    if (this.verifyDelayMs > 0) await new Promise((r) => setTimeout(r, this.verifyDelayMs));
    const s = this.scripts.get(req.gatewayRef);
    if (s === "THROW") throw new Error("simulated verify timeout");
    if (!s) return { status: "UNKNOWN", gatewayRef: req.gatewayRef };
    return { status: s.status, gatewayRef: req.gatewayRef, ...(s.amount !== undefined ? { amount: s.amount } : {}) };
  }

  async refundPayment(req: GatewayRefundRequest): Promise<GatewayRefundResult> {
    this.refundCalls.push(req);
    if (this.refundMode === "throw") throw new Error("simulated unknown refund failure");
    if (this.refundMode === "reject") return { status: "REJECTED" };
    return { status: "ACCEPTED", refundRef: `rf-${req.refundId.slice(-8)}` };
  }

  async verifyRefund(req: GatewayRefundVerifyRequest): Promise<GatewayRefundVerifyReply> {
    this.refundVerifyCalls++;
    if (this.refundVerify === "THROW") throw new Error("simulated verify timeout");
    const amount = this.refundVerifyAmount ?? this.refundCalls.find((c) => c.refundId === req.refundId)?.amount;
    return { status: this.refundVerify, ...(amount !== undefined ? { amount } : {}) };
  }
}
