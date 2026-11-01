-- State-transition engine (P-3, APPROVED). Reviewed against docs/STATE_MACHINES.md and
-- docs/DATABASE_DESIGN.md §8. No business machine is registered here; owner modules seed their
-- own rules and call platform_attach_transition_guard() in their migrations.
--
-- Contract for an owner table T (status column `status`, id column `id`):
--   * rules:   INSERT INTO state_transition_rules (machine, from_status, to_status) ...
--              (from_status NULL = allowed initial state on INSERT)
--   * history: a table with columns entity_id, from_status, to_status, actor_id text, reason text,
--              occurred_at timestamptz (entity_id typed like T's id). It is made append-only here.
--   * attach:  SELECT platform_attach_transition_guard('T', 'machine', 'T_history');
--   * app code sets the actor/reason per transaction with
--              set_config('app.actor_id', ..., true) / set_config('app.reason', ..., true)
--     (TypeScript helper: setTransitionContext()).
-- Errors: SQLSTATE PT001 = invalid transition, PT002 = actor required but missing.
-- Known limits (documented, not preventable inside PostgreSQL): a superuser/table owner can
-- DISABLE TRIGGER or set session_replication_role = replica.

CREATE FUNCTION platform_enforce_transition() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_machine text := TG_ARGV[0];
  v_col     text := COALESCE(NULLIF(TG_ARGV[1], ''), 'status');
  v_new     text := to_jsonb(NEW) ->> v_col;
  v_old     text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD) ->> v_col;
    IF v_old IS NOT DISTINCT FROM v_new THEN
      RETURN NEW; -- not a transition
    END IF;
  END IF;

  IF v_new IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.state_transition_rules r
     WHERE r.machine = v_machine
       AND r.from_status IS NOT DISTINCT FROM v_old
       AND r.to_status = v_new
  ) THEN
    RAISE EXCEPTION 'invalid state transition for machine %: % -> %',
      v_machine, COALESCE(v_old, '(initial)'), COALESCE(v_new, '(null)')
      USING ERRCODE = 'PT001';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint

CREATE FUNCTION platform_record_transition() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_hist   regclass := TG_ARGV[0]::regclass;
  v_id_col text := COALESCE(NULLIF(TG_ARGV[1], ''), 'id');
  v_col    text := COALESCE(NULLIF(TG_ARGV[2], ''), 'status');
  v_old    text;
  v_new    text := to_jsonb(NEW) ->> v_col;
  v_actor  text := NULLIF(current_setting('app.actor_id', true), '');
  v_reason text := NULLIF(current_setting('app.reason', true), '');
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD) ->> v_col;
    IF v_old IS NOT DISTINCT FROM v_new THEN
      RETURN NULL;
    END IF;
  END IF;

  IF TG_ARGV[3] = 'require_actor' AND v_actor IS NULL THEN
    RAISE EXCEPTION 'state transition on % requires app.actor_id to be set', TG_TABLE_NAME
      USING ERRCODE = 'PT002';
  END IF;

  EXECUTE format(
    'INSERT INTO %s (entity_id, from_status, to_status, actor_id, reason, occurred_at) '
    'SELECT r.entity_id, r.from_status, r.to_status, r.actor_id, r.reason, r.occurred_at '
    'FROM jsonb_populate_record(NULL::%s, $1) r', v_hist, v_hist)
  USING jsonb_build_object(
    'entity_id', to_jsonb(NEW) -> v_id_col,
    'from_status', v_old,
    'to_status', v_new,
    'actor_id', v_actor,
    'reason', v_reason,
    'occurred_at', now());
  RETURN NULL;
END
$fn$;
--> statement-breakpoint

CREATE FUNCTION platform_attach_transition_guard(
  p_table regclass,
  p_machine text,
  p_history regclass DEFAULT NULL,
  p_id_col text DEFAULT 'id',
  p_status_col text DEFAULT 'status',
  p_require_actor boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_missing text;
BEGIN
  IF p_machine !~ '^[a-z][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'invalid machine name %', p_machine;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_table AND attname = p_status_col AND NOT attisdropped) THEN
    RAISE EXCEPTION 'table % has no column %', p_table, p_status_col;
  END IF;

  EXECUTE format(
    'CREATE TRIGGER platform_transition_guard BEFORE INSERT OR UPDATE OF %I ON %s '
    'FOR EACH ROW EXECUTE FUNCTION platform_enforce_transition(%L, %L)',
    p_status_col, p_table, p_machine, p_status_col);

  IF p_history IS NOT NULL THEN
    SELECT string_agg(c, ', ') INTO v_missing
      FROM unnest(ARRAY['entity_id','from_status','to_status','actor_id','reason','occurred_at']) c
     WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = p_history AND a.attname = c AND NOT a.attisdropped);
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'history table % lacks columns: %', p_history, v_missing;
    END IF;

    EXECUTE format(
      'CREATE TRIGGER platform_transition_history AFTER INSERT OR UPDATE OF %I ON %s '
      'FOR EACH ROW EXECUTE FUNCTION platform_record_transition(%L, %L, %L, %L)',
      p_status_col, p_table, p_history::text, p_id_col, p_status_col,
      CASE WHEN p_require_actor THEN 'require_actor' ELSE '' END);

    -- History is evidence: append-only (UPDATE/DELETE/TRUNCATE rejected).
    EXECUTE format(
      'CREATE TRIGGER platform_history_no_mutation BEFORE UPDATE OR DELETE ON %s '
      'FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation()', p_history);
    EXECUTE format(
      'CREATE TRIGGER platform_history_no_truncate BEFORE TRUNCATE ON %s '
      'FOR EACH STATEMENT EXECUTE FUNCTION platform_reject_mutation()', p_history);
  END IF;
END
$fn$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION platform_attach_transition_guard(regclass, text, regclass, text, text, boolean) FROM PUBLIC;
