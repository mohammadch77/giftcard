/**
 * Typed domain errors with stable machine-readable codes.
 * Messages must never embed secrets, codes, tokens or payloads (see SECURITY.md).
 */
export type DomainErrorCode =
  | "RIAL_INVALID"
  | "RIAL_OUT_OF_RANGE"
  | "RIAL_NOT_TOMAN_EXACT"
  | "INVALID_TRANSITION"
  | "TRANSITION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_KEY_INVALID"
  | "OUTBOX_LEASE_LOST"
  | "KEY_PROVIDER_NOT_CONFIGURED"
  | "KEY_PROVIDER_FORBIDDEN"
  | "KEY_UNAVAILABLE"
  | "KEY_VERSION_UNKNOWN"
  | "DECRYPT_FAILED"
  | "SEALED_FORMAT_INVALID"
  | "LEDGER_INVALID"
  | "LEDGER_UNBALANCED"
  | "LEDGER_ACCOUNT_NOT_FOUND"
  | "LEDGER_ACCOUNT_CONFLICT"
  | "LEDGER_REVERSAL_INVALID"
  | "INSUFFICIENT_FUNDS"
  | "AUDIT_INVALID"
  | "INVALID_ARGUMENT"
  | "SMS_PROVIDER_NOT_CONFIGURED"
  | "SMS_PROVIDER_FORBIDDEN"
  | "PHONE_INVALID"
  | "AUTH_UNAUTHENTICATED"
  | "AUTH_FORBIDDEN"
  | "AUTH_MFA_REQUIRED"
  | "AUTH_STEP_UP_REQUIRED"
  | "IDENTITY_CONFLICT"
  | "IDENTITY_NOT_FOUND"
  | "MFA_STATE_INVALID"
  | "RECOVERY_INVALID";

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DomainError";
    this.code = code;
  }
}

export function isDomainError(value: unknown, code?: DomainErrorCode): value is DomainError {
  return value instanceof DomainError && (code === undefined || value.code === code);
}
