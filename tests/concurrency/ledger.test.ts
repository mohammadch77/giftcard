import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAudit } from "@/modules/audit";
import type { AuditActor } from "@/modules/audit";
import { adminWalletDebit, ensureAccount, getBalance, post, reverse, trialBalance, verifyIntegrity, walletAccount, walletTopUp } from "@/modules/ledger";
import type { AccountSpec, PostEntry } from "@/modules/ledger";
import { withTransaction } from "@/platform/db";
import type { DatabaseHandle } from "@/platform/db";
import { ManualClock } from "@/platform/clock/testing";
import { createDatabaseAsRole, createTestDatabase, createTestRoles } from "../helpers/db";
import type { TestDatabase } from "../helpers/db";

/** All concurrent work uses the least-privilege application role and a pool of 10 real connections. */
let t: TestDatabase;
let app: DatabaseHandle;
const clock = new ManualClock("2026-07-01T00:00:00Z");
const system: AuditActor = { type: "SYSTEM", id: "system:conc" };
const gw = { code: "GATEWAY_RECEIVABLE", ownerType: "gateway", ownerId: "gw1" };
const toEntries = (rule: { account: AccountSpec; side: "DEBIT" | "CREDIT"; amount: number }[]): PostEntry[] => rule.map((r) => ({ account: r.account, side: r.side, amount: r.amount }));
const codeOf = (e: unknown) => (e as { code?: string }).code ?? "OTHER";
const pgCodeOf = (e: unknown) => ((e as { cause?: { code?: string }; code?: string }).cause?.code ?? (e as { code?: string }).code);

