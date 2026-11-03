-- P1-A guards (ADM-1 settings foundation, B3 TTL, B5 wallet limits, order-time policy snapshots). Forward-only; touches only objects
-- created in 0024 plus the immutability triggers of orders / wallet_topups (recreated with the new columns).
-- SQLSTATE PO003: settings guard violated.

-- ---------------------------------------------------------------- order settings (B3): append-only
CREATE TRIGGER order_settings_versions_no_mutation BEFORE UPDATE OR DELETE ON order_settings_versions
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER order_settings_versions_no_truncate BEFORE TRUNCATE ON order_settings_versions
  FOR EACH STATEMENT EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint

-- The version chain is contiguous: every version after the first points at an EXISTING previous version (the CHECK pins it to version - 1).
ALTER TABLE order_settings_versions ADD CONSTRAINT order_settings_previous_fk FOREIGN KEY (previous_version) REFERENCES order_settings_versions (version);
--> statement-breakpoint

-- Version 1 = the owner-approved initial value (B3, 2026-11-11): 900 seconds. Written as DATA by this migration, like refund policy 'temporary-0'.
INSERT INTO order_settings_versions (id, version, reservation_ttl_seconds, source, previous_version, changed_by, reason, created_at)
VALUES (gen_random_uuid(), 1, 900, 'SEED', NULL, 'decision:B3:2026-11-11',
        'Initial reservation hold approved by the owner (DECISIONS fourteenth review, B3): 900 seconds', now());
--> statement-breakpoint

-- ---------------------------------------------------------------- wallet limits (B5): two-person, versioned
CREATE TRIGGER wallet_limit_versions_no_delete BEFORE DELETE ON wallet_limit_versions
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER wallet_limit_versions_no_truncate BEFORE TRUNCATE ON wallet_limit_versions
  FOR EACH STATEMENT EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER wallet_limit_versions_immutable BEFORE UPDATE ON wallet_limit_versions
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'min_rial', 'max_rial', 'daily_max_rial', 'source', 'base_seq', 'requested_by', 'reason', 'created_at');
--> statement-breakpoint

-- A decision is final (REQUESTED -> APPROVED | REJECTED only), and an approval is assigned the NEXT sequence number against the CURRENT
-- active version: a request made against an older active version is stale and cannot be approved (it would silently undo a newer change).
CREATE FUNCTION wallet_limit_decision_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE v_max integer;
BEGIN
  IF OLD.status <> 'REQUESTED' THEN
    RAISE EXCEPTION 'a decided wallet limit version can never change' USING ERRCODE = 'PO003';
  END IF;
  IF NEW.status = 'APPROVED' THEN
    SELECT max(approved_seq) INTO v_max FROM public.wallet_limit_versions;
    IF NEW.approved_seq IS DISTINCT FROM coalesce(v_max, 0) + 1 OR NEW.base_seq IS DISTINCT FROM v_max THEN
      RAISE EXCEPTION 'stale wallet limit request: the active version changed since it was requested' USING ERRCODE = 'PO003';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER wallet_limit_versions_decision BEFORE UPDATE ON wallet_limit_versions
  FOR EACH ROW EXECUTE FUNCTION wallet_limit_decision_guard();
--> statement-breakpoint

-- Version 1 = the owner-approved initial limits (B5, 2026-11-11), integer Rial: 100,000 / 10,000,000 / 30,000,000 Toman.
INSERT INTO wallet_limit_versions (id, min_rial, max_rial, daily_max_rial, source, status, base_seq, approved_seq, requested_by, reason, decided_by, decision_reason, created_at, decided_at)
VALUES (gen_random_uuid(), 1000000, 100000000, 300000000, 'SEED', 'APPROVED', NULL, 1, 'decision:B5:2026-11-11',
        'Initial top-up limits approved by the owner (DECISIONS fourteenth review, B5)', 'owner-approval:fourteenth-review',
        'approved by the project owner; applied by migration 0025', now(), now());
--> statement-breakpoint

-- ---------------------------------------------------------------- order-time snapshots: immutable, internally consistent
DROP TRIGGER orders_immutable ON orders;
--> statement-breakpoint
CREATE TRIGGER orders_immutable BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'number', 'user_ref', 'payment_method', 'currency', 'total', 'pricing_version', 'refund_policy_version', 'policy_snapshot', 'idempotency_key', 'request_hash', 'payment_id', 'expires_at', 'created_at');
--> statement-breakpoint
ALTER TABLE orders ADD CONSTRAINT orders_snapshot_policy_consistent
  CHECK (policy_snapshot ->> 'refundPolicyVersion' = refund_policy_version);
--> statement-breakpoint

DROP TRIGGER wallet_topups_immutable ON wallet_topups;
--> statement-breakpoint
CREATE TRIGGER wallet_topups_immutable BEFORE UPDATE ON wallet_topups
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'user_ref', 'amount', 'idempotency_key', 'request_hash', 'limits_version', 'created_at');
--> statement-breakpoint
-- The daily-limit query counts a user's top-ups inside one Tehran day by (user_ref, created_at, status).
CREATE INDEX wallet_topups_daily_idx ON wallet_topups (user_ref, created_at) WHERE status IN ('REQUESTED', 'COMPLETED');
--> statement-breakpoint

-- ---------------------------------------------------------------- grants
SELECT platform_register_grants('order_settings_versions', 'append_only');
--> statement-breakpoint
SELECT platform_register_grants('wallet_limit_versions', 'append_only', ARRAY['status', 'approved_seq', 'decided_by', 'decision_reason', 'decided_at']);
--> statement-breakpoint

-- Owner receives the settings permissions (role data, like earlier modules). Changes are sensitive (step-up); wallet limits need a second administrator.
INSERT INTO role_permissions (id, role_id, permission, granted_by, granted_at)
SELECT gen_random_uuid(), r.id, p.permission, NULL, now()
  FROM roles r
  CROSS JOIN (VALUES ('orders.settings.read'), ('orders.settings.manage'), ('wallet.settings.read'), ('wallet.settings.request'), ('wallet.settings.approve')) AS p(permission)
 WHERE r.name = 'owner';
