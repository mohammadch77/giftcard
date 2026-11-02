import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAudit } from "@/modules/audit";
import type { AuditActor } from "@/modules/audit";
import {
  adminWalletCredit, adminWalletDebit, ensureAccount, getBalance, getTransaction, post, reverse, suspenseReceipt, suspenseToWallet, trialBalance, verifyIntegrity,
  walletAccount, walletTopUp,
} from "@/modules/ledger";
import type { PostEntry, RuleEntry } from "@/modules/ledger";
import { withTransaction } from "@/platform/db";
import type { DatabaseHandle } from "@/platform/db";
import { ManualClock } from "@/platform/clock/testing";
import { asRole, createDatabaseAsRole, createTestDatabase, createTestRoles } from "../helpers/db";
import type { TestDatabase } from "../helpers/db";

/** Every call below runs through the application role (least privilege) — never as superuser. */
let t: TestDatabase;
let app: DatabaseHandle;
const clock = new ManualClock("2026-06-01T10:00:00Z");
const system: AuditActor = { type: "SYSTEM", id: "system:test" };
const admin: AuditActor = { type: "ADMIN", id: "admin:42" };
let n = 0;
const k = (p: string) => `${p}-${++n}-${Math.random().toString(36).slice(2, 7)}`;
const toEntries = (rule: RuleEntry[]): PostEntry[] => rule.map((r) => ({ account: r.account, side: r.side, amount: r.amount }));
const counts = async () => (await t.pool.query("select (select count(*) from ledger_transactions)::int t, (select count(*) from ledger_entries)::int e, (select count(*) from audit_logs)::int a")).rows[0] as { t: number; e: number; a: number };
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? "OTHER"; } return "NO_ERROR"; };

