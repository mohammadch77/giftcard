import { sql } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import type { AuditActor } from "@/modules/audit";
import { systemClock } from "@/platform/clock";
import type { Clock } from "@/platform/clock";
import type { Database, Tx } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { rial } from "@/platform/money";
import { CHART_VERSION, chartEntry, normalSideOf } from "../domain/chart-of-accounts";
import type { AccountSpec, Side } from "../domain/chart-of-accounts";
import { mirror, requestHash, sortForLocking, validateEntries, validateHeader } from "../domain/posting";
import type { ResolvedEntry } from "../domain/posting";

export interface LedgerDeps {
  clock?: Clock;
}

export type AccountRef = { accountId: number } | AccountSpec;

export interface PostEntry {
  account: AccountRef;
  side: Side;
  amount: number;
}

export interface PostInput {
  /** Upper-case kind, e.g. 'WALLET_TOPUP', 'ADMIN_ADJUSTMENT'. */
  kind: string;
  /** Business-derived key (e.g. `topup:<paymentId>`): a posting happens at most once per key. */
  idempotencyKey: string;
  reference: { type: string; id: string };
  entries: readonly PostEntry[];
  description?: string;
  /** Mandatory for sensitive kinds (see SENSITIVE_KINDS). Stored in the audit metadata. */
  reason?: string;
  actor: AuditActor;
  requestId?: string;
}

export interface PostResult {
  transactionId: number;
  replayed: boolean;
}

/** Kinds that must carry a human reason (they alter balances outside the normal business flow). */
export const SENSITIVE_KINDS: ReadonlySet<string> = new Set(["ADMIN_ADJUSTMENT", "REVERSAL", "CORRECTION"]);

type Row = Record<string, unknown>;
const rows = (r: { rows: unknown[] }): Row[] => r.rows as Row[];
const pgErr = (e: unknown): { code: string | undefined; message: string; constraint: string | undefined } => {
  const x = e as { code?: string; message?: string; constraint?: string; cause?: { code?: string; message?: string; constraint?: string } };
  return { code: x.cause?.code ?? x.code, message: `${x.cause?.message ?? ""} ${x.message ?? ""}`, constraint: x.cause?.constraint ?? x.constraint };
};

function mapDbError(e: unknown): never {
  const { code, message, constraint } = pgErr(e);
  if (code === "23514" && (constraint === "ledger_account_balances_floor" || message.includes("ledger_account_balances_floor"))) {
    throw new DomainError("INSUFFICIENT_FUNDS", "insufficient funds in the account");
  }
  if (code === "PL001") throw new DomainError("LEDGER_UNBALANCED", "ledger transaction is invalid or unbalanced");
  if (code === "PL002") throw new DomainError("LEDGER_REVERSAL_INVALID", "reversal is not allowed");
  if (code === "23505" && (constraint ?? message).includes("ledger_transactions_one_reversal")) {
    throw new DomainError("LEDGER_REVERSAL_INVALID", "transaction was already reversed");
  }
  throw e;
}

// ---------------------------------------------------------------- accounts

export interface AccountInfo {
  id: number;
  code: string;
  ownerType: string | null;
  ownerId: string | null;
  type: string;
  contra: boolean;
  normalSide: Side;
  minBalance: number | null;
  chartVersion: string;
}

const toAccount = (r: Row): AccountInfo => ({
  id: Number(r.id), code: r.code as string, ownerType: (r.owner_type as string | null) ?? null, ownerId: (r.owner_id as string | null) ?? null,
  type: r.type as string, contra: r.contra as boolean, normalSide: r.normal_side as Side,
  minBalance: r.min_balance === null || r.min_balance === undefined ? null : Number(r.min_balance), chartVersion: r.chart_version as string,
});

async function findAccount(db: Database | Tx, spec: AccountSpec): Promise<AccountInfo | null> {
  const r = rows(await db.execute(
    sql`select * from ledger_accounts where code = ${spec.code} and coalesce(owner_type,'') = ${spec.ownerType ?? ""} and coalesce(owner_id,'') = ${spec.ownerId ?? ""}`,
  ));
  return r[0] ? toAccount(r[0]) : null;
}

function checkSpec(spec: AccountSpec): void {
  const chart = chartEntry(spec.code); // throws for codes outside the chart
  const scoped = chart.scope !== "system";
  if (scoped !== (spec.ownerType !== undefined && spec.ownerId !== undefined) || (spec.ownerType === undefined) !== (spec.ownerId === undefined)) {
    throw new DomainError("LEDGER_INVALID", "account owner does not match the chart scope");
  }
  if (spec.ownerId !== undefined && (spec.ownerId.length < 1 || spec.ownerId.length > 200)) throw new DomainError("LEDGER_INVALID", "invalid owner id");
}

