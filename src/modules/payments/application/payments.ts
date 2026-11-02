import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/modules/audit";
import type { AuditActor } from "@/modules/audit";
import { ensureAccount, gatewayReceivable, post, suspenseReceipt, systemAccount } from "@/modules/ledger";
import type { Clock } from "@/platform/clock";
import type { Database, Tx } from "@/platform/db";
import { withTransaction } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { uuidv7 } from "@/platform/ids";
import { redact } from "@/platform/logging";
import { MAX_RIAL_AMOUNT, rial } from "@/platform/money";
import { enqueueOutbox } from "@/platform/outbox";
import type { PaymentGateway } from "@/platform/payment-gateway";
import { setTransitionContext } from "@/platform/transitions";
import { DEFAULT_MAX_VERIFY_ATTEMPTS, DEFAULT_VERIFY_LEASE_SECONDS, FINAL_STATUSES } from "../domain/types";
import type { PaymentPurpose, PaymentStatus, PaymentView } from "../domain/types";

const SYSTEM: AuditActor = { type: "SYSTEM", id: "system:payments" };
type Ts = Date | string;
const toDate = (v: Ts): Date => (v instanceof Date ? v : new Date(v.replace(" ", "T").replace(/(\.\d{3})\d*/, "$1").replace(/([+-]\d{2})$/, "$1:00")));
const iso = (d: Date) => d.toISOString();
const first = <T>(r: { rows: unknown[] }): T | undefined => r.rows[0] as T | undefined;

interface Row {
  id: string; purpose: PaymentPurpose; order_ref: string | null; topup_ref: string | null; user_ref: string; gateway: string; gateway_ref: string | null;
  amount: string | number; status: PaymentStatus; verifying_since: Ts | null; verify_attempts: number; verified_at: Ts | null; review_reason: string | null; created_at: Ts;
}
const toView = (r: Row): PaymentView => ({
  id: r.id, purpose: r.purpose, orderRef: r.order_ref, topupRef: r.topup_ref, userRef: r.user_ref, gateway: r.gateway, gatewayRef: r.gateway_ref,
  amount: rial(Number(r.amount)), status: r.status, verifiedAt: r.verified_at ? toDate(r.verified_at) : null, reviewReason: r.review_reason, createdAt: toDate(r.created_at),
});
const COLS = sql`id, purpose, order_ref, topup_ref, user_ref, gateway, gateway_ref, amount, status, verifying_since, verify_attempts, verified_at, review_reason, created_at`;

const initiateInput = z.strictObject({
  idempotencyKey: z.string().min(1).max(200),
  purpose: z.enum(["ORDER", "WALLET_TOPUP"]),
  orderRef: z.string().min(1).max(200).optional(),
  topupRef: z.string().min(1).max(200).optional(),
  userRef: z.string().min(1).max(200),
  gateway: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  amount: z.number(),
});

/**
 * Create an INITIATED payment inside the caller's transaction. Idempotent per key: the same key and content returns the
 * existing payment; different content is IDEMPOTENCY_CONFLICT. The amount is integer Rial, > 0, <= 10^13.
 */
export async function initiatePayment(tx: Tx, clock: Clock, raw: unknown): Promise<{ payment: PaymentView; replay: boolean }> {
  const p = initiateInput.safeParse(raw);
  if (!p.success) throw new DomainError("PAYMENT_INVALID", `invalid input: ${p.error.issues.map((i) => `${i.path.join(".")}: ${i.code}`).join("; ")}`);
  const i = p.data;
  const amount = rial(i.amount);
  if (amount <= 0 || amount > MAX_RIAL_AMOUNT) throw new DomainError("PAYMENT_INVALID", "amount must be positive");
  if ((i.purpose === "ORDER") !== (i.orderRef !== undefined) || (i.purpose === "WALLET_TOPUP") !== (i.topupRef !== undefined)) throw new DomainError("PAYMENT_INVALID", "target does not match purpose");
  const now = clock.now();
  const hash = createHash("sha256").update(JSON.stringify([i.purpose, i.orderRef ?? null, i.topupRef ?? null, i.userRef, i.gateway, amount])).digest();
  const id = uuidv7(clock);
  await setTransitionContext(tx, { actorId: SYSTEM.id, reason: "initiated" });
  const ins = await tx.execute(
    sql`insert into payments (id, purpose, order_ref, topup_ref, user_ref, gateway, amount, currency, status, idempotency_key, request_hash, created_at, updated_at)
        values (${id}, ${i.purpose}, ${i.orderRef ?? null}, ${i.topupRef ?? null}, ${i.userRef}, ${i.gateway}, ${amount}, 'IRR', 'INITIATED', ${i.idempotencyKey}, ${hash}, ${iso(now)}::timestamptz, ${iso(now)}::timestamptz)
        on conflict (idempotency_key) do nothing returning ${COLS}`,
  );
  if (ins.rows.length === 1) return { payment: toView(ins.rows[0] as unknown as Row), replay: false };
  const ex = first<Row & { request_hash: Buffer }>(await tx.execute(sql`select ${COLS}, request_hash from payments where idempotency_key = ${i.idempotencyKey}`))!;
  if (!Buffer.from(ex.request_hash).equals(hash)) throw new DomainError("IDEMPOTENCY_CONFLICT", "payment key was used with different content");
  return { payment: toView(ex), replay: true };
}

