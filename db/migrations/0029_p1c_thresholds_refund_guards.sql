-- P1-C guards: B10 financial approval thresholds, B12 refund review workflows, B13 refund execution safety, B2-LEGAL game account legal guard.
-- Forward-only. SQLSTATEs: PO003 settings guard, PO002 refund guard, PC003 catalog rule, PC004 actor required.

-- ===================================================================== B10: wallet adjustment threshold versions
CREATE TRIGGER wallet_adjustment_threshold_versions_no_delete BEFORE DELETE ON wallet_adjustment_threshold_versions
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER wallet_adjustment_threshold_versions_no_truncate BEFORE TRUNCATE ON wallet_adjustment_threshold_versions
  FOR EACH STATEMENT EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER wallet_adjustment_threshold_versions_immutable BEFORE UPDATE ON wallet_adjustment_threshold_versions
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'requires_tier2_above_rial', 'auto_approval_allowed', 'source', 'base_seq', 'requested_by', 'reason', 'created_at');
--> statement-breakpoint

CREATE FUNCTION wallet_adjustment_threshold_decision_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE v_max integer;
BEGIN
  IF OLD.status <> 'REQUESTED' THEN
    RAISE EXCEPTION 'a decided wallet adjustment threshold version can never change' USING ERRCODE = 'PO003';
  END IF;
  IF NEW.status = 'APPROVED' THEN
    SELECT max(approved_seq) INTO v_max FROM public.wallet_adjustment_threshold_versions;
    IF NEW.approved_seq IS DISTINCT FROM coalesce(v_max, 0) + 1 OR NEW.base_seq IS DISTINCT FROM v_max THEN
      RAISE EXCEPTION 'stale wallet adjustment threshold request: the active version changed since it was requested' USING ERRCODE = 'PO003';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER wallet_adjustment_threshold_versions_decision BEFORE UPDATE ON wallet_adjustment_threshold_versions
  FOR EACH ROW EXECUTE FUNCTION wallet_adjustment_threshold_decision_guard();
--> statement-breakpoint

-- Version 1 seed (B10, fail-closed: threshold = 0 rial, Tier 2 required for all adjustments, two-person floor mandatory).
INSERT INTO wallet_adjustment_threshold_versions (id, requires_tier2_above_rial, auto_approval_allowed, source, status, base_seq, approved_seq, requested_by, reason, decided_by, decision_reason, created_at, decided_at)
VALUES (gen_random_uuid(), 0, false, 'SEED', 'APPROVED', NULL, 1, 'decision:B10:2026-11-22',
        'Initial wallet adjustment threshold approved by owner (DECISIONS seventeenth review, B10)', 'owner-approval:seventeenth-review',
        'approved by the project owner; applied by migration 0029', now(), now());
--> statement-breakpoint

-- ===================================================================== B10 / B12: refund threshold versions
CREATE TRIGGER refund_threshold_versions_no_delete BEFORE DELETE ON refund_threshold_versions
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER refund_threshold_versions_no_truncate BEFORE TRUNCATE ON refund_threshold_versions
  FOR EACH STATEMENT EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER refund_threshold_versions_immutable BEFORE UPDATE ON refund_threshold_versions
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'requires_tier2_above_rial', 'auto_approval_allowed', 'source', 'base_seq', 'requested_by', 'reason', 'created_at');
--> statement-breakpoint

CREATE FUNCTION refund_threshold_decision_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE v_max integer;
BEGIN
  IF OLD.status <> 'REQUESTED' THEN
    RAISE EXCEPTION 'a decided refund threshold version can never change' USING ERRCODE = 'PO003';
  END IF;
  IF NEW.status = 'APPROVED' THEN
    SELECT max(approved_seq) INTO v_max FROM public.refund_threshold_versions;
    IF NEW.approved_seq IS DISTINCT FROM coalesce(v_max, 0) + 1 OR NEW.base_seq IS DISTINCT FROM v_max THEN
      RAISE EXCEPTION 'stale refund threshold request: the active version changed since it was requested' USING ERRCODE = 'PO003';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER refund_threshold_versions_decision BEFORE UPDATE ON refund_threshold_versions
  FOR EACH ROW EXECUTE FUNCTION refund_threshold_decision_guard();
--> statement-breakpoint

-- Version 1 seed (B10, fail-closed: threshold = 0 rial, Tier 2 required for all refunds, two-person floor mandatory).
INSERT INTO refund_threshold_versions (id, requires_tier2_above_rial, auto_approval_allowed, source, status, base_seq, approved_seq, requested_by, reason, decided_by, decision_reason, created_at, decided_at)
VALUES (gen_random_uuid(), 0, false, 'SEED', 'APPROVED', NULL, 1, 'decision:B10:2026-11-22',
        'Initial refund approval threshold approved by owner (DECISIONS seventeenth review, B10)', 'owner-approval:seventeenth-review',
        'approved by the project owner; applied by migration 0029', now(), now());
