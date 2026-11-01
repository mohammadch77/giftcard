-- PROTOTYPE (design validation only, not a migration). Target: PostgreSQL 16+.
-- Demonstrates: double-entry ledger, append-only enforcement, DB-enforced balance floor.

CREATE TYPE account_type AS ENUM ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE');
CREATE TYPE entry_side   AS ENUM ('DEBIT','CREDIT');

CREATE TABLE ledger_accounts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code          text NOT NULL,                 -- e.g. CUSTOMER_WALLET, GATEWAY_CLEARING
  owner_type    text,                          -- 'USER' | 'GATEWAY' | 'SUPPLIER' | NULL (system)
  owner_id      text,
  type          account_type NOT NULL,
  normal_side   entry_side NOT NULL,           -- side that increases the balance
  currency      char(3) NOT NULL DEFAULT 'IRR' CHECK (currency = 'IRR'),  -- amounts are integer RIAL
  min_balance   bigint,                        -- NULL = may go negative; 0 = never below zero
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, owner_type, owner_id, currency)
);

CREATE TABLE ledger_transactions (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind             text NOT NULL,              -- WALLET_TOPUP, ORDER_PAYMENT, REFUND, ADJUSTMENT ...
  idempotency_key  text NOT NULL UNIQUE,       -- a posting can happen exactly once
  reference_type   text NOT NULL,
  reference_id     text NOT NULL,
  reverses_id      bigint REFERENCES ledger_transactions(id),
  description      text,
  created_by       text,                       -- user id / 'system'
  pg_txid          bigint NOT NULL DEFAULT txid_current(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id bigint NOT NULL REFERENCES ledger_transactions(id),
  account_id     bigint NOT NULL REFERENCES ledger_accounts(id),
  side           entry_side NOT NULL,
  amount         bigint NOT NULL CHECK (amount > 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ledger_entries (account_id, id);
CREATE INDEX ON ledger_entries (transaction_id);

-- Projection of balances; maintained ONLY by trigger. Not the source of truth.
CREATE TABLE ledger_account_balances (
  account_id  bigint PRIMARY KEY REFERENCES ledger_accounts(id),
  balance     bigint NOT NULL DEFAULT 0,
  min_balance bigint,
  entry_count bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT balance_floor CHECK (min_balance IS NULL OR balance >= min_balance)
);

CREATE FUNCTION trg_account_balance_row() RETURNS trigger AS $$
BEGIN
  INSERT INTO ledger_account_balances (account_id, min_balance)
  VALUES (NEW.id, NEW.min_balance);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER account_balance_row AFTER INSERT ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION trg_account_balance_row();

-- Entries may only be inserted in the same DB transaction that created the ledger_transaction.
CREATE FUNCTION trg_entry_same_txn() RETURNS trigger AS $$
DECLARE t_txid bigint; a ledger_accounts%ROWTYPE;
BEGIN
  SELECT pg_txid INTO t_txid FROM ledger_transactions WHERE id = NEW.transaction_id;
  IF t_txid IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'ledger entries can only be added in the creating transaction';
  END IF;
  SELECT * INTO a FROM ledger_accounts WHERE id = NEW.account_id;
  -- Update projection; row lock serialises concurrent postings on the same account.
  UPDATE ledger_account_balances
     SET balance = balance + CASE WHEN NEW.side = a.normal_side THEN NEW.amount ELSE -NEW.amount END,
         entry_count = entry_count + 1, updated_at = now()
   WHERE account_id = NEW.account_id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER entry_same_txn BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION trg_entry_same_txn();

-- Every transaction must balance, checked at COMMIT.
CREATE FUNCTION trg_txn_balanced() RETURNS trigger AS $$
DECLARE diff bigint;
BEGIN
  SELECT COALESCE(SUM(CASE side WHEN 'DEBIT' THEN amount ELSE -amount END),0) INTO diff
    FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF diff <> 0 THEN RAISE EXCEPTION 'ledger transaction % unbalanced by %', NEW.transaction_id, diff; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER txn_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_txn_balanced();

-- Append-only.
CREATE FUNCTION trg_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP; END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_ro BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION trg_append_only();
CREATE TRIGGER ledger_txn_ro BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION trg_append_only();
CREATE TRIGGER ledger_entries_trunc BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION trg_append_only();

-- Typed helper for the common two-leg posting. Explicit parameter types remove any
-- untyped-literal ambiguity (enum columns are never fed from bare string literals in UNIONs).
CREATE FUNCTION ledger_post2(p_kind text, p_key text, p_ref_type text, p_ref_id text,
                             p_debit_account bigint, p_credit_account bigint, p_amount bigint)
RETURNS bigint AS $$
DECLARE tid bigint;
BEGIN
  INSERT INTO ledger_transactions (kind, idempotency_key, reference_type, reference_id)
  VALUES (p_kind, p_key, p_ref_type, p_ref_id) RETURNING id INTO tid;
  INSERT INTO ledger_entries (transaction_id, account_id, side, amount) VALUES
    (tid, p_debit_account,  'DEBIT'::entry_side,  p_amount),
    (tid, p_credit_account, 'CREDIT'::entry_side, p_amount);
  RETURN tid;
END $$ LANGUAGE plpgsql;