export type StartOutcome = { status: "PENDING"; redirectUrl?: string; replay: boolean } | { status: "FAILED" } | { status: "INITIATED"; unknown: true } | { status: PaymentStatus; replay: true };

/**
 * Ask the gateway to create the payment — OUTSIDE any transaction. Safe to retry: the gateway receives our payment id as its
 * idempotency reference. REJECTED => FAILED; a thrown error leaves the payment INITIATED (unknown outcome, retry later).
 */
export async function startGatewayPayment(db: Database, deps: { gateway: PaymentGateway; clock: Clock }, paymentId: string): Promise<StartOutcome> {
  const p = first<Row>(await db.execute(sql`select ${COLS} from payments where id = ${paymentId}`));
  if (!p) throw new DomainError("PAYMENT_NOT_FOUND", "payment not found");
  if (p.gateway !== deps.gateway.key) throw new DomainError("PAYMENT_INVALID", "payment belongs to a different gateway");
  if (p.status !== "INITIATED") return { status: p.status, replay: true };
  let res: Awaited<ReturnType<PaymentGateway["createPayment"]>>;
  try {
    res = await deps.gateway.createPayment({ paymentId: p.id, amount: Number(p.amount) });
  } catch (e) {
    if (e instanceof DomainError) throw e; // misconfiguration is loud
    return { status: "INITIATED", unknown: true };
  }
  return withTransaction(db, async (tx): Promise<StartOutcome> => {
    const now = iso(deps.clock.now());
    await setTransitionContext(tx, { actorId: SYSTEM.id, reason: res.status === "CREATED" ? "gateway payment created" : "gateway rejected" });
    if (res.status === "REJECTED") {
      await tx.execute(sql`update payments set status = 'FAILED', review_reason = 'gateway rejected creation', updated_at = ${now}::timestamptz where id = ${paymentId} and status = 'INITIATED'`);
      return { status: "FAILED" };
    }
    const r = await tx.execute(sql`update payments set status = 'PENDING', gateway_ref = ${res.gatewayRef}, updated_at = ${now}::timestamptz where id = ${paymentId} and status = 'INITIATED' returning id`);
    return { status: "PENDING", ...(res.redirectUrl ? { redirectUrl: res.redirectUrl } : {}), replay: r.rows.length === 0 };
  });
}

export type VerifyOutcome =
  | { outcome: "UNKNOWN_REFERENCE" }
  | { outcome: "NOT_READY"; status: PaymentStatus }
  | { outcome: "FINAL"; status: PaymentStatus; replay: true }
  | { outcome: "IN_PROGRESS" }
  | { outcome: "SUPERSEDED" }
  | { outcome: "RETRY_LATER"; status: "VERIFYING" }
  | { outcome: "SUCCEEDED" | "FAILED" | "NEEDS_REVIEW"; status: PaymentStatus; replay: false };

export interface VerifyDeps { gateway: PaymentGateway; clock: Clock; leaseSeconds?: number; maxAttempts?: number }
export interface VerifyHooks {
  /** Runs INSIDE the transaction that marks the payment SUCCEEDED (credit a wallet, pay an order...). If it throws, everything rolls back. */
  onSucceeded?(tx: Tx, payment: PaymentView): Promise<void>;
}

