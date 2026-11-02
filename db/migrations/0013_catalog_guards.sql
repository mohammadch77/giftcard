-- Catalog guards (Phase 2b-4). Forward-only; touches only tables created in 0012.
-- SQLSTATEs: PC001 publish/lifecycle rule, PC002 hierarchy rule, PC003 fulfilment/price rule, PC004 actor required.

ALTER TABLE categories ADD CONSTRAINT categories_parent_fk FOREIGN KEY (parent_id) REFERENCES categories(id);
--> statement-breakpoint

-- Tree integrity: no cycles, at most 4 levels.
CREATE FUNCTION catalog_category_tree_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE v_cur uuid := NEW.parent_id; v_depth int := 1;
BEGIN
  WHILE v_cur IS NOT NULL LOOP
    IF v_cur = NEW.id THEN
      RAISE EXCEPTION 'category cycle' USING ERRCODE = 'PC002';
    END IF;
    v_depth := v_depth + 1;
    IF v_depth > 4 THEN
      RAISE EXCEPTION 'category tree is limited to 4 levels' USING ERRCODE = 'PC002';
    END IF;
    SELECT parent_id INTO v_cur FROM public.categories WHERE id = v_cur;
  END LOOP;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER categories_tree_guard BEFORE INSERT OR UPDATE OF parent_id ON categories
  FOR EACH ROW EXECUTE FUNCTION catalog_category_tree_guard();
--> statement-breakpoint

-- Fulfilment compatibility by product type. PROPOSAL pending B1/B2: it is DATA, change it by migration after approval.
INSERT INTO product_type_fulfillment (product_type, method) VALUES
  ('GIFT_CARD', 'AUTO_CODE'), ('GIFT_CARD', 'MANUAL'), ('GIFT_CARD', 'SUPPLIER_API'),
  ('GAME_ACCOUNT', 'AUTO_CODE'), ('GAME_ACCOUNT', 'MANUAL'),
  ('GAME_SUBSCRIPTION', 'AUTO_CODE'), ('GAME_SUBSCRIPTION', 'MANUAL'), ('GAME_SUBSCRIPTION', 'SUPPLIER_API'),
  ('STREAMING_SUBSCRIPTION', 'AUTO_CODE'), ('STREAMING_SUBSCRIPTION', 'MANUAL'), ('STREAMING_SUBSCRIPTION', 'SUPPLIER_API'),
  ('DIGITAL_SERVICE', 'MANUAL'), ('DIGITAL_SERVICE', 'SUPPLIER_API'),
  ('OTHER', 'AUTO_CODE'), ('OTHER', 'MANUAL'), ('OTHER', 'SUPPLIER_API');
--> statement-breakpoint

-- State machines (history + required actor).
INSERT INTO state_transition_rules (machine, from_status, to_status) VALUES
  ('catalog_product', NULL, 'DRAFT'),
  ('catalog_product', 'DRAFT', 'PUBLISHED'), ('catalog_product', 'PUBLISHED', 'DRAFT'),
  ('catalog_product', 'DRAFT', 'ARCHIVED'), ('catalog_product', 'PUBLISHED', 'ARCHIVED'),
  ('catalog_variant', NULL, 'DRAFT'),
  ('catalog_variant', 'DRAFT', 'PUBLISHED'), ('catalog_variant', 'PUBLISHED', 'DRAFT'),
  ('catalog_variant', 'DRAFT', 'ARCHIVED'), ('catalog_variant', 'PUBLISHED', 'ARCHIVED');
--> statement-breakpoint
SELECT platform_attach_transition_guard('products', 'catalog_product', 'product_status_history', 'id', 'status', true);
--> statement-breakpoint
SELECT platform_attach_transition_guard('product_variants', 'catalog_variant', 'variant_status_history', 'id', 'status', true);
--> statement-breakpoint

CREATE TRIGGER products_immutable BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'type', 'slug', 'created_at');
--> statement-breakpoint
CREATE TRIGGER variants_immutable BEFORE UPDATE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'product_id', 'sku', 'created_at');
--> statement-breakpoint

