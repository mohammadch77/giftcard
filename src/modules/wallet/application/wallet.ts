import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import type { AuditActor } from "@/modules/audit";
import { adminWalletCredit, adminWalletDebit, ensureAccount, gatewayReceivable, getBalance, post, systemAccount, walletAccount, walletTopUp } from "@/modules/ledger";
import { findPaymentByGatewayRef, getPayment, initiatePayment, startGatewayPayment, verifyPayment } from "@/modules/payments";
import type { PaymentView, StartOutcome, VerifyDeps, VerifyOutcome } from "@/modules/payments";
import type { Clock } from "@/platform/clock";
import type { Database, Tx } from "@/platform/db";
import { withTransaction } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { uuidv7 } from "@/platform/ids";
import { rial, rialPrice } from "@/platform/money";
import type { PaymentGateway } from "@/platform/payment-gateway";
import { setTransitionContext } from "@/platform/transitions";
import { dailyTopUpTotal, getTopUpLimits } from "./settings";

const SYSTEM: AuditActor = { type: "SYSTEM", id: "system:wallet" };
const iso = (d: Date) => d.toISOString();
const first = <T>(r: { rows: unknown[] }): T | undefined => r.rows[0] as T | undefined;
const USER_REF = /^.{1,200}$/;

/** Wallet balance in Rial = the ledger's CUSTOMER_WALLET account (a projection of the entries; the ledger is the truth). 0 when the wallet was never used. */
export async function getWalletBalance(db: Database | Tx, userId: string): Promise<number> {
  try {
    return await getBalance(db, walletAccount(userId));
  } catch (e) {
    if (e instanceof DomainError && e.code === "LEDGER_ACCOUNT_NOT_FOUND") return 0;
    throw e;
  }
}

export interface TopUpView { topupId: string; paymentId: string | null; status: "REQUESTED" | "COMPLETED" | "FAILED"; amount: number }
export interface StartTopUpResult extends TopUpView { redirectUrl?: string; replay: boolean; gateway: StartOutcome["status"] }

/**
 * Start a wallet top-up. The limits (B5) are the ACTIVE versioned settings, read inside the same transaction as the insert.
 * Phase 1 (one tx): per-user lock -> idempotent replay (never re-validated: a limits change must not alter a top-up already started)
 * -> min/max -> insert -> daily limit (Asia/Tehran day, counting in-flight and completed top-ups, including this one; a breach rolls back).
 * The per-user advisory lock serialises concurrent top-ups of the SAME user, so parallel requests cannot jointly exceed the daily maximum.
 * Phase 2 (no tx): the gateway creates the payment.
 */
