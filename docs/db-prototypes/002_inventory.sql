-- PROTOTYPE (design validation only). Atomic code reservation with SKIP LOCKED.
CREATE TYPE code_status AS ENUM ('AVAILABLE','RESERVED','SOLD','VOID','QUARANTINED');

CREATE TABLE digital_codes (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  variant_id    bigint NOT NULL,
  code_hash     bytea  NOT NULL UNIQUE,        -- HMAC-SHA256(pepper, normalized code)
  ciphertext    bytea  NOT NULL,               -- AES-256-GCM(DEK, code)
  wrapped_dek   bytea  NOT NULL,               -- DEK wrapped by KEK (kek_version)
  kek_version   int    NOT NULL,
  status        code_status NOT NULL DEFAULT 'AVAILABLE',
  reservation_id bigint,
  order_item_id  bigint UNIQUE,                -- a code can belong to at most one order item
  reserved_until timestamptz,
  sold_at       timestamptz,
  CONSTRAINT status_links CHECK (
    (status = 'AVAILABLE' AND reservation_id IS NULL AND order_item_id IS NULL) OR
    (status = 'RESERVED'  AND reservation_id IS NOT NULL AND order_item_id IS NULL) OR
    (status = 'SOLD'      AND order_item_id IS NOT NULL) OR
    (status IN ('VOID','QUARANTINED')))
);
CREATE INDEX digital_codes_available ON digital_codes (variant_id, id) WHERE status = 'AVAILABLE';
CREATE INDEX digital_codes_reservation ON digital_codes (reservation_id) WHERE status = 'RESERVED';

-- Reserve :qty codes for :reservation atomically. Caller MUST verify returned count = :qty
-- and roll back otherwise (all-or-nothing).
CREATE FUNCTION reserve_codes(p_variant bigint, p_qty int, p_reservation bigint, p_ttl interval)
RETURNS SETOF bigint AS $$
  UPDATE digital_codes c
     SET status = 'RESERVED', reservation_id = p_reservation, reserved_until = now() + p_ttl
   WHERE c.id IN (SELECT id FROM digital_codes
                   WHERE variant_id = p_variant AND status = 'AVAILABLE'
                   ORDER BY id LIMIT p_qty
                   FOR UPDATE SKIP LOCKED)
  RETURNING c.id;
$$ LANGUAGE sql;
