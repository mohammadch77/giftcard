-- Refunds + reconciliation guards (Phase 2b-9). Forward-only; touches only tables created in 0022 plus two commit-time gates on orders/holds.
-- SQLSTATE PO002: refund gate violated.

INSERT INTO refund_policy_versions (version, status, legal_review_required, active, description, created_at) VALUES
  ('temporary-0', 'TEMPORARY', true, true,
   'SAFE PLACEHOLDERS (B12 open, legal review required): undelivered => eligible; delivered-unrevealed => review required; revealed => override permission + written reason. No time windows, fees or partial-refund rules exist.', now());
--> statement-breakpoint
INSERT INTO refund_policy_rules (version, disclosure_state, decision) VALUES
  ('temporary-0', 'NOT_DELIVERED', 'ELIGIBLE'),
  ('temporary-0', 'DELIVERED_UNREVEALED', 'REVIEW_REQUIRED'),
  ('temporary-0', 'REVEALED_BY_CUSTOMER', 'OVERRIDE_REQUIRED'),
  ('temporary-0', 'REVEALED_BY_ADMIN_ONLY', 'OVERRIDE_REQUIRED');
--> statement-breakpoint

INSERT INTO state_transition_rules (machine, from_status, to_status) VALUES
  ('refund', NULL, 'REQUESTED'),
  ('refund', 'REQUESTED', 'APPROVED'), ('refund', 'REQUESTED', 'REJECTED'),
  ('refund', 'APPROVED', 'PROCESSING'),
  ('refund', 'PROCESSING', 'COMPLETED'), ('refund', 'PROCESSING', 'FAILED'),
  ('refund', 'FAILED', 'PROCESSING'),
  ('order', 'FULFILLING', 'CANCELLED');   -- reachable only through a completed refund (orders_cancel_gate below)
--> statement-breakpoint
SELECT platform_attach_transition_guard('refunds', 'refund', 'refund_status_history', 'id', 'status', true);
--> statement-breakpoint

ALTER TABLE refunds ADD CONSTRAINT refunds_payment_fk FOREIGN KEY (payment_id) REFERENCES payments(id);
--> statement-breakpoint
ALTER TABLE refunds ADD CONSTRAINT refunds_ledger_fk FOREIGN KEY (ledger_txn_id) REFERENCES ledger_transactions(id);
--> statement-breakpoint
CREATE UNIQUE INDEX refunds_ledger_uq ON refunds (ledger_txn_id) WHERE ledger_txn_id IS NOT NULL;
--> statement-breakpoint

CREATE TRIGGER refunds_immutable BEFORE UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'order_id', 'hold_id', 'source', 'suspense_key', 'payment_id', 'requested_by', 'requester_type', 'reason_code', 'amount', 'destination', 'policy_version', 'eligibility_snapshot', 'decision', 'request_hash', 'created_at');
--> statement-breakpoint
CREATE TRIGGER refunds_set_once BEFORE UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION identity_set_once('decided_by', 'decided_at', 'decision_note', 'override_reason', 'ledger_txn_id', 'completed_at', 'gateway_refund_ref');
--> statement-breakpoint
CREATE TRIGGER refund_items_immutable BEFORE UPDATE ON refund_items
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'refund_id', 'order_item_id', 'amount', 'disclosure_state');
--> statement-breakpoint
CREATE TRIGGER refund_policy_rules_immutable BEFORE UPDATE ON refund_policy_rules
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('version', 'disclosure_state', 'decision');
--> statement-breakpoint
CREATE TRIGGER reconciliation_findings_no_mutation BEFORE UPDATE OR DELETE ON reconciliation_findings FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER reconciliation_findings_no_truncate BEFORE TRUNCATE ON reconciliation_findings FOR EACH STATEMENT EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint

