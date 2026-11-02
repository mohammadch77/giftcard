import type { Pool, PoolClient } from "pg";

/** Raw-SQL helpers for the database-level ledger tests (superuser pool; these bypass every service). */
export interface RawAccount { id: number }

export async function rawAccount(pool: Pool, a: { code: string; type: string; side: string; contra?: boolean; min?: number | null; owner?: string | null }): Promise<number> {
  const r = await pool.query(
    `insert into ledger_accounts (code, owner_type, owner_id, type, contra, normal_side, min_balance, chart_version)
     values ($1, $2, $3, $4, $5, $6, $7, 'test-chart') returning id`,
    [a.code, a.owner ? "user" : null, a.owner ?? null, a.type, a.contra ?? false, a.side, a.min ?? null],
  );
  return Number(r.rows[0].id);
}

export async function rawAudit(pool: Pool | PoolClient, entityId: string): Promise<number> {
  const r = await pool.query(
    `insert into audit_logs (occurred_at, actor_type, actor_id, action, entity_type, entity_id) values (now(), 'SYSTEM', 'system:test', 'ledger.post', 'ledger_transaction', $1) returning id`,
    [entityId],
  );
  return Number(r.rows[0].id);
}

export interface RawPosting {
  key: string;
  entries: { account: number; side: "DEBIT" | "CREDIT"; amount: number }[];
  kind?: string;
  reverses?: number;
  /** skip creating entries (to test entry-less transactions) */
  noEntries?: boolean;
  hash?: string;
}

/** One database transaction: audit row + ledger transaction + entries; COMMIT at the end (deferred checks run there). */
export async function rawPost(pool: Pool, p: RawPosting): Promise<number> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const audit = await rawAudit(c, p.key);
    const t = await c.query(
      `insert into ledger_transactions (kind, idempotency_key, request_hash, reference_type, reference_id, reverses_id, actor_type, actor_id, audit_log_id, posted_at)
       values ($1, $2, $3, 'test_ref', 'r-1', $4, 'SYSTEM', 'system:test', $5, now()) returning id`,
      [p.kind ?? (p.reverses ? "REVERSAL" : "TEST_POSTING"), p.key, p.hash ?? "a".repeat(64), p.reverses ?? null, audit],
    );
    const id = Number(t.rows[0].id);
    if (!p.noEntries) for (const e of p.entries) await c.query("insert into ledger_entries (transaction_id, account_id, side, amount) values ($1,$2,$3,$4)", [id, e.account, e.side, e.amount]);
    await c.query("commit");
    return id;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export const counts = async (pool: Pool) =>
  (await pool.query("select (select count(*) from ledger_transactions)::int t, (select count(*) from ledger_entries)::int e, (select count(*) from audit_logs)::int a")).rows[0] as { t: number; e: number; a: number };