/**
 * Create the account if it does not exist (idempotent, race-safe). Its definition (type, side, floor)
 * comes from the proposed chart and can never differ between callers. Creation is audited.
 */
export async function ensureAccount(tx: Tx, spec: AccountSpec, actor: AuditActor, deps: LedgerDeps = {}): Promise<AccountInfo> {
  checkSpec(spec);
  const existing = await findAccount(tx, spec);
  if (existing) return existing;
  const c = chartEntry(spec.code);
  const clock = deps.clock ?? systemClock;
  const inserted = await tx.transaction(async (sp) => {
    const res = rows(await sp.execute(
      sql`insert into ledger_accounts (code, owner_type, owner_id, type, contra, normal_side, min_balance, chart_version)
          values (${spec.code}, ${spec.ownerType ?? null}, ${spec.ownerId ?? null}, ${c.type}, ${c.contra ?? false},
                  ${normalSideOf(c.type, c.contra ?? false)}, ${c.minBalance ?? null}, ${CHART_VERSION})
          on conflict (code, coalesce(owner_type,''), coalesce(owner_id,'')) do nothing
          returning *`,
    ));
    if (res.length === 0) return null; // lost a race: someone else created it
    await recordAudit(sp, {
      actor, action: "ledger.account.create", entity: { type: "ledger_account", id: `${spec.code}:${spec.ownerType ?? "-"}:${spec.ownerId ?? "-"}` },
      after: { code: spec.code, ownerType: spec.ownerType ?? null, ownerId: spec.ownerId ?? null, type: c.type, chartVersion: CHART_VERSION },
      occurredAt: clock.now(),
    });
    return toAccount(res[0] as Row);
  });
  if (inserted) return inserted;
  const again = await findAccount(tx, spec);
  if (!again) throw new DomainError("LEDGER_ACCOUNT_NOT_FOUND", "account could not be created");
  return again;
}

async function resolveAccounts(tx: Database | Tx, refs: readonly AccountRef[]): Promise<number[]> {
  const out: number[] = [];
  for (const ref of refs) {
    if ("accountId" in ref) {
      const r = rows(await tx.execute(sql`select id from ledger_accounts where id = ${ref.accountId}`));
      if (!r[0]) throw new DomainError("LEDGER_ACCOUNT_NOT_FOUND", "account does not exist");
      out.push(ref.accountId);
    } else {
      checkSpec(ref);
      const acc = await findAccount(tx, ref);
      if (!acc) throw new DomainError("LEDGER_ACCOUNT_NOT_FOUND", "account does not exist");
      out.push(acc.id);
    }
  }
  return out;
}

// ---------------------------------------------------------------- posting

async function loadEntries(db: Database | Tx, transactionId: number): Promise<ResolvedEntry[]> {
  const r = rows(await db.execute(sql`select account_id, side, amount from ledger_entries where transaction_id = ${transactionId} order by id`));
  return r.map((e) => ({ accountId: Number(e.account_id), side: e.side as Side, amount: rial(Number(e.amount)) }));
}

async function existingByKey(db: Database | Tx, key: string): Promise<{ id: number; hash: string } | null> {
  const r = rows(await db.execute(sql`select id, request_hash from ledger_transactions where idempotency_key = ${key}`));
  return r[0] ? { id: Number(r[0].id), hash: r[0].request_hash as string } : null;
}

interface WriteInput {
  kind: string; idempotencyKey: string; reference: { type: string; id: string }; entries: ResolvedEntry[];
  description: string | undefined; reason: string | undefined; actor: AuditActor; requestId: string | undefined; reversesId: number | undefined;
}