-- Commit-time: a full-order ORDER_PAYMENT refund lists every item and its amounts add up to the refund.
CREATE FUNCTION refunds_items_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE v_sum numeric; v_items int; v_order_items int; v_total numeric;
BEGIN
  IF NEW.source <> 'ORDER_PAYMENT' THEN RETURN NULL; END IF;
  SELECT coalesce(sum(amount), 0), count(*) INTO v_sum, v_items FROM public.refund_items WHERE refund_id = NEW.id;
  SELECT count(*), coalesce(sum(line_total), 0) INTO v_order_items, v_total FROM public.order_items WHERE order_id = NEW.order_id;
  IF v_items <> v_order_items OR v_sum <> NEW.amount OR NEW.amount <> v_total THEN
    RAISE EXCEPTION 'a refund must cover every item of the order and equal its total (partial refunds are not approved)' USING ERRCODE = 'PO002';
  END IF;
  RETURN NULL;
END
$fn$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER refunds_items_consistent AFTER INSERT ON refunds DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION refunds_items_check();
--> statement-breakpoint

-- An order that already received money can only be CANCELLED through a COMPLETED refund.
CREATE FUNCTION orders_cancel_gate() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NEW.status = 'CANCELLED' AND OLD.status IN ('PAID', 'FULFILLING', 'PARTIALLY_COMPLETED', 'ON_HOLD')
     AND NOT EXISTS (SELECT 1 FROM public.refunds r WHERE r.order_id = NEW.id AND r.status = 'COMPLETED') THEN
    RAISE EXCEPTION 'a paid order can only be cancelled through a completed refund' USING ERRCODE = 'PO002';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER orders_cancel_gate BEFORE UPDATE OF status ON orders FOR EACH ROW EXECUTE FUNCTION orders_cancel_gate();
--> statement-breakpoint
-- A hold may be closed by a refund resolution only when that refund really COMPLETED.
CREATE FUNCTION order_holds_refund_gate() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NEW.resolution IN ('REFUND_WALLET', 'REFUND_GATEWAY') AND NOT EXISTS (
       SELECT 1 FROM public.refunds r WHERE r.order_id = NEW.order_id AND r.status = 'COMPLETED'
          AND r.destination = CASE NEW.resolution WHEN 'REFUND_WALLET' THEN 'WALLET' ELSE 'GATEWAY' END) THEN
    RAISE EXCEPTION 'a refund resolution requires a completed refund to that destination' USING ERRCODE = 'PO002';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER order_holds_refund_gate BEFORE UPDATE OF resolution ON order_holds FOR EACH ROW EXECUTE FUNCTION order_holds_refund_gate();
--> statement-breakpoint

SELECT platform_register_grants('refund_policy_versions', 'read_only');
--> statement-breakpoint
SELECT platform_register_grants('refund_policy_rules', 'read_only');
--> statement-breakpoint
SELECT platform_register_grants('refunds', 'append_only',
  ARRAY['status', 'decided_by', 'decided_at', 'decision_note', 'override_reason', 'external_outcome', 'gateway_refund_ref', 'attempts', 'ledger_txn_id', 'updated_at', 'completed_at']);
--> statement-breakpoint
SELECT platform_register_grants('refund_items', 'append_only');
--> statement-breakpoint
SELECT platform_register_grants('refund_status_history', 'append_only');
--> statement-breakpoint
SELECT platform_register_grants('reconciliation_runs', 'append_only', ARRAY['finished_at', 'finding_count']);
--> statement-breakpoint
SELECT platform_register_grants('reconciliation_findings', 'append_only');
--> statement-breakpoint

-- Owner receives the routine refund/reconciliation permissions. `orders.refunds.override_revealed` is deliberately NOT seeded to any role.
INSERT INTO role_permissions (id, role_id, permission, granted_by, granted_at)
SELECT gen_random_uuid(), r.id, p.permission, NULL, now()
  FROM roles r
  CROSS JOIN (VALUES ('orders.refunds.read'), ('orders.refunds.request'), ('orders.refunds.approve'), ('orders.refunds.execute'), ('orders.reconciliation.run'), ('orders.reconciliation.read')) AS p(permission)
 WHERE r.name = 'owner';
