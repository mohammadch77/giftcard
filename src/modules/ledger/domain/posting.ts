import { DomainError } from "@/platform/errors";
import { hashRequest } from "@/platform/idempotency";
import { addRial, rial, ZERO_RIAL } from "@/platform/money";
import type { Rial } from "@/platform/money";
import type { Side } from "./chart-of-accounts";

export const MAX_ENTRIES_PER_TRANSACTION = 50;

export interface ResolvedEntry {
  accountId: number;
  side: Side;
  amount: Rial;
}

const KIND_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const REF_TYPE_RE = /^[a-z][a-z0-9_]{1,63}$/;

export function validateHeader(kind: string, idempotencyKey: string, ref: { type: string; id: string }): void {
  if (!KIND_RE.test(kind)) throw new DomainError("LEDGER_INVALID", "invalid transaction kind");
  if (!KEY_RE.test(idempotencyKey)) throw new DomainError("LEDGER_INVALID", "invalid idempotency key");
  if (!REF_TYPE_RE.test(ref.type) || ref.id.length < 1 || ref.id.length > 200) {
    throw new DomainError("LEDGER_INVALID", "invalid reference");
  }
}

/**
 * Domain-level validation (friendly errors BEFORE the database): >= 2 entries, <= 50, positive
 * safe-integer Rial amounts, at least one debit and one credit, and total debits == total credits.
 * The database enforces the same rules again at COMMIT; this is not the only line of defence.
 */
export function validateEntries(entries: readonly { amount: number; side: Side }[]): void {
  if (entries.length < 2) throw new DomainError("LEDGER_INVALID", "a transaction needs at least two entries");
  if (entries.length > MAX_ENTRIES_PER_TRANSACTION) throw new DomainError("LEDGER_INVALID", "too many entries");
  let debit: Rial = ZERO_RIAL;
  let credit: Rial = ZERO_RIAL;
  let debits = 0;
  let credits = 0;
  for (const e of entries) {
    const amount = rial(e.amount); // safe integer, 0..MAX_RIAL_AMOUNT
    if (amount <= 0) throw new DomainError("LEDGER_INVALID", "entry amounts must be positive");
    if (e.side === "DEBIT") { debit = addRial(debit, amount); debits += 1; }
    else if (e.side === "CREDIT") { credit = addRial(credit, amount); credits += 1; }
    else throw new DomainError("LEDGER_INVALID", "invalid side");
  }
  if (debits === 0 || credits === 0) throw new DomainError("LEDGER_UNBALANCED", "a transaction needs a debit and a credit");
  if (debit !== credit) throw new DomainError("LEDGER_UNBALANCED", "total debits must equal total credits");
}

/** Deterministic order (account id, then side, then amount): same lock order for every caller => no deadlocks. */
export function sortForLocking(entries: readonly ResolvedEntry[]): ResolvedEntry[] {
  return [...entries].sort((a, b) => a.accountId - b.accountId || (a.side < b.side ? -1 : a.side > b.side ? 1 : 0) || a.amount - b.amount);
}

/** Fingerprint of a posting request: same key + same fingerprint = replay; same key + other fingerprint = conflict. */
export function requestHash(input: { kind: string; reference: { type: string; id: string }; entries: readonly ResolvedEntry[]; reversesId?: number | undefined }): string {
  return hashRequest({
    kind: input.kind,
    reference: input.reference,
    entries: sortForLocking(input.entries).map((e) => [e.accountId, e.side, e.amount]),
    reversesId: input.reversesId ?? null,
  });
}

/** Mirror of a transaction's entries (used by reversals). */
export function mirror(entries: readonly ResolvedEntry[]): ResolvedEntry[] {
  return entries.map((e) => ({ ...e, side: e.side === "DEBIT" ? "CREDIT" : "DEBIT" }));
}
