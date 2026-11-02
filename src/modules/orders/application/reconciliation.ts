import { sql } from "drizzle-orm";
import { recordAudit } from "@/modules/audit";
import type { AuditActor } from "@/modules/audit";
import { verifyIntegrity } from "@/modules/ledger";
import { getReservationStatuses, verifyInventory } from "@/modules/inventory";
import { findIncompleteSucceededTopUps } from "@/modules/wallet";
import { listNeedingReview, listVerificationDue } from "@/modules/payments";
import { outboxStats } from "@/platform/outbox";
import { withTransaction } from "@/platform/db";
import type { Database } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { uuidv7 } from "@/platform/ids";
import { iso } from "./core";
import type { OrdersDeps } from "./core";

/**
 * Reconciliation = READ-ONLY detection. It never repairs money; every finding is recorded (append-only) for a human. Thresholds are
 * technical parameters passed by the caller (not business policy).
 */
export type ReconJob = "LEDGER_INTEGRITY" | "INVENTORY_INTEGRITY" | "PAID_ORDER_POSTING" | "PAYMENTS_STUCK" | "TOPUPS_INCOMPLETE" | "REFUNDS_UNRESOLVED" | "HOLDS_AGED" | "SUPPLIER_UNRESOLVED" | "OUTBOX_HEALTH" | "RESERVATIONS_LEAKED";
export const ALL_JOBS: readonly ReconJob[] = ["LEDGER_INTEGRITY", "INVENTORY_INTEGRITY", "PAID_ORDER_POSTING", "PAYMENTS_STUCK", "TOPUPS_INCOMPLETE", "REFUNDS_UNRESOLVED", "HOLDS_AGED", "SUPPLIER_UNRESOLVED", "OUTBOX_HEALTH", "RESERVATIONS_LEAKED"];
export interface ReconFinding { job: ReconJob; severity: "INFO" | "WARN" | "CRITICAL"; subject: string; detail: string }
export interface ReconOptions {
  jobs?: readonly ReconJob[];
  staleSeconds?: number;
  /** Supplied by the composition root (orders may not import suppliers): ids of supplier orders unresolved past the threshold. Without it the job reports 'not wired'. */
  supplierUnresolved?: (olderThanSeconds: number) => Promise<{ id: string }[]>;
}

