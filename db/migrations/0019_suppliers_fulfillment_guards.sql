-- Suppliers + fulfillment guards (Phase 2b-7). Forward-only; touches only tables created in 0018.
-- SQLSTATEs: PF001 delivery/fulfilment rule violated. The payment-gate trigger (delivery requires a PAID order) needs the
-- orders table and is installed in step 2b-8, as recorded in PHASE_2B_PLAN.

INSERT INTO state_transition_rules (machine, from_status, to_status) VALUES
  ('supplier_order', NULL, 'CREATED'),
  ('supplier_order', 'CREATED', 'SUBMITTING'),
  ('supplier_order', 'SUBMITTING', 'CONFIRMED'), ('supplier_order', 'SUBMITTING', 'REJECTED'), ('supplier_order', 'SUBMITTING', 'UNKNOWN'),
  ('supplier_order', 'SUBMITTING', 'CREATED'),  -- ONLY when the adapter proves nothing was transmitted (SupplierNotSentError)
  ('supplier_order', 'UNKNOWN', 'CONFIRMED'), ('supplier_order', 'UNKNOWN', 'REJECTED'),
  ('supplier_order', 'UNKNOWN', 'CREATED'),    -- ONLY for suppliers documented as idempotent on resubmission
  ('fulfillment_task', NULL, 'PENDING'),
  ('fulfillment_task', 'PENDING', 'PROCESSING'), ('fulfillment_task', 'PROCESSING', 'COMPLETED'), ('fulfillment_task', 'PROCESSING', 'FAILED'),
  ('fulfillment_task', 'FAILED', 'PENDING'), ('fulfillment_task', 'FAILED', 'PROCESSING'), ('fulfillment_task', 'FAILED', 'CANCELLED'),
  ('fulfillment_task', 'PENDING', 'CANCELLED'), ('fulfillment_task', 'PROCESSING', 'CANCELLED');
--> statement-breakpoint
SELECT platform_attach_transition_guard('supplier_orders', 'supplier_order');
--> statement-breakpoint
SELECT platform_attach_transition_guard('fulfillment_tasks', 'fulfillment_task');
--> statement-breakpoint

-- Cross-module FKs (P-1).
ALTER TABLE variant_supplier_routes ADD CONSTRAINT variant_supplier_routes_variant_fk FOREIGN KEY (variant_id) REFERENCES product_variants(id);
--> statement-breakpoint
ALTER TABLE fulfillment_tasks ADD CONSTRAINT fulfillment_tasks_variant_fk FOREIGN KEY (variant_id) REFERENCES product_variants(id);
--> statement-breakpoint
ALTER TABLE fulfillment_tasks ADD CONSTRAINT fulfillment_tasks_supplier_order_fk FOREIGN KEY (supplier_order_id) REFERENCES supplier_orders(id);
--> statement-breakpoint
ALTER TABLE deliveries ADD CONSTRAINT deliveries_code_fk FOREIGN KEY (code_ref) REFERENCES digital_codes(id);
--> statement-breakpoint
CREATE UNIQUE INDEX deliveries_code_uq ON deliveries (code_ref) WHERE code_ref IS NOT NULL;
--> statement-breakpoint

CREATE TRIGGER suppliers_immutable BEFORE UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'key', 'adapter_key', 'created_at');
--> statement-breakpoint
CREATE TRIGGER supplier_credentials_immutable BEFORE UPDATE ON supplier_credentials FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'supplier_id', 'sealed', 'created_at');
--> statement-breakpoint
CREATE TRIGGER supplier_credentials_set_once BEFORE UPDATE ON supplier_credentials FOR EACH ROW EXECUTE FUNCTION identity_set_once('replaced_at');
--> statement-breakpoint
CREATE TRIGGER supplier_products_immutable BEFORE UPDATE ON supplier_products FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'supplier_id', 'external_sku', 'created_at');
--> statement-breakpoint
CREATE TRIGGER variant_supplier_routes_immutable BEFORE UPDATE ON variant_supplier_routes FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'variant_id', 'supplier_product_id', 'created_at');
--> statement-breakpoint
CREATE TRIGGER supplier_orders_immutable BEFORE UPDATE ON supplier_orders
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'supplier_id', 'supplier_product_id', 'order_item_ref', 'quantity', 'idempotency_key', 'request_hash', 'created_at');
--> statement-breakpoint
CREATE TRIGGER supplier_orders_set_once BEFORE UPDATE ON supplier_orders FOR EACH ROW EXECUTE FUNCTION identity_set_once('external_ref', 'reject_reason');
--> statement-breakpoint
CREATE TRIGGER fulfillment_tasks_immutable BEFORE UPDATE ON fulfillment_tasks
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'order_ref', 'order_item_ref', 'user_ref', 'variant_id', 'method', 'payment_ref', 'created_at');
--> statement-breakpoint
CREATE TRIGGER fulfillment_tasks_set_once BEFORE UPDATE ON fulfillment_tasks FOR EACH ROW EXECUTE FUNCTION identity_set_once('completed_at');
--> statement-breakpoint
CREATE TRIGGER deliveries_immutable BEFORE UPDATE ON deliveries
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'order_item_ref', 'user_ref', 'kind', 'code_ref', 'delivered_at');
--> statement-breakpoint
CREATE TRIGGER deliveries_first_reveal_once BEFORE UPDATE ON deliveries FOR EACH ROW EXECUTE FUNCTION identity_set_once('first_revealed_at', 'first_revealed_by_type');
--> statement-breakpoint

