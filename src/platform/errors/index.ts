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
  | "INVALID_ARGUMENT";

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