/**
 * Verify a payment SERVER-TO-SERVER (a browser redirect/callback is only the trigger and carries no authority).
 * Phase 1 (tx): claim PENDING -> VERIFYING under a row lock + lease; duplicate callbacks lose here.
 * Phase 2 (NO tx): ask the gateway. Phase 3 (tx): record the result with exact integer-Rial comparison.
 * A missing/unknown reply is never a failure: the payment stays VERIFYING, is re-claimable after the lease, and moves to
 * NEEDS_REVIEW only after the attempt budget is spent. SUCCEEDED requires gateway status PAID, the same gateway reference and
 * amount === payment amount (also a CHECK in the database).
 */
export async function verifyPayment(db: Database, deps: VerifyDeps, input: { gatewayRef: string; eventKey: string; raw?: unknown }, hooks: VerifyHooks = {}): Promise<VerifyOutcome> {
  if (!input.gatewayRef || input.gatewayRef.length > 200 || !input.eventKey || input.eventKey.length > 200) return { outcome: "UNKNOWN_REFERENCE" };
  const lease = (deps.leaseSeconds ?? DEFAULT_VERIFY_LEASE_SECONDS) * 1000;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_VERIFY_ATTEMPTS;

  // ---- phase 1
  type Claim = { kind: "go"; payment: Row; token: string } | { kind: "done"; out: VerifyOutcome };
  const claim = await withTransaction(db, async (tx): Promise<Claim> => {
    const now = deps.clock.now();
    const p = first<Row>(await tx.execute(sql`select ${COLS} from payments where gateway = ${deps.gateway.key} and gateway_ref = ${input.gatewayRef} for update`));
    if (!p) return { kind: "done", out: { outcome: "UNKNOWN_REFERENCE" } };
    await tx.execute(
      sql`insert into payment_events (payment_id, gateway, event_key, kind, raw, received_at) values (${p.id}, ${p.gateway}, ${input.eventKey}, 'CALLBACK', ${JSON.stringify(redact(input.raw ?? null))}::jsonb, ${iso(now)}::timestamptz)
          on conflict (gateway, event_key) do nothing`,
    );
    if (FINAL_STATUSES.has(p.status)) return { kind: "done", out: { outcome: "FINAL", status: p.status, replay: true } };
    if (p.status === "INITIATED") return { kind: "done", out: { outcome: "NOT_READY", status: p.status } };
    await setTransitionContext(tx, { actorId: SYSTEM.id, reason: "verification started" });
    if (p.status === "VERIFYING") {
      const since = p.verifying_since ? toDate(p.verifying_since).getTime() : 0;
      if (now.getTime() - since < lease) return { kind: "done", out: { outcome: "IN_PROGRESS" } };
      if (p.verify_attempts >= maxAttempts) {
        await tx.execute(sql`update payments set status = 'NEEDS_REVIEW', review_reason = 'gateway did not answer', updated_at = ${iso(now)}::timestamptz where id = ${p.id}`);
        return { kind: "done", out: { outcome: "FINAL", status: "NEEDS_REVIEW", replay: true } };
      }
      await tx.execute(sql`update payments set verifying_since = ${iso(now)}::timestamptz, verify_attempts = verify_attempts + 1, updated_at = ${iso(now)}::timestamptz where id = ${p.id}`);
    } else {
      await tx.execute(sql`update payments set status = 'VERIFYING', verifying_since = ${iso(now)}::timestamptz, verify_attempts = verify_attempts + 1, updated_at = ${iso(now)}::timestamptz where id = ${p.id}`);
    }
    return { kind: "go", payment: p, token: iso(now) };
  });
  if (claim.kind === "done") return claim.out;

  // ---- phase 2: external call, no transaction open
  let reply: Awaited<ReturnType<PaymentGateway["verifyPayment"]>> | null = null;
  try {
    reply = await deps.gateway.verifyPayment({ gatewayRef: input.gatewayRef });
  } catch (e) {
    if (e instanceof DomainError && e.code === "PAYMENT_GATEWAY_NOT_CONFIGURED") throw e;
    reply = null;
  }

  // ---- phase 3
  return withTransaction(db, async (tx): Promise<VerifyOutcome> => {
    const now = deps.clock.now();
    const p = first<Row>(await tx.execute(sql`select ${COLS} from payments where id = ${claim.payment.id} for update`))!;
    if (p.status !== "VERIFYING" || !p.verifying_since || toDate(p.verifying_since).toISOString() !== claim.token) return { outcome: "SUPERSEDED" };
    await setTransitionContext(tx, { actorId: SYSTEM.id, reason: "verification result" });
    const stamp = iso(now);
    await tx.execute(
      sql`insert into payment_events (payment_id, gateway, event_key, kind, raw, received_at) values (${p.id}, ${p.gateway}, ${`${input.eventKey}:reply:${p.verify_attempts}`}, 'VERIFY_REPLY', ${JSON.stringify(redact(reply))}::jsonb, ${stamp}::timestamptz)
          on conflict (gateway, event_key) do nothing`,
    );
    if (!reply || reply.status === "UNKNOWN") {
      if (p.verify_attempts >= maxAttempts) {
        await tx.execute(sql`update payments set status = 'NEEDS_REVIEW', review_reason = 'gateway did not answer', updated_at = ${stamp}::timestamptz where id = ${p.id}`);
        await recordAudit(tx, { actor: SYSTEM, action: "payments.payment.needs_review", entity: { type: "payment", id: p.id }, metadata: { reason: "gateway did not answer" }, occurredAt: now });
        return { outcome: "NEEDS_REVIEW", status: "NEEDS_REVIEW", replay: false };
      }
      return { outcome: "RETRY_LATER", status: "VERIFYING" };
    }
    if (reply.status === "FAILED") {
      await tx.execute(sql`update payments set status = 'FAILED', review_reason = 'gateway reported failure', updated_at = ${stamp}::timestamptz where id = ${p.id}`);
      await recordAudit(tx, { actor: SYSTEM, action: "payments.payment.failed", entity: { type: "payment", id: p.id }, occurredAt: now });
      return { outcome: "FAILED", status: "FAILED", replay: false };
    }
    // PAID: exact integer comparison, same reference
    const paid = reply.amount;
    const exact = reply.gatewayRef === p.gateway_ref && typeof paid === "number" && Number.isSafeInteger(paid) && paid === Number(p.amount);
    if (exact) {
      await tx.execute(sql`update payments set status = 'SUCCEEDED', verified_at = ${stamp}::timestamptz, verified_amount = ${paid}, updated_at = ${stamp}::timestamptz where id = ${p.id}`);
      await enqueueOutbox(tx, { eventType: "payment.succeeded", aggregateType: "payment", aggregateId: p.id, payload: { paymentId: p.id, purpose: p.purpose } }, deps.clock);
      await recordAudit(tx, { actor: SYSTEM, action: "payments.payment.succeeded", entity: { type: "payment", id: p.id }, metadata: { purpose: p.purpose, amount: Number(p.amount) }, occurredAt: now });
      if (hooks.onSucceeded) await hooks.onSucceeded(tx, { ...toView(p), status: "SUCCEEDED", verifiedAt: now });
      return { outcome: "SUCCEEDED", status: "SUCCEEDED", replay: false };
    }
    // Mismatch: money may really have arrived -> park the RECEIVED amount in suspense (D9), never credit anything.
    let posted = false;
    if (typeof paid === "number" && Number.isSafeInteger(paid) && paid > 0 && paid <= MAX_RIAL_AMOUNT) {
      await ensureAccount(tx, gatewayReceivable(p.gateway), SYSTEM, { clock: deps.clock });
      await ensureAccount(tx, systemAccount("SUSPENSE_UNRESOLVED_RECEIPTS"), SYSTEM, { clock: deps.clock });
      await post(tx, { kind: "SUSPENSE_RECEIPT", idempotencyKey: `payrecv:${p.id}`, reference: { type: "payment", id: p.id }, entries: suspenseReceipt({ gatewayKey: p.gateway, amount: paid }), description: "payment amount/reference mismatch", actor: SYSTEM }, { clock: deps.clock });
      posted = true;
    }
    await tx.execute(sql`update payments set status = 'NEEDS_REVIEW', review_reason = ${posted ? "amount or reference mismatch (received amount in suspense)" : "amount or reference mismatch"}, updated_at = ${stamp}::timestamptz where id = ${p.id}`);
    await recordAudit(tx, { actor: SYSTEM, action: "payments.payment.needs_review", entity: { type: "payment", id: p.id }, metadata: { reason: "mismatch", expected: Number(p.amount), received: typeof paid === "number" ? paid : null, suspense: posted }, occurredAt: now });
    return { outcome: "NEEDS_REVIEW", status: "NEEDS_REVIEW", replay: false };
  });
}

