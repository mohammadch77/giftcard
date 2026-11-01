-- PROTOTYPE (design validation only). Requires 001 + 002.
-- Covers: reservation lifecycle, "no delivery without a valid reservation" guard,
-- idempotent payment settlement, counted stock floor, supplier-order idempotency.

CREATE TABLE inventory_reservations (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   bigint NOT NULL,
  status     text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CONSUMED','RELEASED','EXPIRED')),
  expires_at timestamptz NOT NULL
);
ALTER TABLE digital_codes ADD FOREIGN KEY (reservation_id) REFERENCES inventory_reservations(id);

-- Guard: a code may become SOLD only while its reservation is CONSUMED (i.e. payment verified
-- while the reservation was still ACTIVE and unexpired). Stops delivery after release/expiry
-- even if application code is wrong.
CREATE FUNCTION trg_sold_requires_reservation() RETURNS trigger AS $$
BEGIN
  -- A SOLD code is immutable except for an explicit SOLD -> VOID (audited admin action).
  IF OLD.status = 'SOLD' AND NOT (NEW.status = 'VOID' AND NEW.order_item_id IS NOT DISTINCT FROM OLD.order_item_id
                                  AND NEW.code_hash = OLD.code_hash AND NEW.ciphertext = OLD.ciphertext) THEN
    RAISE EXCEPTION 'code % is SOLD and immutable', OLD.id;
  END IF;
  IF NEW.status = 'SOLD' AND OLD.status IS DISTINCT FROM 'SOLD' THEN
    IF OLD.status <> 'RESERVED' OR NOT EXISTS (
         SELECT 1 FROM inventory_reservations r
          WHERE r.id = OLD.reservation_id AND r.status = 'CONSUMED') THEN
      RAISE EXCEPTION 'code % cannot be sold without a consumed reservation', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER sold_requires_reservation BEFORE UPDATE ON digital_codes
  FOR EACH ROW EXECUTE FUNCTION trg_sold_requires_reservation();

-- Consume at payment verification. 'LATE' => caller must route the order to review.
CREATE FUNCTION consume_reservation(p_res bigint) RETURNS text AS $$
DECLARE n int;
BEGIN
  UPDATE inventory_reservations SET status = 'CONSUMED'
   WHERE id = p_res AND status = 'ACTIVE' AND expires_at > now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN CASE WHEN n = 1 THEN 'CONSUMED' ELSE 'LATE' END;
END $$ LANGUAGE plpgsql;

-- Sweeper: expire + release codes.
CREATE FUNCTION expire_reservations() RETURNS int AS $$
DECLARE n int;
BEGIN
  WITH ex AS (
    UPDATE inventory_reservations SET status = 'EXPIRED'
     WHERE status = 'ACTIVE' AND expires_at <= now() RETURNING id)
  UPDATE digital_codes c SET status = 'AVAILABLE', reservation_id = NULL, reserved_until = NULL
    FROM ex WHERE c.reservation_id = ex.id AND c.status = 'RESERVED';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$ LANGUAGE plpgsql;

-- Reserve variant: reservation row + codes, all-or-nothing (raises if short).
CREATE FUNCTION reserve_for_order(p_order bigint, p_variant bigint, p_qty int, p_ttl interval)
RETURNS bigint AS $$
DECLARE rid bigint; got int;
BEGIN
  INSERT INTO inventory_reservations (order_id, expires_at) VALUES (p_order, now() + p_ttl) RETURNING id INTO rid;
  SELECT count(*) INTO got FROM reserve_codes(p_variant, p_qty, rid, p_ttl);
  IF got < p_qty THEN RAISE EXCEPTION 'INSUFFICIENT_STOCK'; END IF;
  RETURN rid;
END $$ LANGUAGE plpgsql;

-- Payments: only one concurrent handler can win the conditional transition.
CREATE TABLE payments (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purpose   text NOT NULL CHECK (purpose IN ('ORDER','WALLET_TOPUP')),
  amount    bigint NOT NULL CHECK (amount > 0),
  status    text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VERIFYING','SUCCEEDED','FAILED','NEEDS_REVIEW'))
);

-- Wallet top-up settlement: gateway account -> user's wallet account.
CREATE FUNCTION settle_topup(p_payment bigint, p_gateway_acct bigint, p_wallet_acct bigint)
RETURNS text AS $$
DECLARE n int; amt bigint;
BEGIN
  UPDATE payments SET status = 'SUCCEEDED'
   WHERE id = p_payment AND status IN ('PENDING','VERIFYING') RETURNING amount INTO amt;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RETURN 'ALREADY_PROCESSED'; END IF;
  PERFORM ledger_post2('WALLET_TOPUP', 'topup:' || p_payment, 'PAYMENT', p_payment::text,
                       p_gateway_acct, p_wallet_acct, amt);
  RETURN 'SETTLED';
END $$ LANGUAGE plpgsql;

-- Counted stock (manual / supplier-backed): floor enforced by CHECK + conditional update.
CREATE TABLE stock_counters (
  variant_id bigint PRIMARY KEY,
  available  int NOT NULL CHECK (available >= 0),
  reserved   int NOT NULL CHECK (reserved >= 0)
);

-- Supplier order idempotency.
CREATE TABLE supplier_orders (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  supplier_id     bigint NOT NULL,
  idempotency_key text NOT NULL,
  status          text NOT NULL DEFAULT 'CREATED',
  UNIQUE (supplier_id, idempotency_key)
);
