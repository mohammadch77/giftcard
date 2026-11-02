import { DomainError } from "../errors";

/**
 * PaymentGateway port (decision D4/X1: NO gateway is selected). This interface is a HYPOTHESIS that must be
 * revisited against the chosen gateway's official documentation before any real adapter is written; it contains
 * nothing gateway-specific (no endpoints, signatures, refund or unit assumptions beyond: amounts are integer Rial).
 *
 * Outcome semantics (they drive the payment state machine):
 *  createPayment: CREATED / REJECTED (definitive, nothing was created) / THROWS = unknown outcome (retry is safe:
 *                 `paymentId` is the idempotency reference the adapter must pass to the gateway).
 *  verifyPayment: PAID / FAILED are definitive server-to-server answers; UNKNOWN or a thrown error = no answer
 *                 (never a failure; the payment stays VERIFYING and is retried).
 * Adapters must never log request/response bodies (they may contain payer data).
 */
export interface GatewayCreateRequest {
  paymentId: string;
  /** Integer Rial. */
  amount: number;
  description?: string;
}
export type GatewayCreateResult = { status: "CREATED"; gatewayRef: string; redirectUrl?: string } | { status: "REJECTED" };

export interface GatewayVerifyRequest {
  gatewayRef: string;
}
export type GatewayVerifyReply = { status: "PAID" | "FAILED" | "UNKNOWN"; gatewayRef: string; /** Integer Rial actually captured. */ amount?: number };

export interface PaymentGateway {
  /** Stable key stored in payments.gateway (e.g. 'test'). */
  readonly key: string;
  createPayment(req: GatewayCreateRequest): Promise<GatewayCreateResult>;
  verifyPayment(req: GatewayVerifyRequest): Promise<GatewayVerifyReply>;
}

/** Fail-closed gateway used when PAYMENT_GATEWAY=none (the only value accepted in production until X1). */
export class NullPaymentGateway implements PaymentGateway {
  readonly key = "none";
  async createPayment(): Promise<GatewayCreateResult> {
    throw new DomainError("PAYMENT_GATEWAY_NOT_CONFIGURED", "no payment gateway is configured");
  }
  async verifyPayment(): Promise<GatewayVerifyReply> {
    throw new DomainError("PAYMENT_GATEWAY_NOT_CONFIGURED", "no payment gateway is configured");
  }
}