/** Gateway references of payments stuck in VERIFYING past their lease: a worker re-runs verifyPayment for them. */
export async function listVerificationDue(db: Database, clock: Clock, opts: { limit?: number; leaseSeconds?: number } = {}): Promise<string[]> {
  const cutoff = new Date(clock.now().getTime() - (opts.leaseSeconds ?? DEFAULT_VERIFY_LEASE_SECONDS) * 1000);
  const r = await db.execute(sql`select gateway_ref from payments where status = 'VERIFYING' and verifying_since <= ${iso(cutoff)}::timestamptz order by verifying_since limit ${Math.min(opts.limit ?? 50, 200)}`);
  return (r.rows as { gateway_ref: string }[]).map((x) => x.gateway_ref);
}

export async function getPayment(db: Database | Tx, paymentId: string): Promise<PaymentView | null> {
  const r = first<Row>(await db.execute(sql`select ${COLS} from payments where id = ${paymentId}`));
  return r ? toView(r) : null;
}

export async function findPaymentByGatewayRef(db: Database | Tx, gateway: string, gatewayRef: string): Promise<PaymentView | null> {
  const r = first<Row>(await db.execute(sql`select ${COLS} from payments where gateway = ${gateway} and gateway_ref = ${gatewayRef}`));
  return r ? toView(r) : null;
}

