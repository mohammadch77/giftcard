-- Orders guards (Phase 2b-8). Forward-only; touches tables created in 0020 and adds the payment gate on
-- fulfilment tables created in 0018. SQLSTATE PO001: order/fulfilment gate violated.

INSERT INTO state_transition_rules (machine, from_status, to_status) VALUES
  ('order', NULL, 'PENDING_PAYMENT'),
  ('order', 'PENDING_PAYMENT', 'PAID'), ('order', 'PENDING_PAYMENT', 'CANCELLED'), ('order', 'PENDING_PAYMENT', 'EXPIRED'),
  ('order', 'PENDING_PAYMENT', 'ON_HOLD'),                      -- late payment / payment needs review
  ('order', 'EXPIRED', 'ON_HOLD'), ('order', 'CANCELLED', 'ON_HOLD'),  -- ONLY for a late payment arriving after expiry/cancellation (F3)
  ('order', 'PAID', 'FULFILLING'), ('order', 'PAID', 'ON_HOLD'), ('order', 'PAID', 'COMPLETED'),
  ('order', 'FULFILLING', 'COMPLETED'), ('order', 'FULFILLING', 'PARTIALLY_COMPLETED'), ('order', 'FULFILLING', 'ON_HOLD'),
  ('order', 'PARTIALLY_COMPLETED', 'COMPLETED'),
  ('order', 'PARTIALLY_COMPLETED', 'CANCELLED'), ('order', 'PAID', 'CANCELLED'),     -- refunds only (2b-9 owns the API)
  ('order', 'ON_HOLD', 'PAID'), ('order', 'ON_HOLD', 'CANCELLED');
--> statement-breakpoint
SELECT platform_attach_transition_guard('orders', 'order', 'order_status_history', 'id', 'status', true);
--> statement-breakpoint

ALTER TABLE orders ADD CONSTRAINT orders_reservation_fk FOREIGN KEY (reservation_id) REFERENCES inventory_reservations(id);
--> statement-breakpoint
ALTER TABLE orders ADD CONSTRAINT orders_payment_fk FOREIGN KEY (payment_id) REFERENCES payments(id);
--> statement-breakpoint
ALTER TABLE orders ADD CONSTRAINT orders_ledger_fk FOREIGN KEY (settlement_ledger_txn_id) REFERENCES ledger_transactions(id);
--> statement-breakpoint
CREATE UNIQUE INDEX orders_payment_uq ON orders (payment_id) WHERE payment_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX orders_ledger_uq ON orders (settlement_ledger_txn_id) WHERE settlement_ledger_txn_id IS NOT NULL;
--> statement-breakpoint

CREATE TRIGGER orders_immutable BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'number', 'user_ref', 'payment_method', 'currency', 'total', 'pricing_version', 'idempotency_key', 'request_hash', 'payment_id', 'expires_at', 'created_at');
--> statement-breakpoint
CREATE TRIGGER orders_set_once BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION identity_set_once('paid_at', 'settlement_ledger_txn_id');
--> statement-breakpoint
CREATE TRIGGER order_items_immutable BEFORE UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'order_id', 'line_no', 'variant_id', 'quantity', 'unit_price', 'line_total', 'snapshot', 'created_at');
--> statement-breakpoint
CREATE TRIGGER order_holds_immutable BEFORE UPDATE ON order_holds
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'order_id', 'reason', 'opened_at', 'opened_by');
--> statement-breakpoint
CREATE TRIGGER order_holds_set_once BEFORE UPDATE ON order_holds FOR EACH ROW EXECUTE FUNCTION identity_set_once('resolved_at', 'resolved_by', 'resolution', 'note');
--> statement-breakpoint

-- Commit-time invariants: (1) the order total equals the sum of its immutable items; (2) an order is ON_HOLD iff it has an open hold.
CREATE FUNCTION orders_total_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE v_sum numeric; v_n int;
BEGIN
  SELECT coalesce(sum(line_total), 0), count(*) INTO v_sum, v_n FROM public.order_items WHERE order_id = NEW.id;
  IF v_n = 0 OR v_sum <> NEW.total THEN
    RAISE EXCEPTION 'order total must equal the sum of its items' USING ERRCODE = 'PO001';
  END IF;
  RETURN NULL;
