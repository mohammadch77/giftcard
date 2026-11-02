-- Payments + wallet guards (Phase 2b-6). Forward-only; touches only tables created in 0016.
-- PARTIALLY_REFUNDED / REFUNDED payment states belong to 2b-9 (refunds) and are NOT part of this migration.

INSERT INTO state_transition_rules (machine, from_status, to_status) VALUES
  ('payment', NULL, 'INITIATED'),
  ('payment', 'INITIATED', 'PENDING'), ('payment', 'INITIATED', 'FAILED'),
  ('payment', 'PENDING', 'VERIFYING'), ('payment', 'PENDING', 'EXPIRED'), ('payment', 'PENDING', 'CANCELLED'),
  ('payment', 'VERIFYING', 'SUCCEEDED'), ('payment', 'VERIFYING', 'FAILED'), ('payment', 'VERIFYING', 'NEEDS_REVIEW'),
  ('payment', 'NEEDS_REVIEW', 'SUCCEEDED'), ('payment', 'NEEDS_REVIEW', 'FAILED'),
  ('wallet_topup', NULL, 'REQUESTED'), ('wallet_topup', 'REQUESTED', 'COMPLETED'), ('wallet_topup', 'REQUESTED', 'FAILED'),
  ('wallet_adjustment', NULL, 'REQUESTED'), ('wallet_adjustment', 'REQUESTED', 'COMPLETED'), ('wallet_adjustment', 'REQUESTED', 'REJECTED');
--> statement-breakpoint
SELECT platform_attach_transition_guard('payments', 'payment', 'payment_status_history', 'id', 'status', true);
--> statement-breakpoint
SELECT platform_attach_transition_guard('wallet_topups', 'wallet_topup');
--> statement-breakpoint
SELECT platform_attach_transition_guard('wallet_adjustments', 'wallet_adjustment');
--> statement-breakpoint

-- Cross-module FKs created in SQL (P-1).
ALTER TABLE wallet_topups ADD CONSTRAINT wallet_topups_payment_fk FOREIGN KEY (payment_id) REFERENCES payments(id);
--> statement-breakpoint
ALTER TABLE wallet_topups ADD CONSTRAINT wallet_topups_ledger_fk FOREIGN KEY (ledger_txn_id) REFERENCES ledger_transactions(id);
--> statement-breakpoint
ALTER TABLE wallet_adjustments ADD CONSTRAINT wallet_adjustments_ledger_fk FOREIGN KEY (ledger_txn_id) REFERENCES ledger_transactions(id);
--> statement-breakpoint
-- One ledger posting per business row.
CREATE UNIQUE INDEX wallet_topups_ledger_uq ON wallet_topups (ledger_txn_id) WHERE ledger_txn_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX wallet_adjustments_ledger_uq ON wallet_adjustments (ledger_txn_id) WHERE ledger_txn_id IS NOT NULL;
--> statement-breakpoint

CREATE TRIGGER payments_immutable BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'purpose', 'order_ref', 'topup_ref', 'user_ref', 'gateway', 'amount', 'currency', 'idempotency_key', 'request_hash', 'created_at');
--> statement-breakpoint
CREATE TRIGGER payments_set_once BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION identity_set_once('gateway_ref', 'verified_at', 'verified_amount');
--> statement-breakpoint
CREATE TRIGGER wallet_topups_immutable BEFORE UPDATE ON wallet_topups
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'user_ref', 'amount', 'idempotency_key', 'request_hash', 'created_at');
--> statement-breakpoint
CREATE TRIGGER wallet_topups_set_once BEFORE UPDATE ON wallet_topups
  FOR EACH ROW EXECUTE FUNCTION identity_set_once('payment_id', 'ledger_txn_id', 'completed_at');
--> statement-breakpoint
CREATE TRIGGER wallet_adjustments_immutable BEFORE UPDATE ON wallet_adjustments
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'user_ref', 'direction', 'amount', 'reason', 'requested_by', 'created_at');
--> statement-breakpoint
CREATE TRIGGER wallet_adjustments_set_once BEFORE UPDATE ON wallet_adjustments
  FOR EACH ROW EXECUTE FUNCTION identity_set_once('decided_by', 'decision_reason', 'decided_at', 'ledger_txn_id');
--> statement-breakpoint

CREATE TRIGGER payment_events_no_mutation BEFORE UPDATE OR DELETE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_events_no_truncate BEFORE TRUNCATE ON payment_events
  FOR EACH STATEMENT EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint

SELECT platform_register_grants('payments', 'append_only',
  ARRAY['gateway_ref', 'status', 'verifying_since', 'verify_attempts', 'verified_at', 'verified_amount', 'review_reason', 'updated_at']);
--> statement-breakpoint
SELECT platform_register_grants('payment_events', 'append_only');
--> statement-breakpoint
SELECT platform_register_grants('payment_status_history', 'append_only');
--> statement-breakpoint
SELECT platform_register_grants('wallet_topups', 'append_only', ARRAY['status', 'payment_id', 'ledger_txn_id', 'completed_at']);
--> statement-breakpoint
SELECT platform_register_grants('wallet_adjustments', 'append_only', ARRAY['status', 'decided_by', 'decision_reason', 'ledger_txn_id', 'decided_at']);
--> statement-breakpoint

-- Permissions owned by payments/wallet go to the `owner` role only (role data, like 0011/0013/0015).
INSERT INTO role_permissions (id, role_id, permission, granted_by, granted_at)
SELECT gen_random_uuid(), r.id, p.permission, NULL, now()
  FROM roles r
  CROSS JOIN (VALUES ('payments.read'), ('wallet.read'), ('wallet.adjust.request'), ('wallet.adjust.approve')) AS p(permission)
 WHERE r.name = 'owner';
