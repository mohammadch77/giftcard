-- Custom SQL migration (hand-written, reviewed). Platform primitives only — no business tables.
-- Reviewed against docs/DATABASE_DESIGN.md §1 (append-only principle) and §3/§5 (citext usage).
-- NOTE: this is a re-authored minimal subset; prototype files in docs/db-prototypes are NOT applied.

CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint

-- Generic guard: attach to any append-only table (ledger_entries, inventory_movements,
-- audit_logs, ...) as BEFORE UPDATE OR DELETE (row) and BEFORE TRUNCATE (statement) triggers.
CREATE FUNCTION platform_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only (% is not allowed)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$fn$;