-- Append-only evidence / secrets.
CREATE TRIGGER supplier_order_events_no_mutation BEFORE UPDATE OR DELETE ON supplier_order_events FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER supplier_product_changes_no_mutation BEFORE UPDATE OR DELETE ON supplier_product_changes FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER supplier_order_secrets_no_mutation BEFORE UPDATE OR DELETE ON supplier_order_secrets FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER fulfillment_events_no_mutation BEFORE UPDATE OR DELETE ON fulfillment_events FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER delivery_secrets_no_mutation BEFORE UPDATE OR DELETE ON delivery_secrets FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER secret_access_log_no_mutation BEFORE UPDATE OR DELETE ON secret_access_log FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint

-- Delivery integrity: an inventory-backed delivery needs a SOLD code assigned to exactly this order item;
-- a task can be COMPLETED only when its delivery exists.
CREATE FUNCTION fulfillment_delivery_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NEW.kind = 'INVENTORY_CODE' AND NOT EXISTS (
       SELECT 1 FROM public.digital_codes c WHERE c.id = NEW.code_ref AND c.status = 'SOLD' AND c.order_item_ref = NEW.order_item_ref) THEN
    RAISE EXCEPTION 'delivery requires a SOLD code assigned to this order item' USING ERRCODE = 'PF001';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER deliveries_guard BEFORE INSERT ON deliveries FOR EACH ROW EXECUTE FUNCTION fulfillment_delivery_guard();
--> statement-breakpoint
CREATE FUNCTION fulfillment_task_complete_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NEW.status = 'COMPLETED' AND OLD.status IS DISTINCT FROM 'COMPLETED'
     AND NOT EXISTS (SELECT 1 FROM public.deliveries d WHERE d.order_item_ref = NEW.order_item_ref) THEN
    RAISE EXCEPTION 'a task can only be completed after its delivery exists' USING ERRCODE = 'PF001';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER fulfillment_tasks_complete_guard BEFORE UPDATE ON fulfillment_tasks FOR EACH ROW EXECUTE FUNCTION fulfillment_task_complete_guard();
--> statement-breakpoint

SELECT platform_register_grants('suppliers', 'append_only', ARRAY['name', 'status', 'config', 'updated_at']);
--> statement-breakpoint
SELECT platform_register_grants('supplier_credentials', 'append_only', ARRAY['status', 'replaced_at']);
--> statement-breakpoint
SELECT platform_register_grants('supplier_products', 'append_only', ARRAY['name', 'cost', 'available', 'stock_hint', 'raw_hash', 'last_synced_at']);
--> statement-breakpoint
SELECT platform_register_grants('supplier_sync_runs', 'append_only', ARRAY['status', 'fetched', 'created', 'updated', 'rejected', 'error_kind', 'finished_at']);
--> statement-breakpoint
SELECT platform_register_grants('supplier_product_changes', 'append_only');
--> statement-breakpoint
SELECT platform_register_grants('variant_supplier_routes', 'append_only', ARRAY['priority', 'active', 'updated_at']);
--> statement-breakpoint
SELECT platform_register_grants('supplier_orders', 'append_only',
  ARRAY['status', 'external_ref', 'reject_reason', 'attempts', 'submitting_since', 'note', 'request_redacted', 'response_redacted', 'updated_at']);
--> statement-breakpoint
SELECT platform_register_grants('supplier_order_secrets', 'append_only');
--> statement-breakpoint
SELECT platform_register_grants('supplier_order_events', 'append_only');
--> statement-breakpoint
SELECT platform_register_grants('fulfillment_tasks', 'append_only', ARRAY['status', 'assignee', 'attempt', 'last_error', 'supplier_order_id', 'updated_at', 'completed_at']);
--> statement-breakpoint
SELECT platform_register_grants('fulfillment_events', 'append_only');
--> statement-breakpoint
SELECT platform_register_grants('deliveries', 'append_only', ARRAY['first_revealed_at', 'first_revealed_by_type', 'last_revealed_at', 'reveal_count']);
--> statement-breakpoint
SELECT platform_register_grants('delivery_secrets', 'append_only');
--> statement-breakpoint
SELECT platform_register_grants('secret_access_log', 'append_only');
--> statement-breakpoint

-- Permissions owned by suppliers/fulfillment go to `owner` (role data). `fulfillment.codes.reveal` is deliberately NOT seeded to any role.
INSERT INTO role_permissions (id, role_id, permission, granted_by, granted_at)
SELECT gen_random_uuid(), r.id, p.permission, NULL, now()
  FROM roles r
  CROSS JOIN (VALUES ('suppliers.read'), ('suppliers.manage'), ('suppliers.credentials.manage'), ('suppliers.routes.manage'), ('suppliers.sync.run'),
                     ('suppliers.orders.resolve'), ('fulfillment.tasks.read'), ('fulfillment.manual.claim'), ('fulfillment.manual.complete')) AS p(permission)
 WHERE r.name = 'owner';
