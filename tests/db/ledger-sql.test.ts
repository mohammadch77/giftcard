import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, createTestRoles, pgCode, pgMessage } from "../helpers/db";
import type { TestDatabase, TestRoles } from "../helpers/db";
import { counts, rawAccount, rawAudit, rawPost } from "../helpers/ledger";

/** Database-level guarantees, exercised with RAW SQL so that no service code can help or hurt. */
let t: TestDatabase;
let roles: TestRoles;
let A: number; // asset (debit-normal), no floor
let W: number; // liability wallet, floor 0
let X: number; // expense
let R: number; // revenue (credit-normal)
let n = 0;
const touch: Record<string, string> = { ledger_accounts: "code = code", ledger_transactions: "kind = kind", ledger_entries: "amount = amount", audit_logs: "action = action" };
const key = () => `raw-key-${++n}-${Math.random().toString(36).slice(2, 8)}`;
const bal = async (id: number) => Number((await t.pool.query("select balance from ledger_account_balances where account_id=$1", [id])).rows[0].balance);

beforeAll(async () => {
  t = await createTestDatabase();
  roles = await createTestRoles(t);
  A = await rawAccount(t.pool, { code: "ASSET_A", type: "ASSET", side: "DEBIT" });
  W = await rawAccount(t.pool, { code: "WALLET_W", type: "LIABILITY", side: "CREDIT", min: 0, owner: "u1" });
  X = await rawAccount(t.pool, { code: "EXPENSE_X", type: "EXPENSE", side: "DEBIT" });
  R = await rawAccount(t.pool, { code: "REVENUE_R", type: "REVENUE", side: "CREDIT" });
});
afterAll(async () => {
  await t?.drop();
});

