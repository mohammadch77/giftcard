-- P1-B guards: C-2 fulfilment matrix + protected method change, B1/B2 relationships and typed game-account attributes, OPS-2 code expiry.
-- Forward-only. Touches only catalog and inventory objects. SQLSTATEs: PC003 fulfilment/price rule, PC004 actor required, PC005 game/platform/region rule,
-- PV001 code/reservation rule, PV003 code-expiry rule.
-- It never rewrites a variant, order, reservation or code: grandfathered (now incompatible) variants simply cannot be PUBLISHED again.

-- ===================================================================== C-2: the approved fulfilment matrix (data, changed only by migration)
-- Approved direction: gift cards / digital codes AUTO_CODE; game accounts MANUAL; subscriptions MANUAL or SUPPLIER_API (per product).
-- DIGITAL_SERVICE and OTHER are not named by the approved direction and are left exactly as they were (see OPEN_QUESTIONS C-2b).
DELETE FROM product_type_fulfillment WHERE (product_type, method) IN (
  ('GIFT_CARD', 'MANUAL'), ('GIFT_CARD', 'SUPPLIER_API'),
  ('GAME_ACCOUNT', 'AUTO_CODE'),
  ('GAME_SUBSCRIPTION', 'AUTO_CODE'), ('STREAMING_SUBSCRIPTION', 'AUTO_CODE')
);
--> statement-breakpoint

-- ===================================================================== C-2: every method change is recorded first, in the same transaction
CREATE FUNCTION catalog_fulfillment_change_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE v_actor text := NULLIF(current_setting('app.actor_id', true), '');
BEGIN
  IF v_actor IS NULL OR NEW.actor_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'a fulfilment-method change must be recorded by the acting administrator (app.actor_id)' USING ERRCODE = 'PC004';
  END IF;
  NEW.txid := txid_current();
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER variant_fulfillment_changes_guard BEFORE INSERT ON variant_fulfillment_changes
  FOR EACH ROW EXECUTE FUNCTION catalog_fulfillment_change_guard();
--> statement-breakpoint
CREATE TRIGGER variant_fulfillment_changes_no_mutation BEFORE UPDATE OR DELETE ON variant_fulfillment_changes
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER variant_fulfillment_changes_no_truncate BEFORE TRUNCATE ON variant_fulfillment_changes
  FOR EACH STATEMENT EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint

