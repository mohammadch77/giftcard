-- Inventory guards (Phase 2b-5). Forward-only; touches only tables created in 0014.
-- SQLSTATEs: PV001 code/reservation rule violated, PV002 sold-code immutability.

INSERT INTO state_transition_rules (machine, from_status, to_status) VALUES
  ('inventory_code', NULL, 'AVAILABLE'),
  ('inventory_code', 'AVAILABLE', 'RESERVED'), ('inventory_code', 'RESERVED', 'AVAILABLE'), ('inventory_code', 'RESERVED', 'SOLD'),
  ('inventory_code', 'AVAILABLE', 'VOID'), ('inventory_code', 'AVAILABLE', 'QUARANTINED'),
  ('inventory_code', 'QUARANTINED', 'AVAILABLE'), ('inventory_code', 'QUARANTINED', 'VOID'), ('inventory_code', 'SOLD', 'VOID'),
  ('inventory_reservation', NULL, 'ACTIVE'),
  ('inventory_reservation', 'ACTIVE', 'CONSUMED'), ('inventory_reservation', 'ACTIVE', 'RELEASED'), ('inventory_reservation', 'ACTIVE', 'EXPIRED');
--> statement-breakpoint
-- Movements are the history of code/reservation changes (append-only), so the engines run without history tables.
SELECT platform_attach_transition_guard('digital_codes', 'inventory_code');
--> statement-breakpoint
SELECT platform_attach_transition_guard('inventory_reservations', 'inventory_reservation');
--> statement-breakpoint

CREATE TRIGGER digital_codes_immutable BEFORE UPDATE ON digital_codes
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'variant_id', 'batch_id', 'code_fp', 'hmac_version', 'payload_kind', 'created_at');
--> statement-breakpoint
CREATE TRIGGER inventory_reservations_immutable BEFORE UPDATE ON inventory_reservations
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'reservation_key', 'order_ref', 'request_hash', 'created_at', 'expires_at');
--> statement-breakpoint
CREATE TRIGGER inventory_reservations_set_once BEFORE UPDATE ON inventory_reservations
  FOR EACH ROW EXECUTE FUNCTION identity_set_once('consumed_at', 'closed_at');
--> statement-breakpoint
CREATE TRIGGER inventory_reservation_lines_immutable BEFORE UPDATE ON inventory_reservation_lines
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'reservation_id', 'variant_id', 'kind', 'quantity');
--> statement-breakpoint
CREATE TRIGGER inventory_reservation_lines_sold_once BEFORE UPDATE ON inventory_reservation_lines
  FOR EACH ROW EXECUTE FUNCTION identity_set_once('sold_at');
--> statement-breakpoint

-- THE delivery guard. A code becomes RESERVED only under an ACTIVE reservation, and SOLD only under a CONSUMED one
-- (consumed strictly before expiry, see the CHECK on the reservation). A SOLD code is frozen except SOLD -> VOID.
CREATE FUNCTION inventory_code_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE v_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'SOLD' THEN
    IF NEW.status NOT IN ('SOLD', 'VOID')
       OR NEW.order_item_ref IS DISTINCT FROM OLD.order_item_ref OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
       OR NEW.sold_at IS DISTINCT FROM OLD.sold_at OR NEW.sealed IS DISTINCT FROM OLD.sealed THEN
      RAISE EXCEPTION 'a sold code is immutable' USING ERRCODE = 'PV002';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'RESERVED' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'RESERVED' OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id) THEN
    SELECT status INTO v_status FROM public.inventory_reservations WHERE id = NEW.reservation_id;
    IF v_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'a code can only be reserved under an ACTIVE reservation' USING ERRCODE = 'PV001';
    END IF;
  END IF;
  IF NEW.status = 'SOLD' AND TG_OP = 'UPDATE' THEN
    SELECT status INTO v_status FROM public.inventory_reservations WHERE id = NEW.reservation_id;
    IF v_status IS DISTINCT FROM 'CONSUMED' THEN
      RAISE EXCEPTION 'a code can only be sold under a CONSUMED reservation' USING ERRCODE = 'PV001';
    END IF;
  END IF;
  IF NEW.status = 'SOLD' AND TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'codes are never created as sold' USING ERRCODE = 'PV001';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER digital_codes_guard BEFORE INSERT OR UPDATE ON digital_codes
  FOR EACH ROW EXECUTE FUNCTION inventory_code_guard();
--> statement-breakpoint

-- Append-only evidence.
CREATE TRIGGER inventory_movements_no_mutation BEFORE UPDATE OR DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER inventory_movements_no_truncate BEFORE TRUNCATE ON inventory_movements
  FOR EACH STATEMENT EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER code_access_log_no_mutation BEFORE UPDATE OR DELETE ON code_access_log
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER code_access_log_no_truncate BEFORE TRUNCATE ON code_access_log
  FOR EACH STATEMENT EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint

SELECT platform_register_grants('inventory_batches', 'append_only', ARRAY['duplicate_count']);
--> statement-breakpoint
SELECT platform_register_grants('inventory_reservations', 'append_only', ARRAY['status', 'consumed_at', 'closed_at']);
--> statement-breakpoint
SELECT platform_register_grants('inventory_reservation_lines', 'append_only', ARRAY['sold_at']);
--> statement-breakpoint
SELECT platform_register_grants('digital_codes', 'append_only', ARRAY['status', 'reservation_id', 'reserved_until', 'order_item_ref', 'sold_at', 'updated_at']);
--> statement-breakpoint
SELECT platform_register_grants('stock_counters', 'append_only', ARRAY['available', 'reserved', 'updated_at']);
--> statement-breakpoint
SELECT platform_register_grants('inventory_movements', 'append_only');
--> statement-breakpoint
SELECT platform_register_grants('code_access_log', 'append_only');
--> statement-breakpoint

-- Inventory permissions go to the `owner` role (role data, like 0011/0013). No role gets a "reveal" permission:
-- plaintext is released only to the delivery path (fulfilment, later), never to an administrator.
INSERT INTO role_permissions (id, role_id, permission, granted_by, granted_at)
SELECT gen_random_uuid(), r.id, p.permission, NULL, now()
  FROM roles r
  CROSS JOIN (VALUES ('inventory.stock.read'), ('inventory.codes.import'), ('inventory.codes.manage'), ('inventory.stock.adjust')) AS p(permission)
 WHERE r.name = 'owner';