--> statement-breakpoint

-- ===================================================================== B2-LEGAL: catalog legal reviews guards
CREATE TRIGGER catalog_legal_reviews_no_delete BEFORE DELETE ON catalog_legal_reviews
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER catalog_legal_reviews_no_truncate BEFORE TRUNCATE ON catalog_legal_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER catalog_legal_reviews_immutable BEFORE UPDATE ON catalog_legal_reviews
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'scope', 'reference', 'created_at');
--> statement-breakpoint

-- ===================================================================== update immutability triggers on wallet_adjustments & refunds
DROP TRIGGER wallet_adjustments_immutable ON wallet_adjustments;
--> statement-breakpoint
CREATE TRIGGER wallet_adjustments_immutable BEFORE UPDATE ON wallet_adjustments
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'user_ref', 'direction', 'amount', 'reason', 'requested_by', 'threshold_version', 'tier', 'created_at');
--> statement-breakpoint

DROP TRIGGER refunds_immutable ON refunds;
--> statement-breakpoint
CREATE TRIGGER refunds_immutable BEFORE UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'order_id', 'hold_id', 'source', 'suspense_key', 'payment_id', 'requested_by', 'requester_type', 'reason_code', 'amount', 'destination', 'threshold_version', 'tier', 'policy_version', 'eligibility_snapshot', 'evidence_references', 'review_reason', 'decision', 'request_hash', 'created_at');
--> statement-breakpoint

-- ===================================================================== B2-LEGAL server-side guard on product & variant publication
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
      IF v_type = 'GAME_ACCOUNT' THEN
        IF (v_game IS NULL OR NEW.platform_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.game_account_attributes WHERE variant_id = NEW.id)) THEN
          RAISE EXCEPTION 'a game account needs a game, a platform and its typed attributes before publication' USING ERRCODE = 'PC003';
        END IF;
        -- B2-LEGAL: Game-account products must not become publicly publishable until legal review has been explicitly recorded
        IF NOT EXISTS (SELECT 1 FROM public.catalog_legal_reviews WHERE scope = 'GAME_ACCOUNT' AND status = 'APPROVED') THEN
          RAISE EXCEPTION 'game account products are blocked pending recorded legal review (B2-LEGAL)' USING ERRCODE = 'PC003';
        END IF;
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
    IF NEW.type = 'GAME_ACCOUNT' THEN
      IF NEW.game_id IS NULL THEN
        RAISE EXCEPTION 'a game-account product needs a game before publication' USING ERRCODE = 'PC003';
      END IF;
      -- B2-LEGAL: Game-account products must not become publicly publishable until legal review has been explicitly recorded
      IF NOT EXISTS (SELECT 1 FROM public.catalog_legal_reviews WHERE scope = 'GAME_ACCOUNT' AND status = 'APPROVED') THEN
        RAISE EXCEPTION 'game account products are blocked pending recorded legal review (B2-LEGAL)' USING ERRCODE = 'PC003';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint

-- ===================================================================== platform register grants
SELECT platform_register_grants('wallet_adjustment_threshold_versions', 'append_only', ARRAY['status', 'approved_seq', 'decided_by', 'decision_reason', 'decided_at']);
--> statement-breakpoint
SELECT platform_register_grants('refund_threshold_versions', 'append_only', ARRAY['status', 'approved_seq', 'decided_by', 'decision_reason', 'decided_at']);
--> statement-breakpoint
SELECT platform_register_grants('catalog_legal_reviews', 'append_only', ARRAY['status', 'reviewed_by', 'decided_at', 'notes']);
--> statement-breakpoint

-- ===================================================================== role permissions
-- Owner receives the threshold permissions. orders.refunds.override_revealed is granted to NO role by default.
INSERT INTO role_permissions (id, role_id, permission, granted_by, granted_at)
SELECT gen_random_uuid(), r.id, p.permission, NULL, now()
  FROM roles r
  CROSS JOIN (VALUES
    ('wallet.adjust.approve_tier2'),
    ('wallet.settings.thresholds.read'),
    ('wallet.settings.thresholds.request'),
    ('wallet.settings.thresholds.approve'),
    ('orders.refunds.approve_tier2'),
    ('orders.settings.thresholds.read'),
    ('orders.settings.thresholds.request'),
    ('orders.settings.thresholds.approve')
  ) AS p(permission)
 WHERE r.name = 'owner';
