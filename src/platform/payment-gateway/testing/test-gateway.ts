import type { GatewayCreateRequest, GatewayCreateResult, GatewayVerifyReply, GatewayVerifyRequest, PaymentGateway } from "../index";

/**
 * TEST DOUBLE — must never be imported by production code (only src/platform/composition may bridge).
 * Scriptable: success, failure, amount mismatch, timeouts, slow replies, duplicate calls.
 */
export type VerifyScript = { status: "PAID" | "FAILED" | "UNKNOWN"; amount?: number } | "THROW";

export class TestPaymentGateway implements PaymentGateway {
  readonly key = "test";
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
}
