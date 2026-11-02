/**
 * SmsProvider port (X2: no real provider selected). Implementations must never log message bodies.
 * Outcome semantics matter for OTP safety:
 *  - resolves ACCEPTED: the provider took the message.
 *  - resolves REJECTED: DEFINITIVE failure, nothing was sent (callers may mark the challenge unusable).
 *  - THROWS: outcome UNKNOWN (timeout, network) — the code may have been delivered, callers must not
 *    invalidate it and should allow a safe resend instead.
 */
export type SmsSendResult = { status: "ACCEPTED" } | { status: "REJECTED" };

export interface SmsMessage {
  /** E.164 destination. */
  to: string;
  text: string;
}

export interface SmsProvider {
  readonly kind: string;
  send(message: SmsMessage): Promise<SmsSendResult>;
}

import { DomainError } from "../errors";

/** Fail-closed provider used when SMS_PROVIDER=none (the only value accepted in production until X2). */
export class NullSmsProvider implements SmsProvider {
  readonly kind = "none";
  async send(): Promise<SmsSendResult> {
    throw new DomainError("SMS_PROVIDER_NOT_CONFIGURED", "no SMS provider is configured");
  }
}