describe("balanced / unbalanced transactions", () => {
  it("a balanced multi-entry transaction commits and updates the projection by each account's normal side", async () => {
    await rawPost(t.pool, { key: key(), entries: [{ account: A, side: "DEBIT", amount: 1_000_000 }, { account: W, side: "CREDIT", amount: 600_000 }, { account: R, side: "CREDIT", amount: 400_000 }] });
    expect(await bal(A)).toBe(1_000_000);
    expect(await bal(W)).toBe(600_000);
    expect(await bal(R)).toBe(400_000);
  });
  it("an unbalanced transaction cannot commit (PL001) and leaves NOTHING behind", async () => {
    const before = await counts(t.pool);
    const balBefore = await bal(A);
    await expect(rawPost(t.pool, { key: key(), entries: [{ account: A, side: "DEBIT", amount: 100 }, { account: W, side: "CREDIT", amount: 99 }] })).rejects.toSatisfy((e) => pgCode(e) === "PL001");
    expect(await counts(t.pool)).toEqual(before);
    expect(await bal(A)).toBe(balBefore);
  });
  it.each([
    ["a single entry", [{ side: "DEBIT" as const, amount: 5 }]],
    ["debits only", [{ side: "DEBIT" as const, amount: 5 }, { side: "DEBIT" as const, amount: 5 }]],
    ["credits only", [{ side: "CREDIT" as const, amount: 5 }, { side: "CREDIT" as const, amount: 5 }]],
  ])("rejects %s (PL001)", async (_n, es) => {
    await expect(rawPost(t.pool, { key: key(), entries: es.map((e) => ({ account: X, ...e })) })).rejects.toSatisfy((e) => pgCode(e) === "PL001");
  });
  it("a transaction row with no entries at all cannot commit", async () => {
    await expect(rawPost(t.pool, { key: key(), entries: [], noEntries: true })).rejects.toSatisfy((e) => pgCode(e) === "PL001");
  });
  it("zero and negative amounts are rejected by the domain/CHECK", async () => {
    for (const amount of [0, -1]) {
      await expect(rawPost(t.pool, { key: key(), entries: [{ account: A, side: "DEBIT", amount }, { account: W, side: "CREDIT", amount }] })).rejects.toSatisfy((e) => ["23514"].includes(pgCode(e) ?? ""));
    }
    await expect(rawPost(t.pool, { key: key(), entries: [{ account: A, side: "DEBIT", amount: 10 ** 13 + 1 }, { account: R, side: "CREDIT", amount: 10 ** 13 + 1 }] })).rejects.toSatisfy((e) => pgCode(e) === "23514");
  });
  it("entries cannot be added to an already-committed transaction (PL003)", async () => {
    const id = await rawPost(t.pool, { key: key(), entries: [{ account: A, side: "DEBIT", amount: 7 }, { account: R, side: "CREDIT", amount: 7 }] });
    await expect(t.pool.query("insert into ledger_entries (transaction_id, account_id, side, amount) values ($1,$2,'DEBIT',1)", [id, A])).rejects.toSatisfy((e) => pgCode(e) === "PL003");
  });
  it("a failing statement in the middle of a transaction rolls back the whole posting (audit row, transaction, entries, projection)", async () => {
    const before = await counts(t.pool);
    const balA = await bal(A);
    const c = await t.pool.connect();
    try {
      await c.query("begin");
      const audit = await rawAudit(c, "mid-failure-key-1");
      const tx = await c.query("insert into ledger_transactions (kind, idempotency_key, request_hash, reference_type, reference_id, actor_type, actor_id, audit_log_id, posted_at) values ('X_KIND','mid-failure-key-1',$1,'test_ref','1','SYSTEM','s',$2,now()) returning id", ["b".repeat(64), audit]);
      const id = Number(tx.rows[0].id);
      await c.query("insert into ledger_entries (transaction_id, account_id, side, amount) values ($1,$2,'DEBIT',50)", [id, A]);
      await expect(c.query("insert into ledger_entries (transaction_id, account_id, side, amount) values ($1,$2,'CREDIT',50)", [id, 999999])).rejects.toSatisfy((e) => pgCode(e) === "23503");
      await c.query("rollback");
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
    expect(await counts(t.pool)).toEqual(before);
    expect(await bal(A)).toBe(balA);
  });
});

describe("append-only: no UPDATE, DELETE or TRUNCATE (not even for the table owner / superuser)", () => {
  it.each(["ledger_accounts", "ledger_transactions", "ledger_entries", "audit_logs"])("%s rejects UPDATE, DELETE and TRUNCATE", async (table) => {
    await expect(t.pool.query(`update ${table} set ${touch[table]}`)).rejects.toSatisfy((e) => pgCode(e) === "23001");
    await expect(t.pool.query(`delete from ${table}`)).rejects.toSatisfy((e) => pgCode(e) === "23001");
    await expect(t.pool.query(`truncate ${table} cascade`)).rejects.toSatisfy((e) => pgCode(e) === "23001");
  });
  it("the balance projection can not be written directly by anyone (PL004), only by the ledger triggers", async () => {
    await expect(t.pool.query("update ledger_account_balances set balance = 5 where account_id = $1", [A])).rejects.toSatisfy((e) => pgCode(e) === "PL004");
    await expect(t.pool.query("insert into ledger_account_balances (account_id) values ($1)", [A])).rejects.toSatisfy((e) => ["PL004", "23505"].includes(pgCode(e) ?? ""));
    await expect(t.pool.query("delete from ledger_account_balances")).rejects.toSatisfy((e) => pgCode(e) === "PL004");
    await expect(t.pool.query("truncate ledger_account_balances")).rejects.toSatisfy((e) => pgCode(e) === "23001");
  });
});

describe("least privilege: the application role", () => {
  it("can INSERT and SELECT but never UPDATE, DELETE, TRUNCATE; cannot touch the projection", async () => {
    await asRole(t, roles.appRole, async (c) => {
      await c.query("select * from ledger_entries limit 1");
      await c.query("select * from ledger_account_balances limit 1");
      for (const table of ["ledger_accounts", "ledger_transactions", "ledger_entries", "audit_logs"]) {
        await expect(c.query(`update ${table} set ${touch[table]}`)).rejects.toSatisfy((e) => pgCode(e) === "42501");
        await expect(c.query(`delete from ${table}`)).rejects.toSatisfy((e) => pgCode(e) === "42501");
        await expect(c.query(`truncate ${table}`)).rejects.toSatisfy((e) => pgCode(e) === "42501");
      }
      await expect(c.query("update ledger_account_balances set balance = 1")).rejects.toSatisfy((e) => pgCode(e) === "42501");
      await expect(c.query("insert into ledger_account_balances (account_id) values (1)")).rejects.toSatisfy((e) => pgCode(e) === "42501");
    });
  });
  it("can still post: the projection is updated by SECURITY DEFINER trigger code", async () => {
    const before = await bal(A);
    await asRole(t, roles.appRole, async (c) => {
      await c.query("begin");
      const a = await c.query("insert into audit_logs (occurred_at, actor_type, actor_id, action, entity_type, entity_id) values (now(),'SYSTEM','s','ledger.post','ledger_transaction','app-role-key-1') returning id");
      const tx = await c.query("insert into ledger_transactions (kind, idempotency_key, request_hash, reference_type, reference_id, actor_type, actor_id, audit_log_id, posted_at) values ('APP_KIND','app-role-key-1',$1,'test_ref','1','SYSTEM','s',$2,now()) returning id", ["c".repeat(64), a.rows[0].id]);
      await c.query("insert into ledger_entries (transaction_id, account_id, side, amount) values ($1,$2,'DEBIT',11), ($1,$3,'CREDIT',11)", [tx.rows[0].id, A, R]);
      await c.query("commit");
    });
    expect(await bal(A)).toBe(before + 11);
  });
});

describe("the floor (wallet accounts never go negative)", () => {
  it("an overdraft is rejected atomically with the floor constraint; exactly zero is fine; nothing persists on failure", async () => {
    const wallet = await rawAccount(t.pool, { code: "WALLET_W", type: "LIABILITY", side: "CREDIT", min: 0, owner: "u-floor" });
    await rawPost(t.pool, { key: key(), entries: [{ account: A, side: "DEBIT", amount: 1000 }, { account: wallet, side: "CREDIT", amount: 1000 }] });
    const before = await counts(t.pool);
    const err = await rawPost(t.pool, { key: key(), entries: [{ account: wallet, side: "DEBIT", amount: 1001 }, { account: R, side: "CREDIT", amount: 1001 }] }).catch((e: unknown) => e);
    expect(pgCode(err)).toBe("23514");
    expect(pgMessage(err)).toContain("ledger_account_balances_floor");
    expect(await counts(t.pool)).toEqual(before);
    await rawPost(t.pool, { key: key(), entries: [{ account: wallet, side: "DEBIT", amount: 1000 }, { account: R, side: "CREDIT", amount: 1000 }] });
    expect(await bal(wallet)).toBe(0);
  });
});

describe("accounts", () => {
  it("normal side must match type and contra flag; currency, owner pairing and code format are constrained", async () => {
    await expect(rawAccount(t.pool, { code: "BAD_SIDE", type: "ASSET", side: "CREDIT" })).rejects.toSatisfy((e) => pgCode(e) === "23514");
    await expect(rawAccount(t.pool, { code: "BAD_SIDE", type: "LIABILITY", side: "DEBIT" })).rejects.toSatisfy((e) => pgCode(e) === "23514");
    await rawAccount(t.pool, { code: "CONTRA_REV", type: "REVENUE", side: "DEBIT", contra: true });
    await expect(rawAccount(t.pool, { code: "lower", type: "ASSET", side: "DEBIT" })).rejects.toSatisfy((e) => pgCode(e) === "23514");
    await expect(t.pool.query("insert into ledger_accounts (code, owner_type, type, normal_side, chart_version) values ('OWNER_HALF','user','ASSET','DEBIT','x')")).rejects.toSatisfy((e) => pgCode(e) === "23514");
    await expect(t.pool.query("insert into ledger_accounts (code, type, normal_side, currency, chart_version) values ('USD_ACC','ASSET','DEBIT','USD','x')")).rejects.toSatisfy((e) => pgCode(e) === "23514");
  });
  it("identity is unique even when the owner is NULL", async () => {
    await expect(rawAccount(t.pool, { code: "ASSET_A", type: "ASSET", side: "DEBIT" })).rejects.toSatisfy((e) => pgCode(e) === "23505");
    await expect(rawAccount(t.pool, { code: "WALLET_W", type: "LIABILITY", side: "CREDIT", min: 0, owner: "u1" })).rejects.toSatisfy((e) => pgCode(e) === "23505");
  });
  it("every account has exactly one projection row from creation (zero balance, no entries)", async () => {
    const id = await rawAccount(t.pool, { code: "FRESH_ACC", type: "ASSET", side: "DEBIT" });
    const r = (await t.pool.query("select balance, entry_count from ledger_account_balances where account_id=$1", [id])).rows[0];
    expect({ b: Number(r.balance), c: Number(r.entry_count) }).toEqual({ b: 0, c: 0 });
  });
});

describe("transaction header", () => {
  it("requires an audit record (NOT NULL + FK), a unique idempotency key and valid formats", async () => {
    const base = ["TEST_KIND", "hdr-key-0001", "d".repeat(64), "test_ref", "1", "SYSTEM", "s"];
    await expect(t.pool.query("insert into ledger_transactions (kind, idempotency_key, request_hash, reference_type, reference_id, actor_type, actor_id, posted_at) values ($1,$2,$3,$4,$5,$6,$7,now())", base)).rejects.toSatisfy((e) => pgCode(e) === "23502");
    await expect(t.pool.query("insert into ledger_transactions (kind, idempotency_key, request_hash, reference_type, reference_id, actor_type, actor_id, audit_log_id, posted_at) values ($1,$2,$3,$4,$5,$6,$7,99999999,now())", base)).rejects.toSatisfy((e) => pgCode(e) === "23503");
    const k = key();
    await rawPost(t.pool, { key: k, entries: [{ account: A, side: "DEBIT", amount: 3 }, { account: R, side: "CREDIT", amount: 3 }] });
    await expect(rawPost(t.pool, { key: k, entries: [{ account: A, side: "DEBIT", amount: 3 }, { account: R, side: "CREDIT", amount: 3 }] })).rejects.toSatisfy((e) => pgCode(e) === "23505");
    await expect(rawPost(t.pool, { key: "short", entries: [{ account: A, side: "DEBIT", amount: 3 }, { account: R, side: "CREDIT", amount: 3 }] })).rejects.toSatisfy((e) => pgCode(e) === "23514");
    await expect(rawPost(t.pool, { key: key(), kind: "lower_kind", entries: [{ account: A, side: "DEBIT", amount: 3 }, { account: R, side: "CREDIT", amount: 3 }] })).rejects.toSatisfy((e) => pgCode(e) === "23514");
    await expect(rawPost(t.pool, { key: key(), hash: "nothex", entries: [{ account: A, side: "DEBIT", amount: 3 }, { account: R, side: "CREDIT", amount: 3 }] })).rejects.toSatisfy((e) => pgCode(e) === "23514");
  });
  it("the REVERSAL kind and reverses_id must go together", async () => {
    await expect(rawPost(t.pool, { key: key(), kind: "REVERSAL", entries: [{ account: A, side: "DEBIT", amount: 3 }, { account: R, side: "CREDIT", amount: 3 }] })).rejects.toSatisfy((e) => pgCode(e) === "23514");
  });
});

describe("reversals (the only way to undo a posting)", () => {
  const post = (entries: { account: number; side: "DEBIT" | "CREDIT"; amount: number }[]) => rawPost(t.pool, { key: key(), entries });

  it("an exact mirror is accepted and restores the balances", async () => {
    const a0 = await bal(A), r0 = await bal(R);
    const orig = await post([{ account: A, side: "DEBIT", amount: 250 }, { account: R, side: "CREDIT", amount: 250 }]);
    await rawPost(t.pool, { key: key(), reverses: orig, entries: [{ account: A, side: "CREDIT", amount: 250 }, { account: R, side: "DEBIT", amount: 250 }] });
    expect([await bal(A), await bal(R)]).toEqual([a0, r0]);
  });
  it("a mirror with the wrong amount, wrong account or wrong sides is rejected (PL002)", async () => {
    const orig = await post([{ account: A, side: "DEBIT", amount: 300 }, { account: R, side: "CREDIT", amount: 300 }]);
    for (const entries of [
      [{ account: A, side: "CREDIT" as const, amount: 299 }, { account: R, side: "DEBIT" as const, amount: 299 }], // partial
      [{ account: A, side: "CREDIT" as const, amount: 300 }, { account: X, side: "DEBIT" as const, amount: 300 }], // other account
      [{ account: A, side: "DEBIT" as const, amount: 300 }, { account: R, side: "CREDIT" as const, amount: 300 }], // same direction
    ]) {
      await expect(rawPost(t.pool, { key: key(), reverses: orig, entries })).rejects.toSatisfy((e) => pgCode(e) === "PL002");
    }
  });
  it("a transaction can be reversed only once", async () => {
    const orig = await post([{ account: A, side: "DEBIT", amount: 40 }, { account: R, side: "CREDIT", amount: 40 }]);
    const mirror = [{ account: A, side: "CREDIT" as const, amount: 40 }, { account: R, side: "DEBIT" as const, amount: 40 }];
    await rawPost(t.pool, { key: key(), reverses: orig, entries: mirror });
    await expect(rawPost(t.pool, { key: key(), reverses: orig, entries: mirror })).rejects.toSatisfy((e) => pgCode(e) === "23505");
  });
  it("a reversal can not be reversed, and a non-existent target is rejected", async () => {
    const orig = await post([{ account: A, side: "DEBIT", amount: 41 }, { account: R, side: "CREDIT", amount: 41 }]);
    const rev = await rawPost(t.pool, { key: key(), reverses: orig, entries: [{ account: A, side: "CREDIT", amount: 41 }, { account: R, side: "DEBIT", amount: 41 }] });
    await expect(rawPost(t.pool, { key: key(), reverses: rev, entries: [{ account: A, side: "DEBIT", amount: 41 }, { account: R, side: "CREDIT", amount: 41 }] })).rejects.toSatisfy((e) => pgCode(e) === "PL002");
    await expect(rawPost(t.pool, { key: key(), reverses: 987654321, entries: [{ account: A, side: "CREDIT", amount: 1 }, { account: R, side: "DEBIT", amount: 1 }] })).rejects.toSatisfy((e) => pgCode(e) === "PL002");
  });
});

describe("integrity report and trial balance", () => {
  it("a healthy ledger has no findings; the trial balance balances and equals the projection", async () => {
    expect((await t.pool.query("select * from ledger_integrity_findings()")).rows).toEqual([]);
    const tb = (await t.pool.query("select * from ledger_trial_balance()")).rows as { debit_total: string; credit_total: string; balance: string; projection_balance: string }[];
    expect(tb.reduce((s, r) => s + Number(r.debit_total), 0)).toBe(tb.reduce((s, r) => s + Number(r.credit_total), 0));
    for (const r of tb) expect(r.balance).toBe(r.projection_balance);
  });
});

describe("the integrity check DETECTS tampering done with the guards disabled (superuser, replica mode)", () => {
  it("finds drift, unbalanced and entry-less transactions, floor breaches, mirror mismatches and audit mismatches", async () => {
    const d = await createTestDatabase();
    try {
      const a = await rawAccount(d.pool, { code: "ASSET_A", type: "ASSET", side: "DEBIT" });
      const r = await rawAccount(d.pool, { code: "REVENUE_R", type: "REVENUE", side: "CREDIT" });
      const w = await rawAccount(d.pool, { code: "WALLET_W", type: "LIABILITY", side: "CREDIT", min: 0, owner: "u" });
      const t1 = await rawPost(d.pool, { key: "tamper-key-01", entries: [{ account: a, side: "DEBIT", amount: 100 }, { account: r, side: "CREDIT", amount: 100 }] });
      const rev = await rawPost(d.pool, { key: "tamper-key-02", reverses: t1, entries: [{ account: a, side: "CREDIT", amount: 100 }, { account: r, side: "DEBIT", amount: 100 }] });
      expect((await d.pool.query("select * from ledger_integrity_findings()")).rows).toEqual([]);

      const c = await d.pool.connect();
      try {
        await c.query("set session_replication_role = replica"); // disables triggers: simulates a DBA / compromised superuser
        await c.query("update ledger_account_balances set balance = balance + 7 where account_id = $1", [a]); // drift
        await c.query("insert into ledger_entries (transaction_id, account_id, side, amount) values ($1,$2,'DEBIT',5)", [t1, a]); // unbalances t1 (and drifts a)
        await c.query("update ledger_entries set amount = 99 where transaction_id = $1 and account_id = $2", [rev, a]); // rev no longer mirrors
        await c.query("insert into ledger_entries (transaction_id, account_id, side, amount) values ($1,$2,'DEBIT',50)", [t1, w]); // wallet debited with no funds: below floor in the ENTRIES
        await c.query("update audit_logs set entity_id = 'forged' where id = (select audit_log_id from ledger_transactions where id = $1)", [t1]);
      } finally {
        await c.query("reset session_replication_role").catch(() => undefined);
        c.release();
      }
      const kinds = new Set((await d.pool.query("select kind from ledger_integrity_findings()")).rows.map((x: { kind: string }) => x.kind));
      for (const k of ["BALANCE_DRIFT", "UNBALANCED_TRANSACTION", "REVERSAL_MISMATCH", "AUDIT_MISMATCH", "BELOW_FLOOR"]) expect(kinds.has(k), k).toBe(true);
    } finally {
      await d.drop();
    }
  });
});