export async function startTopUp(db: Database, deps: { gateway: PaymentGateway; clock: Clock }, input: { userId: string; amount: number; idempotencyKey: string }): Promise<StartTopUpResult> {
  if (!USER_REF.test(input.userId) || !input.idempotencyKey || input.idempotencyKey.length > 200) throw new DomainError("WALLET_INVALID", "invalid user or idempotency key");
  const amount = rialPrice(input.amount); // integer Rial, multiple of 10 (exact Toman)
  const hash = createHash("sha256").update(JSON.stringify([input.userId, amount])).digest();
  const now = deps.clock.now();

  const phase1 = await withTransaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`topup-daily:${input.userId}`}, 0))`);
    const existing = first<{ id: string; request_hash: Buffer }>(await tx.execute(sql`select id, request_hash from wallet_topups where idempotency_key = ${input.idempotencyKey}`));
    let topupId: string;
    let replay = false;
    if (existing) {
      if (!Buffer.from(existing.request_hash).equals(hash)) throw new DomainError("IDEMPOTENCY_CONFLICT", "top-up key was used with different content");
      topupId = existing.id;
      replay = true;
    } else {
      const limits = await getTopUpLimits(tx);
      if (amount <= 0 || amount < limits.values.minRial || amount > limits.values.maxRial) throw new DomainError("WALLET_INVALID", "amount is outside the allowed top-up range");
      topupId = uuidv7(deps.clock);
      await setTransitionContext(tx, { actorId: SYSTEM.id, reason: "top-up requested" });
      const ins = await tx.execute(
        sql`insert into wallet_topups (id, user_ref, amount, status, idempotency_key, request_hash, limits_version, created_at) values (${topupId}, ${input.userId}, ${amount}, 'REQUESTED', ${input.idempotencyKey}, ${hash}, ${limits.version}, ${iso(now)}::timestamptz)
            on conflict (idempotency_key) do nothing returning id`,
      );
      if (ins.rows.length === 0) throw new DomainError("IDEMPOTENCY_CONFLICT", "top-up key was used concurrently");
      const used = await dailyTopUpTotal(tx, input.userId, now); // includes the row just inserted
      if (used > limits.values.dailyMaxRial) throw new DomainError("WALLET_DAILY_LIMIT_EXCEEDED", "this top-up would exceed the daily top-up limit");
    }
    const { payment } = await initiatePayment(tx, deps.clock, { idempotencyKey: `topup:${topupId}`, purpose: "WALLET_TOPUP", topupRef: topupId, userRef: input.userId, gateway: deps.gateway.key, amount });
    await tx.execute(sql`update wallet_topups set payment_id = ${payment.id} where id = ${topupId} and payment_id is null`);
    if (!replay) await recordAudit(tx, { actor: { type: "USER", id: input.userId }, action: "wallet.topup.requested", entity: { type: "wallet_topup", id: topupId }, metadata: { amount }, occurredAt: now });
    return { topupId, paymentId: payment.id, replay };
  });
  const started = await startGatewayPayment(db, deps, phase1.paymentId);
  const t = (await getTopUp(db, input.userId, phase1.topupId))!;
  return { ...t, replay: phase1.replay, gateway: started.status, ...("redirectUrl" in started && started.redirectUrl ? { redirectUrl: started.redirectUrl } : {}) };
}

/** Customer-scoped read (IDOR-safe). */
export async function getTopUp(db: Database | Tx, userId: string, topupId: string): Promise<TopUpView | null> {
  const r = first<{ id: string; payment_id: string | null; status: TopUpView["status"]; amount: string }>(await db.execute(sql`select id, payment_id, status, amount from wallet_topups where id = ${topupId} and user_ref = ${userId}`));
  return r ? { topupId: r.id, paymentId: r.payment_id, status: r.status, amount: Number(r.amount) } : null;
}

/** Credit the wallet for a verified top-up payment. Runs INSIDE the transaction that marks the payment SUCCEEDED. Idempotent (ledger key + status). */
async function settleTopUp(tx: Tx, clock: Clock, payment: PaymentView): Promise<void> {
  if (payment.purpose !== "WALLET_TOPUP" || !payment.topupRef) return; // another owner module handles other purposes
  const t = first<{ id: string; user_ref: string; amount: string; status: string }>(await tx.execute(sql`select id, user_ref, amount, status from wallet_topups where id = ${payment.topupRef} for update`));
  if (!t) throw new DomainError("WALLET_NOT_FOUND", "top-up not found for payment");
  if (t.user_ref !== payment.userRef || Number(t.amount) !== payment.amount) throw new DomainError("WALLET_INVALID", "top-up does not match its payment");
  if (t.status === "COMPLETED") return;
  await ensureAccount(tx, walletAccount(t.user_ref), SYSTEM, { clock });
  await ensureAccount(tx, gatewayReceivable(payment.gateway), SYSTEM, { clock });
  const posted = await post(tx, {
    kind: "WALLET_TOPUP", idempotencyKey: `topup:${payment.id}`, reference: { type: "wallet_topup", id: t.id },
    entries: walletTopUp({ userId: t.user_ref, gatewayKey: payment.gateway, amount: payment.amount }), description: "verified gateway top-up", actor: SYSTEM,
  }, { clock });
  await setTransitionContext(tx, { actorId: SYSTEM.id, reason: "top-up completed" });
  await tx.execute(sql`update wallet_topups set status = 'COMPLETED', ledger_txn_id = ${posted.transactionId}, completed_at = ${iso(clock.now())}::timestamptz where id = ${t.id} and status = 'REQUESTED'`);
  await recordAudit(tx, { actor: SYSTEM, action: "wallet.topup.completed", entity: { type: "wallet_topup", id: t.id }, metadata: { amount: payment.amount, ledgerTransaction: posted.transactionId }, occurredAt: clock.now() });
}

/**
 * Gateway callback / return handler for a top-up. The callback only TRIGGERS server-to-server verification; the wallet is
 * credited exactly once, in the same transaction that marks the payment SUCCEEDED (payments' onSucceeded hook).
 */
export async function completeTopUp(db: Database, deps: VerifyDeps, input: { gatewayRef: string; eventKey: string; raw?: unknown }): Promise<VerifyOutcome> {
  const out = await verifyPayment(db, deps, input, { onSucceeded: (tx, payment) => settleTopUp(tx, deps.clock, payment) });
  if (out.outcome === "FAILED" || (out.outcome === "FINAL" && out.status === "FAILED")) {
    const p = await findPaymentByGatewayRef(db, deps.gateway.key, input.gatewayRef);
    if (p?.status === "FAILED") {
      await withTransaction(db, async (tx) => {
        await setTransitionContext(tx, { actorId: SYSTEM.id, reason: "payment failed" });
        await tx.execute(sql`update wallet_topups set status = 'FAILED' where payment_id = ${p.id} and status = 'REQUESTED'`);
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ administrative adjustments (always two people)

export interface WalletAdminContext { db: Database; clock: Clock; actor: AuditActor; authorize(permission: string): Promise<void> }

export async function getWalletBalanceAdmin(c: WalletAdminContext, userId: string): Promise<number> {
  await c.authorize("wallet.read");
  return getWalletBalance(c.db, userId);
}

export async function requestAdjustment(c: WalletAdminContext, i: { userId: string; direction: "CREDIT" | "DEBIT"; amount: number; reason: string }): Promise<{ adjustmentId: string }> {
  await c.authorize("wallet.adjust.request");
  if (!USER_REF.test(i.userId) || (i.direction !== "CREDIT" && i.direction !== "DEBIT")) throw new DomainError("WALLET_INVALID", "invalid adjustment");
  const amount = rial(i.amount);
  if (amount <= 0) throw new DomainError("WALLET_INVALID", "amount must be positive");
  if (i.reason.trim().length < 10) throw new DomainError("WALLET_INVALID", "a reason of at least 10 characters is required");
  return withTransaction(c.db, async (tx) => {
    const id = uuidv7(c.clock);
    await setTransitionContext(tx, { actorId: c.actor.id, reason: "adjustment requested" });
    await tx.execute(sql`insert into wallet_adjustments (id, user_ref, direction, amount, reason, status, requested_by, created_at) values (${id}, ${i.userId}, ${i.direction}, ${amount}, ${i.reason.trim()}, 'REQUESTED', ${c.actor.id}, ${iso(c.clock.now())}::timestamptz)`);
    await recordAudit(tx, { actor: c.actor, action: "wallet.adjustment.requested", entity: { type: "wallet_adjustment", id }, metadata: { direction: i.direction, amount, reason: i.reason.trim() }, occurredAt: c.clock.now() });
    return { adjustmentId: id };
  });
}

/** Approve (executes the ledger posting in the same transaction) or reject. The decider must differ from the requester. */
export async function decideAdjustment(c: WalletAdminContext, adjustmentId: string, decision: { approve: boolean; reason: string }): Promise<{ status: "COMPLETED" | "REJECTED"; ledgerTransactionId?: number }> {
  await c.authorize("wallet.adjust.approve");
  if (decision.reason.trim().length < 5) throw new DomainError("WALLET_INVALID", "a decision reason is required");
  return withTransaction(c.db, async (tx) => {
    const a = first<{ user_ref: string; direction: "CREDIT" | "DEBIT"; amount: string; reason: string; status: string; requested_by: string }>(
      await tx.execute(sql`select user_ref, direction, amount, reason, status, requested_by from wallet_adjustments where id = ${adjustmentId} for update`),
    );
    if (!a) throw new DomainError("WALLET_NOT_FOUND", "adjustment not found");
    if (a.status !== "REQUESTED") throw new DomainError("WALLET_INVALID", "adjustment was already decided");
    if (a.requested_by === c.actor.id) throw new DomainError("WALLET_INVALID", "a second administrator must decide this adjustment");
    const now = iso(c.clock.now());
    await setTransitionContext(tx, { actorId: c.actor.id, reason: decision.reason.trim() });
    if (!decision.approve) {
      await tx.execute(sql`update wallet_adjustments set status = 'REJECTED', decided_by = ${c.actor.id}, decision_reason = ${decision.reason.trim()}, decided_at = ${now}::timestamptz where id = ${adjustmentId}`);
      await recordAudit(tx, { actor: c.actor, action: "wallet.adjustment.rejected", entity: { type: "wallet_adjustment", id: adjustmentId }, metadata: { reason: decision.reason.trim() }, occurredAt: c.clock.now() });
      return { status: "REJECTED" as const };
    }
    const amount = Number(a.amount);
    await ensureAccount(tx, walletAccount(a.user_ref), c.actor, { clock: c.clock });
    await ensureAccount(tx, systemAccount("ADJUSTMENT_EXPENSE"), c.actor, { clock: c.clock });
    const posted = await post(tx, {
      kind: "ADMIN_ADJUSTMENT", idempotencyKey: `walletadj:${adjustmentId}`, reference: { type: "wallet_adjustment", id: adjustmentId },
      entries: a.direction === "CREDIT" ? adminWalletCredit({ userId: a.user_ref, amount }) : adminWalletDebit({ userId: a.user_ref, amount }),
      reason: a.reason, description: `requested by ${a.requested_by}`, actor: c.actor,
    }, { clock: c.clock });
    await tx.execute(sql`update wallet_adjustments set status = 'COMPLETED', decided_by = ${c.actor.id}, decision_reason = ${decision.reason.trim()}, decided_at = ${now}::timestamptz, ledger_txn_id = ${posted.transactionId} where id = ${adjustmentId}`);
    await recordAudit(tx, { actor: c.actor, action: "wallet.adjustment.approved", entity: { type: "wallet_adjustment", id: adjustmentId }, metadata: { direction: a.direction, amount, ledgerTransaction: posted.transactionId, reason: decision.reason.trim() }, occurredAt: c.clock.now() });
    return { status: "COMPLETED" as const, ledgerTransactionId: posted.transactionId };
  });
}


/** Top-ups whose payment SUCCEEDED but which are not COMPLETED (credit missing) — reconciliation input. */
export async function findIncompleteSucceededTopUps(db: Database, limit = 100): Promise<{ topupId: string; paymentId: string }[]> {
  const rows = (await db.execute(sql`select id, payment_id from wallet_topups where status = 'REQUESTED' and payment_id is not null order by created_at limit ${Math.min(limit, 500)}`)).rows as { id: string; payment_id: string }[];
  const out: { topupId: string; paymentId: string }[] = [];
  for (const r of rows) {
    const p = await getPayment(db, r.payment_id);
    if (p?.status === "SUCCEEDED") out.push({ topupId: r.id, paymentId: r.payment_id });
  }
  return out;
}