export async function runChecks(db: Database, deps: OrdersDeps, opts: ReconOptions = {}): Promise<ReconFinding[]> {
  const jobs = opts.jobs ?? ALL_JOBS;
  const stale = opts.staleSeconds ?? 900;
  const out: ReconFinding[] = [];
  const add = (job: ReconJob, severity: ReconFinding["severity"], subject: string, detail: string) => out.push({ job, severity, subject, detail });
  const cutoff = iso(new Date(deps.clock.now().getTime() - stale * 1000));
  const rows = async (q: ReturnType<typeof sql>) => (await db.execute(q)).rows as Record<string, unknown>[];

  if (jobs.includes("LEDGER_INTEGRITY")) for (const f of await verifyIntegrity(db)) add("LEDGER_INTEGRITY", "CRITICAL", String((f as { subject?: string }).subject ?? "ledger"), JSON.stringify(f).slice(0, 500));
  if (jobs.includes("INVENTORY_INTEGRITY")) for (const f of await verifyInventory(db)) add("INVENTORY_INTEGRITY", "CRITICAL", String((f as { subject?: string }).subject ?? "inventory"), JSON.stringify(f).slice(0, 500));
  if (jobs.includes("PAID_ORDER_POSTING")) {
    for (const r of await rows(sql`select id from orders where status in ('PAID','FULFILLING','PARTIALLY_COMPLETED','COMPLETED') and settlement_ledger_txn_id is null`)) add("PAID_ORDER_POSTING", "WARN", `order:${r.id}`, "paid order has no settlement ledger posting");
    for (const r of await rows(sql`select o.id from orders o where o.status = 'CANCELLED' and o.paid_at is not null and not exists (select 1 from refunds f where f.order_id = o.id and f.status = 'COMPLETED')`)) add("PAID_ORDER_POSTING", "CRITICAL", `order:${r.id}`, "paid order cancelled without a completed refund");
  }
  if (jobs.includes("PAYMENTS_STUCK")) {
    for (const p of await listNeedingReview({ db, authorize: async () => undefined }, 100) /* caller already holds orders.reconciliation.run; read-only */) add("PAYMENTS_STUCK", "WARN", `payment:${p.id}`, "payment needs manual review");
    for (const ref of await listVerificationDue(db, deps.clock, { leaseSeconds: stale, limit: 100 })) add("PAYMENTS_STUCK", "INFO", `gateway_ref:${ref}`, "payment verification is overdue (stuck VERIFYING past the stale threshold)");
  }
  if (jobs.includes("TOPUPS_INCOMPLETE")) for (const t of await findIncompleteSucceededTopUps(db, 100)) add("TOPUPS_INCOMPLETE", "CRITICAL", `topup:${String((t as { id?: string }).id ?? t)}`, "payment SUCCEEDED but the wallet credit is not complete");
  if (jobs.includes("REFUNDS_UNRESOLVED")) {
    for (const r of await rows(sql`select id, status, external_outcome from refunds where status = 'PROCESSING' and updated_at <= ${cutoff}::timestamptz`)) add("REFUNDS_UNRESOLVED", r.external_outcome === "CONFIRMED" ? "CRITICAL" : "WARN", `refund:${r.id}`, `refund PROCESSING with gateway outcome ${r.external_outcome}: unresolved`);
    for (const r of await rows(sql`select id from refunds where status = 'FAILED'`)) add("REFUNDS_UNRESOLVED", "INFO", `refund:${r.id}`, "refund FAILED; awaiting retry or closure");
    for (const r of await rows(sql`select id from refunds where status = 'COMPLETED' and destination = 'GATEWAY' and external_outcome <> 'CONFIRMED'`)) add("REFUNDS_UNRESOLVED", "CRITICAL", `refund:${r.id}`, "completed gateway refund without a confirmed gateway outcome");
  }
  if (jobs.includes("HOLDS_AGED")) for (const r of await rows(sql`select id, reason from order_holds where resolved_at is null and opened_at <= ${cutoff}::timestamptz`)) add("HOLDS_AGED", "WARN", `hold:${r.id}`, `open ${r.reason} hold past the stale threshold`);
  if (jobs.includes("SUPPLIER_UNRESOLVED")) {
    if (!opts.supplierUnresolved) add("SUPPLIER_UNRESOLVED", "WARN", "job", "supplier reconciliation is not wired into this run (composition must supply it)");
    else for (const s of await opts.supplierUnresolved(stale)) add("SUPPLIER_UNRESOLVED", "WARN", `supplier_order:${s.id}`, "supplier order unresolved past the stale threshold");
  }
  if (jobs.includes("OUTBOX_HEALTH")) {
    const st = await outboxStats(db, deps.clock);
    if (st.dead > 0) add("OUTBOX_HEALTH", "CRITICAL", "outbox", `${st.dead} dead-lettered event(s)`);
    if (st.oldestPendingSeconds > stale) add("OUTBOX_HEALTH", "WARN", "outbox", `oldest pending event is ${st.oldestPendingSeconds}s old`);
  }
  if (jobs.includes("RESERVATIONS_LEAKED")) {
    const live = await rows(sql`select id, reservation_id from orders where status in ('CANCELLED','EXPIRED') and reservation_id is not null`);
    const st = await getReservationStatuses(db, live.map((l) => String(l.reservation_id)));
    for (const l of live) if (st.get(String(l.reservation_id)) === "ACTIVE") add("RESERVATIONS_LEAKED", "WARN", `order:${l.id}`, "closed order still holds an ACTIVE reservation");
  }
  return out;
}

/** Run + persist (append-only). Detection only; records an audit entry. */
export async function runReconciliation(deps: OrdersDeps, admin: { actor: AuditActor; authorize(permission: string): Promise<void> }, opts: ReconOptions = {}): Promise<{ runId: string; findings: ReconFinding[] }> {
  await admin.authorize("orders.reconciliation.run");
  const findings = await runChecks(deps.db, deps, opts);
  const runId = uuidv7(deps.clock);
  await withTransaction(deps.db, async (tx) => {
    const now = iso(deps.clock.now());
    await tx.execute(sql`insert into reconciliation_runs (id, started_by, started_at, jobs, finding_count) values (${runId}, ${admin.actor.id}, ${now}::timestamptz, ${(opts.jobs ?? ALL_JOBS).join(",")}, 0)`);
    for (const f of findings) await tx.execute(sql`insert into reconciliation_findings (run_id, job, severity, subject, detail, found_at) values (${runId}, ${f.job}, ${f.severity}, ${f.subject}, ${f.detail.slice(0, 1000)}, ${now}::timestamptz)`);
    await tx.execute(sql`update reconciliation_runs set finished_at = ${now}::timestamptz, finding_count = ${findings.length} where id = ${runId}`);
    await recordAudit(tx, { actor: admin.actor, action: "orders.reconciliation.run", entity: { type: "reconciliation_run", id: runId }, metadata: { findings: findings.length, critical: findings.filter((f) => f.severity === "CRITICAL").length }, occurredAt: deps.clock.now() });
  });
  return { runId, findings };
}

export async function listFindings(c: { db: Database; authorize(permission: string): Promise<void> }, runId: string): Promise<ReconFinding[]> {
  await c.authorize("orders.reconciliation.read");
  const r = (await c.db.execute(sql`select job, severity, subject, detail from reconciliation_findings where run_id = ${runId} order by id`)).rows as unknown as ReconFinding[];
  if (r.length === 0 && !(await c.db.execute(sql`select 1 from reconciliation_runs where id = ${runId}`)).rows.length) throw new DomainError("REFUND_NOT_FOUND", "run not found");
  return r;
}