-- ===================================================================== variant guard (replaces the 0013 function; the trigger stays bound)
CREATE OR REPLACE FUNCTION catalog_variant_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE v_type text; v_pstatus text; v_game uuid; v_ok boolean;
BEGIN
  SELECT type, status, game_id INTO v_type, v_pstatus, v_game FROM public.products WHERE id = NEW.product_id;

  -- C-2: the method must suit the product type; on UPDATE it may change only while DRAFT AND only through the recorded, protected change.
  IF TG_OP = 'INSERT' OR NEW.fulfillment_method IS DISTINCT FROM OLD.fulfillment_method THEN
    IF TG_OP = 'UPDATE' THEN
      IF OLD.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'fulfilment method can only change while the variant is DRAFT' USING ERRCODE = 'PC003';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.variant_fulfillment_changes c
                      WHERE c.variant_id = NEW.id AND c.txid = txid_current() AND c.from_method = OLD.fulfillment_method AND c.to_method = NEW.fulfillment_method) THEN
        RAISE EXCEPTION 'a fulfilment-method change must go through the protected change (reason, actor, usage checks)' USING ERRCODE = 'PC003';
      END IF;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.product_type_fulfillment WHERE product_type = v_type AND method = NEW.fulfillment_method) THEN
      RAISE EXCEPTION 'fulfilment method % is not allowed for product type %', NEW.fulfillment_method, v_type USING ERRCODE = 'PC003';
    END IF;
  END IF;

  -- B1/B2: platform is frozen outside DRAFT, must belong to the product's game, and (with a region) the triple must be offered.
  IF TG_OP = 'UPDATE' AND NEW.platform_id IS DISTINCT FROM OLD.platform_id AND OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'the platform can only change while the variant is DRAFT' USING ERRCODE = 'PC003';
  END IF;
  IF NEW.platform_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.platform_id IS DISTINCT FROM OLD.platform_id OR NEW.region_id IS DISTINCT FROM OLD.region_id) THEN
    IF (TG_OP = 'INSERT' OR NEW.platform_id IS DISTINCT FROM OLD.platform_id)
       AND NOT EXISTS (SELECT 1 FROM public.platforms WHERE id = NEW.platform_id AND status = 'ACTIVE') THEN
      RAISE EXCEPTION 'the platform is archived' USING ERRCODE = 'PC005';
    END IF;
    IF v_game IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.game_platforms WHERE game_id = v_game AND platform_id = NEW.platform_id) THEN
        RAISE EXCEPTION 'the game is not offered on this platform' USING ERRCODE = 'PC005';
      END IF;
      IF NEW.region_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.game_platform_regions WHERE game_id = v_game AND platform_id = NEW.platform_id AND region_id = NEW.region_id) THEN
        RAISE EXCEPTION 'the game is not offered on this platform in this region' USING ERRCODE = 'PC005';
      END IF;
    END IF;
  END IF;

  IF NEW.status = 'PUBLISHED' THEN
    IF v_pstatus <> 'PUBLISHED' THEN
      RAISE EXCEPTION 'a variant can only be published under a published product' USING ERRCODE = 'PC001';
    END IF;
    IF NEW.price <= 0 THEN
      RAISE EXCEPTION 'a published variant needs a price above zero' USING ERRCODE = 'PC003';
    END IF;
    IF TG_OP = 'INSERT' OR OLD.status <> 'PUBLISHED' THEN
      -- A grandfathered variant whose method the matrix no longer allows cannot be published again until it is corrected.
      SELECT EXISTS (SELECT 1 FROM public.product_type_fulfillment WHERE product_type = v_type AND method = NEW.fulfillment_method) INTO v_ok;
      IF NOT v_ok THEN
        RAISE EXCEPTION 'fulfilment method % is not allowed for product type %', NEW.fulfillment_method, v_type USING ERRCODE = 'PC003';
      END IF;
      IF v_type = 'GAME_ACCOUNT' AND (v_game IS NULL OR NEW.platform_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.game_account_attributes WHERE variant_id = NEW.id)) THEN
        RAISE EXCEPTION 'a game account needs a game, a platform and its typed attributes before publication' USING ERRCODE = 'PC003';
      END IF;
      IF (v_game IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.games WHERE id = v_game AND status = 'ACTIVE'))
         OR (NEW.platform_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.platforms WHERE id = NEW.platform_id AND status = 'ACTIVE')) THEN
        RAISE EXCEPTION 'cannot publish a variant of an archived game or platform' USING ERRCODE = 'PC001';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint

-- ===================================================================== product guard (replaces the 0013 function)
CREATE OR REPLACE FUNCTION catalog_product_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NEW.status = 'PUBLISHED' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'PUBLISHED') THEN
    IF NOT EXISTS (SELECT 1 FROM public.brands b WHERE b.id = NEW.brand_id AND b.status = 'ACTIVE')
       OR NOT EXISTS (SELECT 1 FROM public.categories c WHERE c.id = NEW.category_id AND c.status = 'ACTIVE') THEN
      RAISE EXCEPTION 'cannot publish a product with an archived brand or category' USING ERRCODE = 'PC001';
    END IF;
    IF NEW.type = 'GAME_ACCOUNT' AND NEW.game_id IS NULL THEN
      RAISE EXCEPTION 'a game-account product needs a game before publication' USING ERRCODE = 'PC003';
    END IF;
    IF NEW.game_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.games g WHERE g.id = NEW.game_id AND g.status = 'ACTIVE') THEN
      RAISE EXCEPTION 'cannot publish a product of an archived game' USING ERRCODE = 'PC001';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'PUBLISHED' AND NEW.status <> 'PUBLISHED'
     AND EXISTS (SELECT 1 FROM public.product_variants v WHERE v.product_id = NEW.id AND v.status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'product still has published variants' USING ERRCODE = 'PC001';
  END IF;
  -- B1: the game is chosen while DRAFT, must be active, and every variant platform must be offered for the (new) game.
  IF TG_OP = 'UPDATE' AND NEW.game_id IS DISTINCT FROM OLD.game_id THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'the game can only change while the product is DRAFT' USING ERRCODE = 'PC003';
    END IF;
  END IF;
  IF NEW.game_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.game_id IS DISTINCT FROM OLD.game_id) THEN
    IF NOT EXISTS (SELECT 1 FROM public.games g WHERE g.id = NEW.game_id AND g.status = 'ACTIVE') THEN
      RAISE EXCEPTION 'the game is archived' USING ERRCODE = 'PC005';
    END IF;
    IF TG_OP = 'UPDATE' AND EXISTS (
         SELECT 1 FROM public.product_variants v
          WHERE v.product_id = NEW.id AND v.platform_id IS NOT NULL
            AND (NOT EXISTS (SELECT 1 FROM public.game_platforms gp WHERE gp.game_id = NEW.game_id AND gp.platform_id = v.platform_id)
                 OR (v.region_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.game_platform_regions r WHERE r.game_id = NEW.game_id AND r.platform_id = v.platform_id AND r.region_id = v.region_id)))) THEN
      RAISE EXCEPTION 'a variant platform/region is not offered for this game' USING ERRCODE = 'PC005';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint

