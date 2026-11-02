import type { QueryReply, QueryRequest, SubmitReply, SubmitRequest, SupplierAdapter, SupplierCapabilities, SupplierCredentials, SupplierProductInfo, SupplierRejectReason } from "../index";
import { SupplierNotSentError } from "../index";

/**
 * TEST DOUBLE — never imported by production code (only src/platform/composition may bridge).
 * Models a supplier with its OWN state, so tests can prove the dangerous cases: the supplier executed the purchase but
 * the client saw a timeout, duplicate keys, rejected orders, and what a status query would say.
 */
export type SubmitScript =
  | { kind: "CONFIRM"; deliverables?: string[] }
  | { kind: "REJECT"; reason: SupplierRejectReason }
  | { kind: "TIMEOUT_AFTER_EXECUTE"; deliverables?: string[] } // supplier bought it, client sees an error
  | { kind: "TIMEOUT_BEFORE_EXECUTE" } // request lost, supplier never saw it
  | { kind: "NOT_SENT" }
  | { kind: "SLOW_CONFIRM"; ms: number; deliverables?: string[] };

export class TestSupplier implements SupplierAdapter {
  readonly key = "test";
  capabilities: SupplierCapabilities = { idempotentSubmit: false, statusQuery: true, deliversCodes: true };
  /** Supplier-side truth: idempotencyKey -> executed purchase. */
  readonly executed = new Map<string, { externalRef: string; deliverables: string[] }>();
  /** How many times each key hit the supplier (a value > 1 would be a duplicate-purchase attempt). */
  readonly attempts = new Map<string, number>();
  readonly credentialsSeen: SupplierCredentials[] = [];
  catalog: SupplierProductInfo[] = [];
  listMode: "ok" | "throw" = "ok";
  private readonly scripts = new Map<string, SubmitScript>();
  private defaultScript: SubmitScript = { kind: "CONFIRM" };
  private seq = 0;

  script(idempotencyKey: string, s: SubmitScript): void {
    this.scripts.set(idempotencyKey, s);
  }
  setDefault(s: SubmitScript): void {
    this.defaultScript = s;
  }

  async listProducts(credentials: SupplierCredentials): Promise<readonly SupplierProductInfo[]> {
    this.credentialsSeen.push(credentials);
    if (this.listMode === "throw") throw new Error("simulated listing failure");
    return this.catalog;
  }

  private execute(key: string, deliverables: string[]): { externalRef: string; deliverables: string[] } {
    const existing = this.executed.get(key);
    if (existing) return existing; // an idempotent supplier returns the original
    const e = { externalRef: `ext-${++this.seq}`, deliverables };
    this.executed.set(key, e);
    return e;
  }

  async submitOrder(req: SubmitRequest): Promise<SubmitReply> {
    this.credentialsSeen.push(req.credentials);
    this.attempts.set(req.idempotencyKey, (this.attempts.get(req.idempotencyKey) ?? 0) + 1);
    const s = this.scripts.get(req.idempotencyKey) ?? this.defaultScript;
    switch (s.kind) {
      case "NOT_SENT":
        throw new SupplierNotSentError();
      case "REJECT":
        return { status: "REJECTED", reason: s.reason };
      case "TIMEOUT_BEFORE_EXECUTE":
        throw new Error("simulated timeout (request lost)");
      case "TIMEOUT_AFTER_EXECUTE":
        this.execute(req.idempotencyKey, s.deliverables ?? []);
        throw new Error("simulated timeout (supplier executed)");
      case "SLOW_CONFIRM": {
        await new Promise((r) => setTimeout(r, s.ms));
        const e = this.execute(req.idempotencyKey, s.deliverables ?? []);
        return { status: "CONFIRMED", externalRef: e.externalRef, deliverables: e.deliverables };
      }
      default: {
        const e = this.execute(req.idempotencyKey, s.deliverables ?? []);
        return { status: "CONFIRMED", externalRef: e.externalRef, ...(e.deliverables.length ? { deliverables: e.deliverables } : {}) };
      }
    }
  }

  async queryOrder(req: QueryRequest): Promise<QueryReply> {
    this.credentialsSeen.push(req.credentials);
    const e = this.executed.get(req.idempotencyKey);
    if (!e) return { status: "NOT_FOUND" };
    return { status: "CONFIRMED", externalRef: e.externalRef, ...(e.deliverables.length ? { deliverables: e.deliverables } : {}) };
  }
}