async function write(tx: Tx, input: WriteInput, clock: Clock): Promise<PostResult> {
  const hash = requestHash({ kind: input.kind, reference: input.reference, entries: input.entries, reversesId: input.reversesId });

  const replay = async (): Promise<PostResult | null> => {
    const found = await existingByKey(tx, input.idempotencyKey);
    if (!found) return null;
    if (found.hash !== hash) throw new DomainError("IDEMPOTENCY_CONFLICT", "idempotency key was used with a different posting");
    return { transactionId: found.id, replayed: true };
  };

  const fast = await replay();
  if (fast) return fast;

  const now = clock.now();
  const ordered = sortForLocking(input.entries);
  try {
    // Savepoint: if a concurrent identical posting wins the unique key, we discard OUR audit row too.
    const created = await tx.transaction(async (sp) => {
      const auditId = await recordAudit(sp, {
        actor: input.actor,
        action: input.reversesId === undefined ? "ledger.post" : "ledger.reverse",
        entity: { type: "ledger_transaction", id: input.idempotencyKey },
        after: {
          kind: input.kind, reference: input.reference, reversesId: input.reversesId ?? null,
          entries: ordered.map((e) => ({ accountId: e.accountId, side: e.side, amount: e.amount })),
        },
        metadata: { reason: input.reason ?? null, chartVersion: CHART_VERSION },
        requestId: input.requestId,
        occurredAt: now,
      });

      const head = rows(await sp.execute(
        sql`insert into ledger_transactions (kind, idempotency_key, request_hash, reference_type, reference_id, reverses_id, description,
                                              actor_type, actor_id, audit_log_id, posted_at)
            values (${input.kind}, ${input.idempotencyKey}, ${hash}, ${input.reference.type}, ${input.reference.id}, ${input.reversesId ?? null},
                    ${input.description ?? null}, ${input.actor.type}, ${input.actor.id}, ${auditId}, ${now.toISOString()}::timestamptz)
            on conflict (idempotency_key) do nothing
            returning id`,
      ));
      if (head.length === 0) return null; // lost the race => roll the savepoint back (removes our audit row)
      const transactionId = Number((head[0] as Row).id);
      for (const e of ordered) {
        await sp.execute(sql`insert into ledger_entries (transaction_id, account_id, side, amount) values (${transactionId}, ${e.accountId}, ${e.side}, ${e.amount})`);
      }
      return transactionId;
    });
    if (created !== null) return { transactionId: created, replayed: false };
  } catch (e) {
    // A concurrent identical reversal can trip the one-reversal unique index before the idempotency-key
    // index. If the other transaction used the same key, this is a replay, not an error.
    const { code, constraint, message } = pgErr(e);
    if (code === "23505" && (constraint ?? message).includes("ledger_transactions_one_reversal")) {
      const same = await replay();
      if (same) return same;
    }
    mapDbError(e);
  }
  const lost = await replay();
  if (!lost) throw new DomainError("LEDGER_INVALID", "posting could not be completed");
  return lost;
}

/**
 * Post a balanced double-entry transaction INSIDE the caller's database transaction.
 * No external call may be made inside that transaction (rule 7); this function performs none.
 * Idempotent by `idempotencyKey`. Balance, shape, append-only and audit linkage are re-enforced by
 * PostgreSQL at COMMIT. Insufficient funds on a floored account => INSUFFICIENT_FUNDS and the
 * posting (including its audit row) is rolled back.
 */
export async function post(tx: Tx, input: PostInput, deps: LedgerDeps = {}): Promise<PostResult> {
  validateHeader(input.kind, input.idempotencyKey, input.reference);
  if (input.kind === "REVERSAL") throw new DomainError("LEDGER_INVALID", "use reverse() for reversals");
  if (SENSITIVE_KINDS.has(input.kind) && (!input.reason || input.reason.trim().length < 5)) {
    throw new DomainError("LEDGER_INVALID", "a reason is required for this kind of posting");
  }
  validateEntries(input.entries);
  const ids = await resolveAccounts(tx, input.entries.map((e) => e.account));
  const resolved: ResolvedEntry[] = input.entries.map((e, i) => ({ accountId: ids[i] as number, side: e.side, amount: rial(e.amount) }));
  return write(tx, {
    kind: input.kind, idempotencyKey: input.idempotencyKey, reference: input.reference, entries: resolved,
    description: input.description, reason: input.reason, actor: input.actor, requestId: input.requestId, reversesId: undefined,
  }, deps.clock ?? systemClock);
}

export interface ReverseInput {
  originalTransactionId: number;
  idempotencyKey: string;
  /** Mandatory human reason (audited). */
  reason: string;
  actor: AuditActor;
  requestId?: string;
}

/**
 * Correct a posting with its exact mirror (no UPDATE/DELETE ever). A reversal cannot be reversed and
 * a transaction can be reversed once. If the reversal would overdraw a floored account the call fails
 * with INSUFFICIENT_FUNDS: the correction then needs an explicit ADJUSTMENT/CORRECTION posting.
 */