-- ===================================================================== B2: typed game-account attributes
CREATE FUNCTION catalog_game_account_attrs_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE v_type text; v_status text;
BEGIN
  SELECT p.type, v.status INTO v_type, v_status
    FROM public.product_variants v JOIN public.products p ON p.id = v.product_id WHERE v.id = NEW.variant_id;
  IF v_type IS DISTINCT FROM 'GAME_ACCOUNT' THEN
    RAISE EXCEPTION 'account attributes belong to GAME_ACCOUNT variants only' USING ERRCODE = 'PC003';
  END IF;
  IF v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'account attributes can only change while the variant is DRAFT' USING ERRCODE = 'PC003';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER game_account_attributes_guard BEFORE INSERT OR UPDATE ON game_account_attributes
  FOR EACH ROW EXECUTE FUNCTION catalog_game_account_attrs_guard();
--> statement-breakpoint
CREATE TRIGGER game_account_attributes_immutable BEFORE UPDATE ON game_account_attributes
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('variant_id', 'created_at');
--> statement-breakpoint
CREATE TRIGGER games_immutable BEFORE UPDATE ON games
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'slug', 'created_at');
--> statement-breakpoint
CREATE TRIGGER platforms_immutable BEFORE UPDATE ON platforms
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'slug', 'created_at');
--> statement-breakpoint
-- Relationship rows are facts that existing variants may rely on: they are never changed or removed.
CREATE TRIGGER game_platforms_no_mutation BEFORE UPDATE OR DELETE ON game_platforms
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER game_platform_regions_no_mutation BEFORE UPDATE OR DELETE ON game_platform_regions
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint

SELECT platform_register_grants('games', 'append_only', ARRAY['name', 'status', 'updated_at']);
--> statement-breakpoint
SELECT platform_register_grants('platforms', 'append_only', ARRAY['name', 'status', 'updated_at']);
--> statement-breakpoint
SELECT platform_register_grants('game_platforms', 'append_only');
--> statement-breakpoint
SELECT platform_register_grants('game_platform_regions', 'append_only');
--> statement-breakpoint
SELECT platform_register_grants('game_account_attributes', 'append_only', ARRAY['account_type', 'level', 'included_items', 'features', 'updated_at']);
--> statement-breakpoint
SELECT platform_register_grants('variant_fulfillment_changes', 'append_only');
--> statement-breakpoint
SELECT platform_register_grants('products', 'append_only', ARRAY['brand_id', 'category_id', 'game_id', 'name', 'description', 'status', 'updated_at']);
--> statement-breakpoint
SELECT platform_register_grants('product_variants', 'append_only',
  ARRAY['name', 'region_id', 'platform_id', 'face_value', 'face_currency', 'duration_days', 'fulfillment_method', 'price', 'sale_price', 'sale_starts_at', 'sale_ends_at', 'attrs', 'status', 'availability', 'updated_at']);
