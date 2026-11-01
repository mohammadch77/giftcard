-- Database roles and grants (P-4, APPROVED).
-- Roles are created by the ops script db/ops/roles.sql (NOT by migrations); their names live in the
-- singleton table platform_roles. Every application table is registered here with a grant mode;
-- platform_apply_grants() (re)applies all grants and is safe to run any number of times, e.g.
-- after the roles are created in production.
--   append_only        app: SELECT, INSERT  (+ UPDATE on explicitly listed columns)
--   read_only          app: SELECT
--   read_write         app: SELECT, INSERT, UPDATE
--   read_write_delete  app: SELECT, INSERT, UPDATE, DELETE   (operational tables only; P-7)
-- TRUNCATE is never granted. The readonly role gets SELECT everywhere. Migrations/DDL run as the
-- owner/migrator role, never as the application role.

INSERT INTO platform_roles DEFAULT VALUES ON CONFLICT DO NOTHING;
--> statement-breakpoint

CREATE FUNCTION platform_apply_table_grants(p_table regclass, p_mode text, p_cols text[])
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_app  text;
  v_ro   text;
BEGIN
  SELECT app_role, readonly_role INTO v_app, v_ro FROM public.platform_roles WHERE singleton;
  EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', p_table);

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_app) THEN
    EXECUTE format('REVOKE ALL ON %s FROM %I', p_table, v_app);
    IF p_mode = 'read_only' THEN
      EXECUTE format('GRANT SELECT ON %s TO %I', p_table, v_app);
    ELSIF p_mode = 'append_only' THEN
      EXECUTE format('GRANT SELECT, INSERT ON %s TO %I', p_table, v_app);
      IF p_cols IS NOT NULL AND array_length(p_cols, 1) > 0 THEN
        EXECUTE format('GRANT UPDATE (%s) ON %s TO %I',
          (SELECT string_agg(quote_ident(c), ', ') FROM unnest(p_cols) c), p_table, v_app);
      END IF;
    ELSIF p_mode = 'read_write' THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %s TO %I', p_table, v_app);
    ELSIF p_mode = 'read_write_delete' THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO %I', p_table, v_app);
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_ro) THEN
    EXECUTE format('REVOKE ALL ON %s FROM %I', p_table, v_ro);
    EXECUTE format('GRANT SELECT ON %s TO %I', p_table, v_ro);
  END IF;
END
$fn$;
--> statement-breakpoint

CREATE FUNCTION platform_register_grants(p_table regclass, p_mode text, p_update_columns text[] DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF p_mode <> 'append_only' AND p_update_columns IS NOT NULL THEN
    RAISE EXCEPTION 'update columns are only allowed for append_only tables';
  END IF;
  INSERT INTO public.platform_grant_registry (table_name, mode, update_columns)
  VALUES (p_table::text, p_mode, p_update_columns)
  ON CONFLICT (table_name) DO UPDATE SET mode = EXCLUDED.mode, update_columns = EXCLUDED.update_columns;
  PERFORM public.platform_apply_table_grants(p_table, p_mode, p_update_columns);
END
$fn$;
--> statement-breakpoint

CREATE FUNCTION platform_apply_grants() RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  r      record;
  v_app  text;
  v_ro   text;
  v_role text;
  v_n    integer := 0;
BEGIN
  SELECT app_role, readonly_role INTO v_app, v_ro FROM public.platform_roles WHERE singleton;
  FOR v_role IN SELECT unnest(ARRAY[v_app, v_ro]) LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', v_role);
    END IF;
  END LOOP;
  FOR r IN SELECT table_name, mode, update_columns FROM public.platform_grant_registry ORDER BY table_name LOOP
    PERFORM public.platform_apply_table_grants(r.table_name::regclass, r.mode, r.update_columns);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END
$fn$;
--> statement-breakpoint

-- Administrative functions: owner/migrator only.
REVOKE ALL ON FUNCTION platform_apply_table_grants(regclass, text, text[]) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_register_grants(regclass, text, text[]) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_apply_grants() FROM PUBLIC;
--> statement-breakpoint

-- Register the platform tables.
SELECT platform_register_grants('db_meta', 'read_write');
--> statement-breakpoint
SELECT platform_register_grants('state_transition_rules', 'read_only');
--> statement-breakpoint
SELECT platform_register_grants('platform_roles', 'read_only');
--> statement-breakpoint
SELECT platform_register_grants('platform_grant_registry', 'read_only');
--> statement-breakpoint
SELECT platform_register_grants('idempotency_keys', 'append_only', ARRAY['response', 'completed_at']);
--> statement-breakpoint
SELECT platform_register_grants('outbox_events', 'append_only',
  ARRAY['status', 'attempts', 'available_at', 'locked_by', 'locked_until', 'processed_at', 'last_error']);
