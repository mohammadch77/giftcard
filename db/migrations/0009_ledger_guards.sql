-- Double-entry ledger guards (step 2b-2). Reviewed re-authoring of docs/db-prototypes/001_ledger.sql
-- (prototype files are NOT applied). THE LEDGER IS THE ONLY SOURCE OF FINANCIAL TRUTH:
--   * entries / transactions / accounts are append-only (UPDATE, DELETE, TRUNCATE rejected, even for owners)
--   * every transaction is balanced and has >= 2 entries at COMMIT (deferred constraint triggers)
--   * entries can only be added by the DB transaction that created their ledger_transaction
--   * corrections are reversing transactions that must mirror the original EXACTLY
--   * ledger_account_balances is a PROJECTION: written only by trigger code (pg_trigger_depth guard)
--   * every transaction references an audit_logs row (NOT NULL FK, cross-module FK per P-1)
-- Custom SQLSTATEs: PL001 invalid/unbalanced transaction, PL002 invalid reversal, PL003 late/foreign
-- entry, PL004 direct write to the balance projection.

-- ---------- foreign keys (kept out of the Drizzle schema: cross-module FKs live in SQL, P-1) ----------
ALTER TABLE ledger_transactions
  ADD CONSTRAINT ledger_transactions_audit_fk FOREIGN KEY (audit_log_id) REFERENCES audit_logs(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ledger_transactions
  ADD CONSTRAINT ledger_transactions_reverses_fk FOREIGN KEY (reverses_id) REFERENCES ledger_transactions(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_transaction_fk FOREIGN KEY (transaction_id) REFERENCES ledger_transactions(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_account_fk FOREIGN KEY (account_id) REFERENCES ledger_accounts(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ledger_account_balances
  ADD CONSTRAINT ledger_account_balances_account_fk FOREIGN KEY (account_id) REFERENCES ledger_accounts(id) ON DELETE RESTRICT;
--> statement-breakpoint

-- ---------- append-only ----------
CREATE TRIGGER ledger_accounts_no_mutation BEFORE UPDATE OR DELETE ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_accounts_no_truncate BEFORE TRUNCATE ON ledger_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_no_mutation BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_no_truncate BEFORE TRUNCATE ON ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_mutation BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint

-- ---------- balance projection: written only from inside other triggers ----------
CREATE FUNCTION ledger_balances_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger_account_balances rows can not be deleted' USING ERRCODE = 'PL004';
  END IF;
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'ledger_account_balances is a projection maintained by the ledger triggers only' USING ERRCODE = 'PL004';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.account_id <> OLD.account_id OR NEW.min_balance IS DISTINCT FROM OLD.min_balance) THEN
    RAISE EXCEPTION 'account_id and min_balance are immutable' USING ERRCODE = 'PL004';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER ledger_balances_guard BEFORE INSERT OR UPDATE OR DELETE ON ledger_account_balances
  FOR EACH ROW EXECUTE FUNCTION ledger_balances_guard();
--> statement-breakpoint
CREATE TRIGGER ledger_balances_no_truncate BEFORE TRUNCATE ON ledger_account_balances
  FOR EACH STATEMENT EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint

-- Each new account gets its projection row. SECURITY DEFINER: the application role has no write
-- privilege on the projection; only this trigger code writes it.
CREATE FUNCTION ledger_accounts_after_insert() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  INSERT INTO public.ledger_account_balances (account_id, min_balance) VALUES (NEW.id, NEW.min_balance);
  RETURN NULL;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER ledger_accounts_after_insert AFTER INSERT ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION ledger_accounts_after_insert();
--> statement-breakpoint

-- ---------- transactions: reversal sanity ----------
CREATE FUNCTION ledger_transactions_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_orig_reverses bigint;
BEGIN
  IF NEW.reverses_id IS NOT NULL THEN
    SELECT t.reverses_id INTO v_orig_reverses FROM public.ledger_transactions t WHERE t.id = NEW.reverses_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reversal target does not exist' USING ERRCODE = 'PL002';
    END IF;
    IF v_orig_reverses IS NOT NULL THEN
      RAISE EXCEPTION 'a reversal can not itself be reversed' USING ERRCODE = 'PL002';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_before_insert BEFORE INSERT ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION ledger_transactions_before_insert();
--> statement-breakpoint

-- ---------- entries: same-transaction guard + projection update ----------
CREATE FUNCTION ledger_entries_before_insert() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_txid   bigint;
  v_normal text;
  v_delta  bigint;
BEGIN
  SELECT pg_txid INTO v_txid FROM public.ledger_transactions WHERE id = NEW.transaction_id;
  IF v_txid IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'ledger entries can only be added by the database transaction that created the ledger transaction'
      USING ERRCODE = 'PL003';
  END IF;

  SELECT normal_side INTO v_normal FROM public.ledger_accounts WHERE id = NEW.account_id;
  v_delta := CASE WHEN NEW.side = v_normal THEN NEW.amount ELSE -NEW.amount END;

  -- The row lock taken here serialises concurrent postings on the same account; the floor CHECK
  -- (ledger_account_balances_floor) then rejects an overdraft atomically.
  UPDATE public.ledger_account_balances
     SET balance = balance + v_delta, entry_count = entry_count + 1,
         last_entry_id = NEW.id, version = version + 1, updated_at = now()
   WHERE account_id = NEW.account_id;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_before_insert BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_before_insert();
--> statement-breakpoint

-- ---------- balanced + shape check, evaluated at COMMIT ----------
CREATE FUNCTION ledger_assert_transaction_valid(p_txn bigint) RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_count   bigint;
  v_debits  bigint;
  v_credits bigint;
  v_diff    numeric;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE side = 'DEBIT'),
         count(*) FILTER (WHERE side = 'CREDIT'),
         COALESCE(SUM(CASE side WHEN 'DEBIT' THEN amount ELSE -amount END), 0)
    INTO v_count, v_debits, v_credits, v_diff
    FROM public.ledger_entries WHERE transaction_id = p_txn;
  IF v_count < 2 OR v_debits = 0 OR v_credits = 0 THEN
    RAISE EXCEPTION 'ledger transaction % needs at least one debit and one credit entry', p_txn USING ERRCODE = 'PL001';
  END IF;
  IF v_diff <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced by %', p_txn, v_diff USING ERRCODE = 'PL001';
  END IF;
END
$fn$;
--> statement-breakpoint

CREATE FUNCTION ledger_check_entry_txn() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  PERFORM public.ledger_assert_transaction_valid(NEW.transaction_id);
  RETURN NULL;
END
$fn$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_entry_txn();
--> statement-breakpoint

-- A transaction row with no entries at all must not commit either.
CREATE FUNCTION ledger_check_txn_row() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  PERFORM public.ledger_assert_transaction_valid(NEW.id);
  IF NEW.reverses_id IS NOT NULL AND public.ledger_reversal_mismatch(NEW.id) THEN
    RAISE EXCEPTION 'reversal % does not exactly mirror transaction %', NEW.id, NEW.reverses_id USING ERRCODE = 'PL002';
  END IF;
  RETURN NULL;
END
$fn$;
--> statement-breakpoint

-- True when the reversal's entries are NOT the exact opposite (same accounts, amounts, flipped sides)
-- of the original transaction's entries.
CREATE FUNCTION ledger_reversal_mismatch(p_reversal bigint) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $fn$
  WITH r AS (SELECT reverses_id FROM public.ledger_transactions WHERE id = p_reversal),
  orig AS (
    SELECT e.account_id, CASE e.side WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END AS side, e.amount
      FROM public.ledger_entries e JOIN r ON e.transaction_id = r.reverses_id),
  rev AS (SELECT account_id, side, amount FROM public.ledger_entries WHERE transaction_id = p_reversal)
  SELECT EXISTS (SELECT account_id, side, amount FROM orig EXCEPT ALL SELECT account_id, side, amount FROM rev)
      OR EXISTS (SELECT account_id, side, amount FROM rev EXCEPT ALL SELECT account_id, side, amount FROM orig);
$fn$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_transactions_valid AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_txn_row();
--> statement-breakpoint

-- ---------- read-only reports (single statement => one consistent snapshot) ----------
-- Findings are computed FROM THE ENTRIES (truth) and compared with the projection. Empty = healthy.
CREATE FUNCTION ledger_integrity_findings()
RETURNS TABLE (kind text, account_id bigint, transaction_id bigint, detail text)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $fn$
  WITH calc AS (
    SELECT a.id, a.normal_side,
           COALESCE(SUM(CASE WHEN e.side = a.normal_side THEN e.amount ELSE -e.amount END), 0)::bigint AS bal,
           count(e.id) AS cnt
      FROM public.ledger_accounts a LEFT JOIN public.ledger_entries e ON e.account_id = a.id
     GROUP BY a.id, a.normal_side),
  tx AS (
    SELECT t.id,
           count(e.id) AS cnt,
           count(e.id) FILTER (WHERE e.side = 'DEBIT') AS debits,
           count(e.id) FILTER (WHERE e.side = 'CREDIT') AS credits,
           COALESCE(SUM(CASE e.side WHEN 'DEBIT' THEN e.amount ELSE -e.amount END), 0) AS diff
      FROM public.ledger_transactions t LEFT JOIN public.ledger_entries e ON e.transaction_id = t.id
     GROUP BY t.id)
  SELECT 'BALANCE_DRIFT'::text, b.account_id, NULL::bigint,
         format('projection=%s entries=%s projection_count=%s entries_count=%s', b.balance, c.bal, b.entry_count, c.cnt)
    FROM public.ledger_account_balances b JOIN calc c ON c.id = b.account_id
   WHERE b.balance <> c.bal OR b.entry_count <> c.cnt
  UNION ALL
  SELECT 'MISSING_BALANCE_ROW', a.id, NULL, 'account has no projection row'
    FROM public.ledger_accounts a WHERE NOT EXISTS (SELECT 1 FROM public.ledger_account_balances b WHERE b.account_id = a.id)
  UNION ALL
  SELECT 'BELOW_FLOOR', c.id, NULL, format('balance=%s floor=%s', c.bal, a.min_balance)
    FROM calc c JOIN public.ledger_accounts a ON a.id = c.id WHERE a.min_balance IS NOT NULL AND c.bal < a.min_balance
  UNION ALL
  SELECT 'UNBALANCED_TRANSACTION', NULL, tx.id, format('entries=%s debits=%s credits=%s diff=%s', tx.cnt, tx.debits, tx.credits, tx.diff)
    FROM tx WHERE tx.cnt < 2 OR tx.debits = 0 OR tx.credits = 0 OR tx.diff <> 0
  UNION ALL
  SELECT 'REVERSAL_MISMATCH', NULL, t.id, format('does not mirror transaction %s', t.reverses_id)
    FROM public.ledger_transactions t WHERE t.reverses_id IS NOT NULL AND public.ledger_reversal_mismatch(t.id)
  UNION ALL
  SELECT 'AUDIT_MISMATCH', NULL, t.id, 'audit record missing or not matching the transaction'
    FROM public.ledger_transactions t LEFT JOIN public.audit_logs l ON l.id = t.audit_log_id
   WHERE l.id IS NULL OR l.entity_type <> 'ledger_transaction' OR l.entity_id <> t.idempotency_key;
$fn$;
--> statement-breakpoint

-- Per-account trial balance computed from entries, next to the projection.
CREATE FUNCTION ledger_trial_balance()
RETURNS TABLE (account_id bigint, code text, owner_type text, owner_id text, type text, contra boolean,
               normal_side text, debit_total bigint, credit_total bigint, balance bigint,
               projection_balance bigint, entry_count bigint)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $fn$
  SELECT a.id, a.code, a.owner_type, a.owner_id, a.type, a.contra, a.normal_side,
         COALESCE(SUM(e.amount) FILTER (WHERE e.side = 'DEBIT'), 0)::bigint,
         COALESCE(SUM(e.amount) FILTER (WHERE e.side = 'CREDIT'), 0)::bigint,
         COALESCE(SUM(CASE WHEN e.side = a.normal_side THEN e.amount ELSE -e.amount END), 0)::bigint,
         b.balance, count(e.id)
    FROM public.ledger_accounts a
    LEFT JOIN public.ledger_entries e ON e.account_id = a.id
    LEFT JOIN public.ledger_account_balances b ON b.account_id = a.id
   GROUP BY a.id, b.balance
   ORDER BY a.id;
$fn$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION ledger_accounts_after_insert() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ledger_entries_before_insert() FROM PUBLIC;
--> statement-breakpoint

-- ---------- grants (P-4): evidence tables are append-only; the projection is read-only ----------
SELECT platform_register_grants('ledger_accounts', 'append_only');
--> statement-breakpoint
SELECT platform_register_grants('ledger_transactions', 'append_only');
--> statement-breakpoint
SELECT platform_register_grants('ledger_entries', 'append_only');
--> statement-breakpoint
SELECT platform_register_grants('ledger_account_balances', 'read_only');