--> statement-breakpoint

INSERT INTO role_permissions (id, role_id, permission, granted_by, granted_at)
SELECT gen_random_uuid(), r.id, p.permission, NULL, now()
  FROM roles r
  CROSS JOIN (VALUES ('catalog.fulfillment.change')) AS p(permission)
 WHERE r.name = 'owner';
--> statement-breakpoint

-- ===================================================================== OPS-2: code expiry
-- The expiry is set at import and frozen with the code.
DROP TRIGGER digital_codes_immutable ON digital_codes;
--> statement-breakpoint
CREATE TRIGGER digital_codes_immutable BEFORE UPDATE ON digital_codes
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'variant_id', 'batch_id', 'code_fp', 'hmac_version', 'payload_kind', 'expires_at', 'created_at');
--> statement-breakpoint
INSERT INTO state_transition_rules (machine, from_status, to_status) VALUES
  ('inventory_code', 'AVAILABLE', 'EXPIRED'), ('inventory_code', 'QUARANTINED', 'EXPIRED');
--> statement-breakpoint

-- Replaces the 0015 guard. New rules, all against the supplier-provided expiry:
--   * a code is never imported already expired;
--   * it can be RESERVED only if it outlives the reservation (expires_at > reserved_until);
--   * it can be SOLD only if it had not expired when its reservation was consumed (the sale decision is the payment, not the later delivery job);
--   * it can be marked EXPIRED only once its expiry has passed (expires_at <= the transition time), from AVAILABLE/QUARANTINED only (state rules).
-- SOLD and RESERVED codes are never expired by this process: a sold code stays SOLD (its expiry is information for the customer).
CREATE OR REPLACE FUNCTION inventory_code_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE v_status text; v_consumed timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'SOLD' THEN
    IF NEW.status NOT IN ('SOLD', 'VOID')
       OR NEW.order_item_ref IS DISTINCT FROM OLD.order_item_ref OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
       OR NEW.sold_at IS DISTINCT FROM OLD.sold_at OR NEW.sealed IS DISTINCT FROM OLD.sealed THEN
      RAISE EXCEPTION 'a sold code is immutable' USING ERRCODE = 'PV002';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.expires_at IS NOT NULL AND NEW.expires_at <= NEW.created_at THEN
    RAISE EXCEPTION 'a code cannot be imported already expired' USING ERRCODE = 'PV003';
  END IF;
  IF NEW.status = 'RESERVED' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'RESERVED' OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id) THEN
    SELECT status INTO v_status FROM public.inventory_reservations WHERE id = NEW.reservation_id;
    IF v_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'a code can only be reserved under an ACTIVE reservation' USING ERRCODE = 'PV001';
    END IF;
    IF NEW.expires_at IS NOT NULL AND NEW.expires_at <= NEW.reserved_until THEN
      RAISE EXCEPTION 'a code that expires before the reservation ends cannot be reserved' USING ERRCODE = 'PV003';
    END IF;
  END IF;
  IF NEW.status = 'SOLD' AND TG_OP = 'UPDATE' THEN
    SELECT status, consumed_at INTO v_status, v_consumed FROM public.inventory_reservations WHERE id = NEW.reservation_id;
    IF v_status IS DISTINCT FROM 'CONSUMED' THEN
      RAISE EXCEPTION 'a code can only be sold under a CONSUMED reservation' USING ERRCODE = 'PV001';
    END IF;
    IF NEW.expires_at IS NOT NULL AND NEW.expires_at <= v_consumed THEN
      RAISE EXCEPTION 'a code that had expired when its reservation was consumed cannot be sold' USING ERRCODE = 'PV003';
    END IF;
  END IF;
  IF NEW.status = 'SOLD' AND TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'codes are never created as sold' USING ERRCODE = 'PV001';
  END IF;
  IF NEW.status = 'EXPIRED' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'EXPIRED') THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'codes are never created expired' USING ERRCODE = 'PV001';
    END IF;
    IF NEW.expires_at IS NULL OR NEW.expires_at > NEW.updated_at THEN
      RAISE EXCEPTION 'a code that has not expired cannot be marked expired' USING ERRCODE = 'PV003';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
