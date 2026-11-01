-- Idempotency + outbox logic (tables are created by 0002).

-- ---------- idempotency_keys ----------
-- A row may be completed exactly once (response NULL -> value). Nothing else may change; no delete.
CREATE FUNCTION idempotency_keys_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF OLD.response IS NULL AND NEW.response IS NOT NULL
     AND NEW.id = OLD.id AND NEW.scope = OLD.scope AND NEW.key = OLD.key
     AND NEW.request_hash = OLD.request_hash AND NEW.created_at = OLD.created_at THEN
    NEW.completed_at := COALESCE(NEW.completed_at, now());
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'idempotency_keys rows are write-once (only completion is allowed)'
    USING ERRCODE = 'restrict_violation';
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER idempotency_keys_guard BEFORE UPDATE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION idempotency_keys_guard();
--> statement-breakpoint
CREATE TRIGGER idempotency_keys_no_delete BEFORE DELETE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER idempotency_keys_no_truncate BEFORE TRUNCATE ON idempotency_keys
  FOR EACH STATEMENT EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint

-- Every committed row must be complete: a transaction that inserted the key but did not set the
-- response cannot commit.
CREATE FUNCTION idempotency_keys_complete_at_commit() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM public.idempotency_keys k WHERE k.id = NEW.id AND k.response IS NULL) THEN
    RAISE EXCEPTION 'idempotency key % left incomplete at commit', NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END
$fn$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER idempotency_keys_complete AFTER INSERT ON idempotency_keys
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION idempotency_keys_complete_at_commit();
--> statement-breakpoint

-- ---------- outbox_events ----------
INSERT INTO state_transition_rules (machine, from_status, to_status) VALUES
  ('outbox_event', NULL,         'PENDING'),
  ('outbox_event', 'PENDING',    'PROCESSING'),
  ('outbox_event', 'PROCESSING', 'DONE'),
  ('outbox_event', 'PROCESSING', 'PENDING'),
  ('outbox_event', 'PROCESSING', 'DEAD');
--> statement-breakpoint
SELECT platform_attach_transition_guard('outbox_events', 'outbox_event');
--> statement-breakpoint

CREATE FUNCTION outbox_events_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NEW.id <> OLD.id OR NEW.event_type <> OLD.event_type OR NEW.aggregate_type <> OLD.aggregate_type
     OR NEW.aggregate_id <> OLD.aggregate_id OR NEW.payload <> OLD.payload
     OR NEW.max_attempts <> OLD.max_attempts OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'outbox event content is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER outbox_events_guard BEFORE UPDATE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION outbox_events_guard();
--> statement-breakpoint
CREATE TRIGGER outbox_events_no_delete BEFORE DELETE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER outbox_events_no_truncate BEFORE TRUNCATE ON outbox_events
  FOR EACH STATEMENT EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint

-- Claim a batch under a lease. Time is injected (p_now) for deterministic tests (P-6).
-- Events whose lease expired and that still have attempts left are re-claimed (crashed worker);
-- expired events that exhausted attempts become DEAD (never deleted).
CREATE FUNCTION outbox_claim(p_worker text, p_batch integer, p_lease interval, p_now timestamptz)
RETURNS SETOF outbox_events
LANGUAGE sql
SET search_path = pg_catalog, public
AS $fn$
  UPDATE outbox_events
     SET status = 'DEAD', locked_by = NULL, locked_until = NULL,
         last_error = COALESCE(last_error, 'LEASE_EXPIRED_MAX_ATTEMPTS')
   WHERE status = 'PROCESSING' AND locked_until < p_now AND attempts >= max_attempts;

  UPDATE outbox_events e
     SET status = 'PROCESSING', attempts = e.attempts + 1,
         locked_by = p_worker, locked_until = p_now + p_lease
   WHERE e.id IN (
           SELECT id FROM outbox_events
            WHERE (status = 'PENDING' AND available_at <= p_now)
               OR (status = 'PROCESSING' AND locked_until < p_now AND attempts < max_attempts)
            ORDER BY id
            LIMIT GREATEST(1, LEAST(p_batch, 1000))
            FOR UPDATE SKIP LOCKED)
  RETURNING e.*;
$fn$;
--> statement-breakpoint

-- Acknowledge success. Returns false when the lease was lost (another worker re-claimed it).
CREATE FUNCTION outbox_ack(p_id bigint, p_worker text, p_attempt integer, p_now timestamptz)
RETURNS boolean
LANGUAGE sql
SET search_path = pg_catalog, public
AS $fn$
  WITH u AS (
    UPDATE outbox_events
       SET status = 'DONE', processed_at = p_now, locked_by = NULL, locked_until = NULL
     WHERE id = p_id AND status = 'PROCESSING' AND locked_by = p_worker AND attempts = p_attempt
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u);
$fn$;
--> statement-breakpoint

-- Record a failure: retry after p_retry_after, or DEAD when attempts are exhausted.
-- p_error must be a short, non-sensitive classification (never a payload or secret).
-- Returns 'RETRY' | 'DEAD' | 'LOST'.
CREATE FUNCTION outbox_fail(p_id bigint, p_worker text, p_attempt integer, p_error text,
                            p_now timestamptz, p_retry_after interval)
RETURNS text
LANGUAGE sql
SET search_path = pg_catalog, public
AS $fn$
  WITH u AS (
    UPDATE outbox_events
       SET status = CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'PENDING' END,
           available_at = CASE WHEN attempts >= max_attempts THEN available_at ELSE p_now + p_retry_after END,
           locked_by = NULL, locked_until = NULL, last_error = left(p_error, 200)
     WHERE id = p_id AND status = 'PROCESSING' AND locked_by = p_worker AND attempts = p_attempt
    RETURNING CASE WHEN status = 'DEAD' THEN 'DEAD' ELSE 'RETRY' END AS result)
  SELECT COALESCE((SELECT result FROM u), 'LOST');
$fn$;