-- A product may be PUBLISHED only with an active brand and category; it may leave PUBLISHED only
-- when no variant is still PUBLISHED (the service unpublishes variants first, in the same transaction).
CREATE FUNCTION catalog_product_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NEW.status = 'PUBLISHED' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'PUBLISHED') THEN
    IF NOT EXISTS (SELECT 1 FROM public.brands b WHERE b.id = NEW.brand_id AND b.status = 'ACTIVE')
       OR NOT EXISTS (SELECT 1 FROM public.categories c WHERE c.id = NEW.category_id AND c.status = 'ACTIVE') THEN
      RAISE EXCEPTION 'cannot publish a product with an archived brand or category' USING ERRCODE = 'PC001';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'PUBLISHED' AND NEW.status <> 'PUBLISHED'
     AND EXISTS (SELECT 1 FROM public.product_variants v WHERE v.product_id = NEW.id AND v.status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'product still has published variants' USING ERRCODE = 'PC001';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER products_guard BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION catalog_product_guard();
--> statement-breakpoint

-- Variant rules: fulfilment must suit the product type; the method is frozen once the variant leaves DRAFT;
-- PUBLISHED needs a PUBLISHED product and a price > 0 (no free items by accident).
CREATE FUNCTION catalog_variant_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE v_type text; v_pstatus text;
BEGIN
  SELECT type, status INTO v_type, v_pstatus FROM public.products WHERE id = NEW.product_id;
  IF TG_OP = 'INSERT' OR NEW.fulfillment_method IS DISTINCT FROM OLD.fulfillment_method THEN
    IF TG_OP = 'UPDATE' AND OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'fulfilment method can only change while the variant is DRAFT' USING ERRCODE = 'PC003';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.product_type_fulfillment WHERE product_type = v_type AND method = NEW.fulfillment_method) THEN
      RAISE EXCEPTION 'fulfilment method % is not allowed for product type %', NEW.fulfillment_method, v_type USING ERRCODE = 'PC003';
    END IF;
  END IF;
  IF NEW.status = 'PUBLISHED' THEN
    IF v_pstatus <> 'PUBLISHED' THEN
      RAISE EXCEPTION 'a variant can only be published under a published product' USING ERRCODE = 'PC001';
    END IF;
    IF NEW.price <= 0 THEN
      RAISE EXCEPTION 'a published variant needs a price above zero' USING ERRCODE = 'PC003';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER variants_guard BEFORE INSERT OR UPDATE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION catalog_variant_guard();
--> statement-breakpoint

-- Price history is written ONLY by this trigger (SECURITY DEFINER; the application role has no INSERT on it).
CREATE FUNCTION catalog_price_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE v_actor text := NULLIF(current_setting('app.actor_id', true), '');
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.price IS NOT DISTINCT FROM OLD.price AND NEW.sale_price IS NOT DISTINCT FROM OLD.sale_price
     AND NEW.sale_starts_at IS NOT DISTINCT FROM OLD.sale_starts_at AND NEW.sale_ends_at IS NOT DISTINCT FROM OLD.sale_ends_at THEN
    RETURN NULL;
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'a price change requires app.actor_id' USING ERRCODE = 'PC004';
  END IF;
  INSERT INTO public.variant_price_history (variant_id, price, sale_price, sale_starts_at, sale_ends_at, changed_by, reason, changed_at)
  VALUES (NEW.id, NEW.price, NEW.sale_price, NEW.sale_starts_at, NEW.sale_ends_at, v_actor, NULLIF(current_setting('app.reason', true), ''), NEW.updated_at);
  RETURN NULL;
END
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION catalog_price_history() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER variants_price_history AFTER INSERT OR UPDATE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION catalog_price_history();
--> statement-breakpoint

CREATE TRIGGER variant_price_history_no_mutation BEFORE UPDATE OR DELETE ON variant_price_history
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER variant_price_history_no_truncate BEFORE TRUNCATE ON variant_price_history
  FOR EACH STATEMENT EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint

SELECT platform_register_grants('categories', 'append_only', ARRAY['parent_id', 'name', 'sort_order', 'status', 'updated_at']);
--> statement-breakpoint
SELECT platform_register_grants('brands', 'append_only', ARRAY['name', 'status', 'updated_at']);
--> statement-breakpoint
SELECT platform_register_grants('regions', 'append_only');
--> statement-breakpoint
SELECT platform_register_grants('product_type_fulfillment', 'read_only');
--> statement-breakpoint
SELECT platform_register_grants('products', 'append_only', ARRAY['brand_id', 'category_id', 'name', 'description', 'status', 'updated_at']);
--> statement-breakpoint
SELECT platform_register_grants('product_variants', 'append_only',
  ARRAY['name', 'region_id', 'face_value', 'face_currency', 'duration_days', 'fulfillment_method', 'price', 'sale_price', 'sale_starts_at', 'sale_ends_at', 'attrs', 'status', 'availability', 'updated_at']);
--> statement-breakpoint
SELECT platform_register_grants('variant_price_history', 'read_only');
--> statement-breakpoint
SELECT platform_register_grants('product_status_history', 'append_only');
--> statement-breakpoint
SELECT platform_register_grants('variant_status_history', 'append_only');
--> statement-breakpoint

-- The owner role receives the catalog permissions explicitly (role DATA seeded like 0011; no wildcard, no other role).
-- Permission keys are owned by the catalog module (src/modules/catalog/domain/permissions.ts); a test pins both together.
INSERT INTO role_permissions (id, role_id, permission, granted_by, granted_at)
SELECT gen_random_uuid(), r.id, p.permission, NULL, now()
  FROM roles r
  CROSS JOIN (VALUES ('catalog.products.read'), ('catalog.products.manage'), ('catalog.products.publish'), ('catalog.prices.manage')) AS p(permission)
 WHERE r.name = 'owner';