beforeAll(async () => {
  t = await createTestDatabase();
  app = createDatabaseAsRole(t, (await createTestRoles(t)).appRole);
  await withTransaction(app.db, async (tx) => {
    await ensureAccount(tx, gw, system, { clock });
    await ensureAccount(tx, { code: "ADJUSTMENT_EXPENSE" }, system, { clock });
  });
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

const fund = (user: string, amount: number, key: string) =>
  withTransaction(app.db, async (tx) => {
    await ensureAccount(tx, walletAccount(user), system, { clock });
    return post(tx, { kind: "WALLET_TOPUP", idempotencyKey: key, reference: { type: "payment", id: key }, entries: toEntries(walletTopUp({ userId: user, gatewayKey: "gw1", amount })), actor: system }, { clock });
  });

const debit = (user: string, amount: number, key: string) =>
  withTransaction(app.db, (tx) =>
    post(tx, { kind: "WALLET_SPEND", idempotencyKey: key, reference: { type: "order", id: key }, entries: toEntries(adminWalletDebit({ userId: user, amount })), actor: system }, { clock }),
  );

const auditCount = async (action: string) => (await t.pool.query("select count(*)::int n from audit_logs where action = $1", [action])).rows[0].n as number;
const txnCount = async (where = "true") => (await t.pool.query(`select count(*)::int n from ledger_transactions where ${where}`)).rows[0].n as number;

describe("ledger under concurrency", () => {
  it("S2: 500 parallel debits against one wallet of 1,500,000 Rial: exactly 150 succeed, never negative, ledger and audit agree", async () => {
    await fund("w-s2", 1_500_000, "fund-s2-0001");
    const outcomes = await Promise.allSettled(Array.from({ length: 500 }, (_, i) => debit("w-s2", 10_000, `s2-debit-${i}-aaaa`)));
    const ok = outcomes.filter((o) => o.status === "fulfilled").length;
    const insufficient = outcomes.filter((o) => o.status === "rejected" && codeOf(o.reason) === "INSUFFICIENT_FUNDS").length;
    expect(ok).toBe(150);
    expect(insufficient).toBe(350);
    expect(await getBalance(app.db, walletAccount("w-s2"))).toBe(0);
    expect(await txnCount("kind = 'WALLET_SPEND'")).toBe(150);
    expect(await auditCount("ledger.post")).toBe(await txnCount("kind <> 'REVERSAL'")); // failed attempts left no audit residue
    expect(await verifyIntegrity(app.db)).toEqual([]);
  });

  it("100 parallel postings with ONE idempotency key create one transaction, one audit row and change the balance once", async () => {
    const before = await txnCount();
    const results = await Promise.all(Array.from({ length: 100 }, () => fund("w-idem", 123_000, "idem-same-key-1")));
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed).length).toBe(1);
    expect(await txnCount()).toBe(before + 1);
    expect(await getBalance(app.db, walletAccount("w-idem"))).toBe(123_000);
    expect((await listAudit(app.db, { entityId: "idem-same-key-1" })).length).toBe(1);
  });

  it("100 parallel postings with one key but DIFFERENT amounts: one wins, all others conflict, nothing is double-posted", async () => {
    const outcomes = await Promise.allSettled(Array.from({ length: 100 }, (_, i) => fund("w-idem2", 1_000 + (i % 2), "idem-diff-key-1")));
    const ok = outcomes.filter((o) => o.status === "fulfilled");
    const conflicts = outcomes.filter((o) => o.status === "rejected" && codeOf(o.reason) === "IDEMPOTENCY_CONFLICT");
    expect(ok.length + conflicts.length).toBe(100);
    expect(ok.length).toBeGreaterThan(0);
    expect((await listAudit(app.db, { entityId: "idem-diff-key-1" })).length).toBe(1);
    const bal = await getBalance(app.db, walletAccount("w-idem2"));
    expect([1_000, 1_001]).toContain(bal);
  });

  it("300 parallel transfers among 12 accounts in both directions: no deadlock, nothing lost, totals conserved, ledger consistent", async () => {
    const accounts = Array.from({ length: 12 }, (_, i): AccountSpec => ({ code: "GATEWAY_RECEIVABLE", ownerType: "gateway", ownerId: `xfer-${i}` }));
    await withTransaction(app.db, async (tx) => { for (const a of accounts) await ensureAccount(tx, a, system, { clock }); });
    let seed = 99;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 300 }, (_, i) => {
        const from = rnd() % 12;
        const to = (from + 1 + (rnd() % 11)) % 12;
        const amount = 1_000 + (rnd() % 9_000);
        return withTransaction(app.db, (tx) =>
          post(tx, { kind: "TRANSFER", idempotencyKey: `xfer-key-${i}-zz`, reference: { type: "transfer", id: String(i) }, entries: [
            { account: accounts[from] as AccountSpec, side: "DEBIT", amount }, { account: accounts[to] as AccountSpec, side: "CREDIT", amount },
          ], actor: system }, { clock }));
      }),
    );
    const failures = outcomes.filter((o) => o.status === "rejected") as PromiseRejectedResult[];
    expect(failures.filter((f) => pgCodeOf(f.reason) === "40P01").length).toBe(0); // no deadlocks
    // every failure (if any) is classified; none may be silent
    expect(failures.length).toBe(0);
    const tb = await trialBalance(app.db);
    expect(tb.balanced).toBe(true);
    const xferRows = tb.rows.filter((r) => r.ownerId?.startsWith("xfer-"));
    expect(xferRows.length).toBe(12);
    expect(xferRows.reduce((s, r) => s + r.balance, 0)).toBe(0); // DR-normal assets: debits minus credits across the group nets to zero
    expect(await verifyIntegrity(app.db)).toEqual([]);
  });

  it("20 concurrent reversal attempts (different keys) on one transaction: exactly one succeeds", async () => {
    const orig = await fund("w-rev", 90_000, "rev-origin-1");
    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        withTransaction(app.db, (tx) => reverse(tx, { originalTransactionId: orig.transactionId, idempotencyKey: `rev-attempt-${i}-xx`, reason: "concurrent reversal test", actor: { type: "ADMIN", id: "admin:1" } }, { clock })),
      ),
    );
    expect(outcomes.filter((o) => o.status === "fulfilled").length).toBe(1);
    expect(outcomes.filter((o) => o.status === "rejected" && codeOf(o.reason) === "LEDGER_REVERSAL_INVALID").length).toBe(19);
    expect(await getBalance(app.db, walletAccount("w-rev"))).toBe(0);
    expect(await txnCount(`reverses_id = ${orig.transactionId}`)).toBe(1);
  });

  it("20 concurrent reversals with the SAME key: one reversal, the rest replay it", async () => {
    const orig = await fund("w-rev2", 5_000, "rev-origin-2");
    const results = await Promise.all(
      Array.from({ length: 20 }, () => withTransaction(app.db, (tx) => reverse(tx, { originalTransactionId: orig.transactionId, idempotencyKey: "rev-same-key-1", reason: "same key reversal", actor: { type: "ADMIN", id: "admin:1" } }, { clock }))),
    );
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed).length).toBe(1);
    expect(await getBalance(app.db, walletAccount("w-rev2"))).toBe(0);
  });

  it("50 parallel ensureAccount calls create one account and one audit record", async () => {
    await Promise.all(Array.from({ length: 50 }, () => withTransaction(app.db, (tx) => ensureAccount(tx, walletAccount("w-race"), system, { clock }))));
    expect((await t.pool.query("select count(*)::int n from ledger_accounts where owner_id = 'w-race'")).rows[0].n).toBe(1);
    expect((await listAudit(app.db, { entityType: "ledger_account", entityId: "CUSTOMER_WALLET:user:w-race" })).length).toBe(1);
  });

  it("mixed random credits and debits on one wallet: final balance = credits - successful debits, never below zero", async () => {
    await fund("w-mix", 50_000, "mix-initial-1");
    let seed = 5;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff);
    const ops = Array.from({ length: 200 }, (_, i) => ({ credit: rnd() % 3 === 0, amount: 1_000 + (rnd() % 4_000), key: `mix-op-${i}-qq` }));
    const outcomes = await Promise.allSettled(ops.map((o) => (o.credit ? fund("w-mix", o.amount, o.key) : debit("w-mix", o.amount, o.key))));
    let expected = 50_000;
    ops.forEach((o, i) => {
      if (outcomes[i]?.status === "fulfilled") expected += o.credit ? o.amount : -o.amount;
    });
    expect(await getBalance(app.db, walletAccount("w-mix"))).toBe(expected);
    expect(expected).toBeGreaterThanOrEqual(0);
    for (const [i, o] of outcomes.entries()) if (o.status === "rejected") expect(ops[i]?.credit === false && codeOf(o.reason) === "INSUFFICIENT_FUNDS").toBe(true);
    expect(await verifyIntegrity(app.db)).toEqual([]);
  });

  it("reports taken while 150 postings run concurrently are always consistent snapshots (no false findings)", async () => {
    await fund("w-snap", 10_000_000, "snap-initial-1");
    const writers = Array.from({ length: 150 }, (_, i) => debit("w-snap", 1_000 + i, `snap-debit-${i}-ww`));
    const readers = Array.from({ length: 30 }, async () => {
      const findings = await verifyIntegrity(app.db);
      const tb = await trialBalance(app.db);
      return { findings, balanced: tb.balanced, projectionMatches: tb.rows.every((r) => r.projectionBalance === r.balance) };
    });
    const [, reads] = await Promise.all([Promise.all(writers), Promise.all(readers)]);
    for (const r of reads) {
      expect(r.findings).toEqual([]);
      expect(r.balanced).toBe(true);
      expect(r.projectionMatches).toBe(true);
    }
  });

  it("at the end the whole ledger is balanced, matches its projection, and every transaction has its audit record", async () => {
    expect(await verifyIntegrity(app.db)).toEqual([]);
    const tb = await trialBalance(app.db);
    expect(tb.balanced).toBe(true);
    const linked = await t.pool.query(`select count(*)::int n from ledger_transactions t join audit_logs a on a.id = t.audit_log_id and a.entity_id = t.idempotency_key`);
    expect(linked.rows[0].n).toBe(await txnCount());
  });
});