beforeAll(async () => {
  t = await createTestDatabase();
  const roles = await createTestRoles(t);
  app = createDatabaseAsRole(t, roles.appRole);
  await withTransaction(app.db, async (tx) => {
    for (const a of [{ code: "GATEWAY_RECEIVABLE", ownerType: "gateway", ownerId: "gw1" }, { code: "SUSPENSE_UNRESOLVED_RECEIPTS" }, { code: "ADJUSTMENT_EXPENSE" }]) await ensureAccount(tx, a, system, { clock });
  });
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

const topUp = (user: string, amount: number, key = k("topup")) =>
  withTransaction(app.db, async (tx) => {
    await ensureAccount(tx, walletAccount(user), system, { clock });
    return post(tx, { kind: "WALLET_TOPUP", idempotencyKey: key, reference: { type: "payment", id: key }, entries: toEntries(walletTopUp({ userId: user, gatewayKey: "gw1", amount })), actor: system }, { clock });
  });

describe("accounts", () => {
  it("ensureAccount is idempotent, takes its definition from the chart and is audited once", async () => {
    const a = await withTransaction(app.db, (tx) => ensureAccount(tx, walletAccount("acc-user"), system, { clock }));
    const b = await withTransaction(app.db, (tx) => ensureAccount(tx, walletAccount("acc-user"), system, { clock }));
    expect(b.id).toBe(a.id);
    expect(a).toMatchObject({ code: "CUSTOMER_WALLET", type: "LIABILITY", normalSide: "CREDIT", minBalance: 0, chartVersion: "proposed-0", contra: false });
    const audits = await listAudit(app.db, { entityType: "ledger_account", action: "ledger.account.create" });
    expect(audits.filter((x) => x.entityId === "CUSTOMER_WALLET:user:acc-user").length).toBe(1);
  });
  it("rejects unknown chart codes and owners that do not match the chart scope", async () => {
    await expect(withTransaction(app.db, (tx) => ensureAccount(tx, { code: "NOT_IN_CHART" }, system))).rejects.toThrow();
    expect(await code(withTransaction(app.db, (tx) => ensureAccount(tx, { code: "CUSTOMER_WALLET" }, system)))).toBe("LEDGER_INVALID");
    expect(await code(withTransaction(app.db, (tx) => ensureAccount(tx, { code: "COGS", ownerType: "user", ownerId: "x" }, system)))).toBe("LEDGER_INVALID");
  });
  it("posting to a missing account fails cleanly", async () => {
    const before = await counts();
    expect(await code(withTransaction(app.db, (tx) => post(tx, { kind: "WALLET_TOPUP", idempotencyKey: k("miss"), reference: { type: "payment", id: "1" }, entries: toEntries(walletTopUp({ userId: "ghost-user", gatewayKey: "gw1", amount: 10 })), actor: system })))).toBe("LEDGER_ACCOUNT_NOT_FOUND");
    expect(await counts()).toEqual(before);
  });
});

describe("posting", () => {
  it("a wallet top-up credits the wallet (a LIABILITY) and writes entries + exactly one audit record linked to the transaction", async () => {
    const key = k("topup");
    const res = await topUp("u-post", 1_500_000, key);
    expect(res.replayed).toBe(false);
    expect(await getBalance(app.db, walletAccount("u-post"))).toBe(1_500_000);
    expect(await getBalance(app.db, { code: "GATEWAY_RECEIVABLE", ownerType: "gateway", ownerId: "gw1" })).toBeGreaterThanOrEqual(1_500_000);
    const view = await getTransaction(app.db, res.transactionId);
    expect(view).toMatchObject({ kind: "WALLET_TOPUP", idempotencyKey: key, reversesId: null, actor: system });
    expect(view?.entries.map((e) => [e.side, e.amount]).sort()).toEqual([["CREDIT", 1_500_000], ["DEBIT", 1_500_000]]);
    const audit = (await listAudit(app.db, { entityType: "ledger_transaction", entityId: key }))[0];
    expect(audit).toMatchObject({ action: "ledger.post", actorType: "SYSTEM", actorId: "system:test" });
    expect(audit?.occurredAt.toISOString()).toBe("2026-06-01T10:00:00.000Z");
    expect((audit?.after as { kind: string }).kind).toBe("WALLET_TOPUP");
  });

  it("replaying the same key returns the same transaction without a second posting, audit row or balance change", async () => {
    const key = k("replay");
    const first = await topUp("u-replay", 100_000, key);
    const before = await counts();
    const again = await topUp("u-replay", 100_000, key);
    expect(again).toEqual({ transactionId: first.transactionId, replayed: true });
    expect(await counts()).toEqual(before);
    expect(await getBalance(app.db, walletAccount("u-replay"))).toBe(100_000);
  });

  it("the same key with a different amount, account or kind is an IDEMPOTENCY_CONFLICT and changes nothing", async () => {
    const key = k("conflict");
    await topUp("u-conf", 50_000, key);
    const before = await counts();
    expect(await code(topUp("u-conf", 50_010, key))).toBe("IDEMPOTENCY_CONFLICT");
    expect(await counts()).toEqual(before);
  });

  it("domain validation fails before the database (unbalanced, one entry, bad amounts, bad formats, missing reason)", async () => {
    const w = walletAccount("u-post");
    const base = { kind: "WALLET_TOPUP", idempotencyKey: k("val"), reference: { type: "payment", id: "1" }, actor: system } as const;
    const run = (over: object) => code(withTransaction(app.db, (tx) => post(tx, { ...base, idempotencyKey: k("val"), entries: [], ...over } as never)));
    const gw = { code: "GATEWAY_RECEIVABLE", ownerType: "gateway", ownerId: "gw1" };
    expect(await run({ entries: [{ account: gw, side: "DEBIT", amount: 10 }, { account: w, side: "CREDIT", amount: 9 }] })).toBe("LEDGER_UNBALANCED");
    expect(await run({ entries: [{ account: gw, side: "DEBIT", amount: 10 }] })).toBe("LEDGER_INVALID");
    expect(await run({ entries: [{ account: gw, side: "DEBIT", amount: 0 }, { account: w, side: "CREDIT", amount: 0 }] })).toBe("LEDGER_INVALID");
    expect(await run({ kind: "lower", entries: [{ account: gw, side: "DEBIT", amount: 1 }, { account: w, side: "CREDIT", amount: 1 }] })).toBe("LEDGER_INVALID");
    expect(await run({ kind: "ADMIN_ADJUSTMENT", entries: toEntries(adminWalletCredit({ userId: "u-post", amount: 5 })) })).toBe("LEDGER_INVALID"); // reason required
    expect(await run({ kind: "REVERSAL", entries: toEntries(adminWalletCredit({ userId: "u-post", amount: 5 })) })).toBe("LEDGER_INVALID"); // must use reverse()
  });

  it("admin adjustments need a reason and record who/why in the audit trail", async () => {
    await topUp("u-adm", 10_000);
    const key = k("adj");
    await withTransaction(app.db, (tx) => post(tx, { kind: "ADMIN_ADJUSTMENT", idempotencyKey: key, reference: { type: "adjustment", id: "adj-1" }, entries: toEntries(adminWalletDebit({ userId: "u-adm", amount: 4_000 })), reason: "chargeback correction ticket #77", actor: admin, requestId: "req-abc" }, { clock }));
    expect(await getBalance(app.db, walletAccount("u-adm"))).toBe(6_000);
    const audit = (await listAudit(app.db, { entityId: key }))[0];
    expect(audit).toMatchObject({ actorType: "ADMIN", actorId: "admin:42", requestId: "req-abc" });
    expect((audit?.metadata as { reason: string }).reason).toBe("chargeback correction ticket #77");
  });

  it("late-payment money goes to suspense and can be resolved into a wallet — all liabilities, no revenue", async () => {
    await withTransaction(app.db, (tx) => post(tx, { kind: "SUSPENSE_RECEIPT", idempotencyKey: k("susp"), reference: { type: "payment", id: "late-1" }, entries: toEntries(suspenseReceipt({ gatewayKey: "gw1", amount: 70_000 })), actor: system }, { clock }));
    await withTransaction(app.db, async (tx) => {
      await ensureAccount(tx, walletAccount("u-late"), system, { clock });
      await post(tx, { kind: "SUSPENSE_RESOLUTION", idempotencyKey: k("susp2"), reference: { type: "payment", id: "late-1" }, entries: toEntries(suspenseToWallet({ userId: "u-late", amount: 70_000 })), actor: admin }, { clock });
    });
    expect(await getBalance(app.db, walletAccount("u-late"))).toBe(70_000);
    const tb = await trialBalance(app.db);
    expect(tb.rows.filter((r) => r.type === "REVENUE" && r.balance !== 0)).toEqual([]);
  });
});

describe("failure handling", () => {
  it("insufficient funds => INSUFFICIENT_FUNDS and the WHOLE posting (audit row too) is rolled back; the outer transaction stays usable", async () => {
    await topUp("u-poor", 1_000);
    const before = await counts();
    let caught = "";
    await withTransaction(app.db, async (tx) => {
      try {
        await post(tx, { kind: "WALLET_SPEND", idempotencyKey: k("over"), reference: { type: "order", id: "o1" }, entries: toEntries(adminWalletDebit({ userId: "u-poor", amount: 1_001 })), actor: system }, { clock });
      } catch (e) {
        caught = (e as { code: string }).code;
      }
      await post(tx, { kind: "WALLET_SPEND", idempotencyKey: k("ok"), reference: { type: "order", id: "o2" }, entries: toEntries(adminWalletDebit({ userId: "u-poor", amount: 1_000 })), actor: system }, { clock });
    });
    expect(caught).toBe("INSUFFICIENT_FUNDS");
    const after = await counts();
    expect(after).toEqual({ t: before.t + 1, e: before.e + 2, a: before.a + 1 }); // only the successful one persisted
    expect(await getBalance(app.db, walletAccount("u-poor"))).toBe(0);
  });

  it("an exception after a successful post() rolls back everything the transaction did", async () => {
    const before = await counts();
    await expect(
      withTransaction(app.db, async (tx) => {
        await ensureAccount(tx, walletAccount("u-crash"), system, { clock });
        await post(tx, { kind: "WALLET_TOPUP", idempotencyKey: k("crash"), reference: { type: "payment", id: "c" }, entries: toEntries(walletTopUp({ userId: "u-crash", gatewayKey: "gw1", amount: 999 })), actor: system }, { clock });
        throw new Error("application failure after posting");
      }),
    ).rejects.toThrow("application failure");
    expect(await counts()).toEqual(before);
    expect((await t.pool.query("select 1 from ledger_accounts where owner_id = 'u-crash'")).rowCount).toBe(0);
  });

  it("a database connection killed in the middle of the transaction leaves nothing behind", async () => {
    const before = await counts();
    const killer = await t.pool.connect();
    try {
      await expect(
        withTransaction(app.db, async (tx) => {
          await ensureAccount(tx, walletAccount("u-kill"), system, { clock });
          await post(tx, { kind: "WALLET_TOPUP", idempotencyKey: k("kill"), reference: { type: "payment", id: "k" }, entries: toEntries(walletTopUp({ userId: "u-kill", gatewayKey: "gw1", amount: 5_000 })), actor: system }, { clock });
          const pid = ((await tx.execute((await import("drizzle-orm")).sql`select pg_backend_pid() as pid`)).rows[0] as { pid: number }).pid;
          await killer.query("select pg_terminate_backend($1)", [pid]);
          await tx.execute((await import("drizzle-orm")).sql`select 1`); // fails: connection was terminated
        }),
      ).rejects.toBeTruthy();
    } finally {
      killer.release();
    }
    expect(await counts()).toEqual(before);
    expect((await t.pool.query("select 1 from ledger_accounts where owner_id = 'u-kill'")).rowCount).toBe(0);
  });
});

describe("reversals", () => {
  it("reverse() restores balances with an exact mirror, needs a reason, and is audited with the reason", async () => {
    const orig = await topUp("u-rev", 80_000);
    expect(await code(withTransaction(app.db, (tx) => reverse(tx, { originalTransactionId: orig.transactionId, idempotencyKey: k("rev"), reason: "", actor: admin })))).toBe("LEDGER_INVALID");
    const key = k("rev");
    const rev = await withTransaction(app.db, (tx) => reverse(tx, { originalTransactionId: orig.transactionId, idempotencyKey: key, reason: "duplicate gateway callback", actor: admin }, { clock }));
    expect(rev.replayed).toBe(false);
    expect(await getBalance(app.db, walletAccount("u-rev"))).toBe(0);
    const view = await getTransaction(app.db, rev.transactionId);
    expect(view).toMatchObject({ kind: "REVERSAL", reversesId: orig.transactionId });
    const audit = (await listAudit(app.db, { entityId: key }))[0];
    expect(audit).toMatchObject({ action: "ledger.reverse", actorType: "ADMIN" });
    expect((audit?.metadata as { reason: string }).reason).toBe("duplicate gateway callback");
    // idempotent replay
    const again = await withTransaction(app.db, (tx) => reverse(tx, { originalTransactionId: orig.transactionId, idempotencyKey: key, reason: "duplicate gateway callback", actor: admin }, { clock }));
    expect(again).toEqual({ transactionId: rev.transactionId, replayed: true });
  });
  it("a transaction can be reversed once; a reversal can not be reversed; unknown targets are refused", async () => {
    const orig = await topUp("u-rev2", 10_000);
    const rev = await withTransaction(app.db, (tx) => reverse(tx, { originalTransactionId: orig.transactionId, idempotencyKey: k("r1"), reason: "operator error", actor: admin }, { clock }));
    expect(await code(withTransaction(app.db, (tx) => reverse(tx, { originalTransactionId: orig.transactionId, idempotencyKey: k("r2"), reason: "again please", actor: admin })))).toBe("LEDGER_REVERSAL_INVALID");
    expect(await code(withTransaction(app.db, (tx) => reverse(tx, { originalTransactionId: rev.transactionId, idempotencyKey: k("r3"), reason: "undo the undo", actor: admin })))).toBe("LEDGER_REVERSAL_INVALID");
    expect(await code(withTransaction(app.db, (tx) => reverse(tx, { originalTransactionId: 987654321, idempotencyKey: k("r4"), reason: "does not exist", actor: admin })))).toBe("LEDGER_REVERSAL_INVALID");
  });
  it("reversing a top-up whose money was already spent fails with INSUFFICIENT_FUNDS and changes nothing; the correction is an explicit audited adjustment", async () => {
    const orig = await topUp("u-rev3", 5_000);
    await withTransaction(app.db, (tx) => post(tx, { kind: "WALLET_SPEND", idempotencyKey: k("spend"), reference: { type: "order", id: "o" }, entries: toEntries(adminWalletDebit({ userId: "u-rev3", amount: 4_000 })), actor: system }, { clock }));
    const before = await counts();
    expect(await code(withTransaction(app.db, (tx) => reverse(tx, { originalTransactionId: orig.transactionId, idempotencyKey: k("late"), reason: "customer asked for refund", actor: admin })))).toBe("INSUFFICIENT_FUNDS");
    expect(await counts()).toEqual(before);
    expect(await getBalance(app.db, walletAccount("u-rev3"))).toBe(1_000);
  });
});

describe("reports and integrity", () => {
  it("trial balance balances, equals the projection, and verifyIntegrity is clean after all of the above", async () => {
    const tb = await trialBalance(app.db);
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebits).toBe(tb.totalCredits);
    for (const r of tb.rows) expect(r.projectionBalance).toBe(r.balance);
    expect(await verifyIntegrity(app.db)).toEqual([]);
  });
  it("every ledger transaction is linked to an audit record of the matching action", async () => {
    const r = await t.pool.query(`select count(*)::int n from ledger_transactions t join audit_logs a on a.id = t.audit_log_id
                                   where a.entity_type = 'ledger_transaction' and a.entity_id = t.idempotency_key
                                     and a.action = case when t.kind = 'REVERSAL' then 'ledger.reverse' else 'ledger.post' end`);
    const total = await t.pool.query("select count(*)::int n from ledger_transactions");
    expect(r.rows[0].n).toBe(total.rows[0].n);
    expect(total.rows[0].n).toBeGreaterThan(5);
  });
  it("the application role really is the one running these tests (no superuser shortcut)", async () => {
    const who = await app.pool.query("select current_user, (select rolsuper from pg_roles where rolname = current_user) su");
    expect(who.rows[0].su).toBe(false);
    await asRole(t, (await t.pool.query("select app_role from platform_roles")).rows[0].app_role, async (c) => {
      await expect(c.query("update ledger_entries set amount = amount")).rejects.toBeTruthy();
    });
  });
});