/** Customer-scoped read (IDOR-safe): a payment of another user is indistinguishable from a missing one. */
export async function getPaymentForUser(db: Database | Tx, userRef: string, paymentId: string): Promise<PaymentView | null> {
  const r = first<Row>(await db.execute(sql`select ${COLS} from payments where id = ${paymentId} and user_ref = ${userRef}`));
  return r ? toView(r) : null;
}

export interface PaymentsAdminContext { db: Database; authorize(permission: string): Promise<void> }

export async function getPaymentAdmin(c: PaymentsAdminContext, paymentId: string): Promise<PaymentView> {
  await c.authorize("payments.read");
  const p = await getPayment(c.db, paymentId);
  if (!p) throw new DomainError("PAYMENT_NOT_FOUND", "payment not found");
  return p;
}

/** Reconciliation: every SUCCEEDED payment must be accounted for by its purpose's owner module; this lists payments in states needing attention. */
export async function listNeedingReview(c: PaymentsAdminContext, limit = 50): Promise<PaymentView[]> {
  await c.authorize("payments.read");
  const r = await c.db.execute(sql`select ${COLS} from payments where status = 'NEEDS_REVIEW' order by created_at limit ${Math.min(limit, 200)}`);
  return (r.rows as unknown as Row[]).map(toView);
}

/**
 * Close a NEEDS_REVIEW payment as FAILED once the money it brought in has been returned (refund completed by the order flow, in the
 * SAME transaction). There is no way to turn a reviewed payment into SUCCEEDED here: accepting a mismatching amount is an open policy (B12).
 */
export async function closeReviewedPayment(tx: Tx, clock: Clock, paymentId: string, note: string): Promise<boolean> {
  if (note.trim().length < 5) throw new DomainError("PAYMENT_INVALID", "a note is required");
  await setTransitionContext(tx, { actorId: SYSTEM.id, reason: note.trim().slice(0, 200) });
  const r = await tx.execute(sql`update payments set status = 'FAILED', review_reason = ${`closed after refund: ${note.trim().slice(0, 150)}`}, updated_at = ${iso(clock.now())}::timestamptz where id = ${paymentId} and status = 'NEEDS_REVIEW' returning id`);
  if (r.rows.length) await recordAudit(tx, { actor: SYSTEM, action: "payments.payment.review_closed", entity: { type: "payment", id: paymentId }, occurredAt: clock.now() });
  return r.rows.length === 1;
}