export async function reverse(tx: Tx, input: ReverseInput, deps: LedgerDeps = {}): Promise<PostResult> {
  if (!input.reason || input.reason.trim().length < 5) throw new DomainError("LEDGER_INVALID", "a reason is required for a reversal");
  const orig = rows(await tx.execute(sql`select id, reference_type, reference_id, reverses_id from ledger_transactions where id = ${input.originalTransactionId}`))[0];
  if (!orig) throw new DomainError("LEDGER_REVERSAL_INVALID", "original transaction does not exist");
  if (orig.reverses_id !== null) throw new DomainError("LEDGER_REVERSAL_INVALID", "a reversal can not be reversed");
  const entries = mirror(await loadEntries(tx, input.originalTransactionId));
  return write(tx, {
    kind: "REVERSAL", idempotencyKey: input.idempotencyKey, reference: { type: orig.reference_type as string, id: orig.reference_id as string },
    entries, description: undefined, reason: input.reason, actor: input.actor, requestId: input.requestId, reversesId: input.originalTransactionId,
  }, deps.clock ?? systemClock);
}

// ---------------------------------------------------------------- reads / reports

/** Current balance (projection, in the account's normal-side terms) — the wallet balance for CUSTOMER_WALLET. */
export async function getBalance(db: Database | Tx, ref: AccountRef): Promise<number> {
  const [id] = await resolveAccounts(db, [ref]);
  const r = rows(await db.execute(sql`select balance from ledger_account_balances where account_id = ${id as number}`));
  if (!r[0]) throw new DomainError("LEDGER_ACCOUNT_NOT_FOUND", "no balance row for account");
  return Number(r[0].balance);
}

export interface TrialBalanceRow {
  accountId: number; code: string; ownerType: string | null; ownerId: string | null; type: string; contra: boolean; normalSide: Side;
  debitTotal: number; creditTotal: number; balance: number; projectionBalance: number | null; entryCount: number;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebits: number;
  totalCredits: number;
  balanced: boolean;
}

/** Account balances computed from the ENTRIES (truth), with the projection next to them. */
export async function trialBalance(db: Database | Tx): Promise<TrialBalance> {
  const r = rows(await db.execute(sql`select * from ledger_trial_balance()`));
  const list: TrialBalanceRow[] = r.map((x) => ({
    accountId: Number(x.account_id), code: x.code as string, ownerType: (x.owner_type as string | null) ?? null, ownerId: (x.owner_id as string | null) ?? null,
    type: x.type as string, contra: x.contra as boolean, normalSide: x.normal_side as Side, debitTotal: Number(x.debit_total), creditTotal: Number(x.credit_total),
    balance: Number(x.balance), projectionBalance: x.projection_balance === null ? null : Number(x.projection_balance), entryCount: Number(x.entry_count),
  }));
  const totalDebits = list.reduce((s, x) => s + x.debitTotal, 0);
  const totalCredits = list.reduce((s, x) => s + x.creditTotal, 0);
  return { rows: list, totalDebits, totalCredits, balanced: totalDebits === totalCredits };
}

export interface IntegrityFinding {
  kind: string;
  accountId: number | null;
  transactionId: number | null;
  detail: string;
}

/** Empty array = healthy. Detects projection drift, unbalanced/entry-less transactions, floor breaches, reversal mismatches, audit mismatches. */
export async function verifyIntegrity(db: Database | Tx): Promise<IntegrityFinding[]> {
  const r = rows(await db.execute(sql`select * from ledger_integrity_findings()`));
  return r.map((x) => ({ kind: x.kind as string, accountId: x.account_id === null ? null : Number(x.account_id), transactionId: x.transaction_id === null ? null : Number(x.transaction_id), detail: x.detail as string }));
}

export interface TransactionView {
  id: number; kind: string; idempotencyKey: string; reference: { type: string; id: string }; reversesId: number | null; postedAt: Date;
  actor: AuditActor; entries: ResolvedEntry[];
}

export async function getTransaction(db: Database | Tx, id: number): Promise<TransactionView | null> {
  const t = rows(await db.execute(sql`select * from ledger_transactions where id = ${id}`))[0];
  if (!t) return null;
  return {
    id: Number(t.id), kind: t.kind as string, idempotencyKey: t.idempotency_key as string,
    reference: { type: t.reference_type as string, id: t.reference_id as string },
    reversesId: t.reverses_id === null ? null : Number(t.reverses_id), postedAt: new Date(t.posted_at as string | Date),
    actor: { type: t.actor_type as AuditActor["type"], id: t.actor_id as string }, entries: await loadEntries(db, id),
  };
}

/** Look a posting up by its business idempotency key (e.g. `late:<paymentId>`), for reversals. */
export async function findTransactionByKey(db: Database | Tx, idempotencyKey: string): Promise<TransactionView | null> {
  const t = rows(await db.execute(sql`select id from ledger_transactions where idempotency_key = ${idempotencyKey}`))[0];
  return t ? getTransaction(db, Number(t.id)) : null;
}
