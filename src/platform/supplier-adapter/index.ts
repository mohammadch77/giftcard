import { DomainError } from "../errors";

/**
 * SupplierAdapter port (decision X3: NO supplier and NO supplier documentation exist). This contract is a HYPOTHESIS:
 * it contains no endpoints, no authentication scheme and no wire format. A real adapter must be written against that
 * supplier's official documentation, must live in its own file, and must map the supplier's behaviour onto these outcomes:
 *
 *  submitOrder: CONFIRMED / REJECTED are explicit supplier answers. Any other end (timeout, 5xx, connection loss, malformed
 *               reply, thrown error) is an UNKNOWN outcome — the supplier may have executed the purchase. The only exception
 *               is `SupplierNotSentError`: the adapter PROVES nothing was transmitted (e.g. configuration error).
 *  queryOrder:  only meaningful when capabilities.statusQuery. NOT_FOUND is not proof of "never executed" unless the
 *               supplier documents it.
 *  Capabilities are explicit and never assumed. `idempotentSubmit` = the supplier documents that re-sending the same
 *  idempotency key returns the original result and never creates a second purchase.
 * Adapters must never log request/response bodies or credentials.
 */
export interface SupplierCapabilities {
  idempotentSubmit: boolean;
  statusQuery: boolean;
  deliversCodes: boolean;
}

/** Opaque, decrypted only for the duration of one call. Never persisted, logged or returned. */
export type SupplierCredentials = Readonly<Record<string, string>>;

export interface SupplierProductInfo {
  externalSku: string;
  name: string;
  /** Integer Rial. Adapters must not convert currencies; anything else is rejected during sync. */
  cost: number;
  currency: string;
  available: boolean;
  stockHint?: number;
}

export type SupplierRejectReason = "OUT_OF_STOCK" | "PRICE_CHANGED" | "INVALID_PRODUCT" | "INSUFFICIENT_BALANCE" | "OTHER";

export interface SubmitRequest {
  /** Fixed before the first send and reused on every retry of the same purchase. */
  idempotencyKey: string;
  externalSku: string;
  quantity: number;
  credentials: SupplierCredentials;
}
export type SubmitReply =
  | { status: "CONFIRMED"; externalRef: string; /** Codes/accounts when the supplier returns them. */ deliverables?: readonly string[] }
  | { status: "REJECTED"; reason: SupplierRejectReason };

export interface QueryRequest {
  idempotencyKey: string;
  externalRef?: string;
  credentials: SupplierCredentials;
}
export type QueryReply = SubmitReply | { status: "NOT_FOUND" } | { status: "UNKNOWN" };

export interface SupplierAdapter {
  /** Matches suppliers.adapter_key. */
  readonly key: string;
  readonly capabilities: SupplierCapabilities;
  /** Full listing: products missing from it are treated as unavailable by the sync. */
  listProducts(credentials: SupplierCredentials): Promise<readonly SupplierProductInfo[]>;
  submitOrder(req: SubmitRequest): Promise<SubmitReply>;
  queryOrder(req: QueryRequest): Promise<QueryReply>;
}

/** The adapter proves that NOTHING was transmitted to the supplier (so a retry cannot duplicate a purchase). */
export class SupplierNotSentError extends Error {
  constructor(message = "request was not sent") {
    super(message);
    this.name = "SupplierNotSentError";
  }
}

export type SupplierAdapterRegistry = ReadonlyMap<string, SupplierAdapter>;

export function getAdapter(registry: SupplierAdapterRegistry, key: string): SupplierAdapter {
  const a = registry.get(key);
  if (!a) throw new DomainError("SUPPLIER_ADAPTER_NOT_CONFIGURED", "no adapter is configured for this supplier");
  return a;
}