END
$fn$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER orders_total_consistent AFTER INSERT ON orders DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION orders_total_check();
--> statement-breakpoint
CREATE FUNCTION orders_hold_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE v_order uuid; v_status text; v_open boolean;
BEGIN
  v_order := (CASE TG_TABLE_NAME WHEN 'orders' THEN to_jsonb(NEW) ->> 'id' ELSE to_jsonb(NEW) ->> 'order_id' END)::uuid;
  SELECT status INTO v_status FROM public.orders WHERE id = v_order;
  SELECT EXISTS (SELECT 1 FROM public.order_holds WHERE order_id = v_order AND resolved_at IS NULL) INTO v_open;
  IF (v_status = 'ON_HOLD') <> v_open THEN
    RAISE EXCEPTION 'an order is ON_HOLD exactly while it has an open hold' USING ERRCODE = 'PO001';
  END IF;
  RETURN NULL;
END
$fn$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER orders_hold_consistent_o AFTER INSERT OR UPDATE OF status ON orders DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION orders_hold_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER orders_hold_consistent_h AFTER INSERT OR UPDATE ON order_holds DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION orders_hold_check();
--> statement-breakpoint

-- THE PAYMENT GATE. Fulfilment tasks and deliveries can only exist for an order item whose order is PAID (payment verified),
-- belongs to the same customer and (for tasks) the same order and variant. Item references are '<order_item_id>#<unit>'.
CREATE FUNCTION orders_fulfilment_gate() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE v_item uuid; o record; i record; n jsonb := to_jsonb(NEW);
BEGIN
  BEGIN
    v_item := split_part(n ->> 'order_item_ref', '#', 1)::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'fulfilment requires a valid order item reference' USING ERRCODE = 'PO001';
  END;
  SELECT * INTO i FROM public.order_items WHERE id = v_item;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulfilment requires an existing order item' USING ERRCODE = 'PO001';
  END IF;
  SELECT * INTO o FROM public.orders WHERE id = i.order_id;
  IF o.status NOT IN ('PAID', 'FULFILLING', 'PARTIALLY_COMPLETED', 'COMPLETED') OR o.payment_status <> 'SUCCEEDED' THEN
    RAISE EXCEPTION 'fulfilment requires a paid order' USING ERRCODE = 'PO001';
  END IF;
  IF o.user_ref <> (n ->> 'user_ref') THEN
    RAISE EXCEPTION 'delivery must belong to the order''s customer' USING ERRCODE = 'PO001';
  END IF;
  IF TG_TABLE_NAME = 'fulfillment_tasks' AND ((n ->> 'order_ref') <> o.id::text OR (n ->> 'variant_id')::uuid <> i.variant_id) THEN
    RAISE EXCEPTION 'task does not match its order item' USING ERRCODE = 'PO001';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER fulfillment_tasks_payment_gate BEFORE INSERT ON fulfillment_tasks FOR EACH ROW EXECUTE FUNCTION orders_fulfilment_gate();
--> statement-breakpoint
CREATE TRIGGER deliveries_payment_gate BEFORE INSERT ON deliveries FOR EACH ROW EXECUTE FUNCTION orders_fulfilment_gate();
--> statement-breakpoint

CREATE TRIGGER order_holds_no_truncate BEFORE TRUNCATE ON order_holds FOR EACH STATEMENT EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint

SELECT platform_register_grants('orders', 'append_only', ARRAY['status', 'payment_status', 'reservation_id', 'settlement_ledger_txn_id', 'paid_at', 'updated_at']);
--> statement-breakpoint
SELECT platform_register_grants('order_items', 'append_only');
--> statement-breakpoint
SELECT platform_register_grants('order_status_history', 'append_only');
--> statement-breakpoint
SELECT platform_register_grants('order_holds', 'append_only', ARRAY['resolved_at', 'resolved_by', 'resolution', 'note']);
--> statement-breakpoint

INSERT INTO role_permissions (id, role_id, permission, granted_by, granted_at)
SELECT gen_random_uuid(), r.id, p.permission, NULL, now()
  FROM roles r
  CROSS JOIN (VALUES ('orders.read'), ('orders.cancel'), ('orders.resolve_hold')) AS p(permission)
 WHERE r.name = 'owner';
