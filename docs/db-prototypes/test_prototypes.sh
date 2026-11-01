#!/usr/bin/env bash
# Validates the prototype SQL against a throwaway local PostgreSQL. Usage: ./test_prototypes.sh
set -euo pipefail
cd "$(dirname "$0")"
DB=giftcard_proto_$$
createdb "$DB"; trap 'dropdb "$DB"' EXIT
P="psql -v ON_ERROR_STOP=1 -q -X $DB"
$P -f 001_ledger.sql -f 002_inventory.sql
expect_fail() { if $P -c "$1" >/dev/null 2>&1; then echo "FAIL (should have errored): $2"; exit 1; else echo "ok: $2"; fi; }
$P <<'SQL'
INSERT INTO ledger_accounts (code,owner_type,owner_id,type,normal_side,min_balance) VALUES
 ('GATEWAY_CLEARING','GATEWAY','g1','ASSET','DEBIT',NULL),
 ('CUSTOMER_WALLET','USER','u1','LIABILITY','CREDIT',0),
 ('UNEARNED_REVENUE',NULL,NULL,'LIABILITY','CREDIT',NULL);
BEGIN;
WITH t AS (INSERT INTO ledger_transactions (kind,idempotency_key,reference_type,reference_id) VALUES ('WALLET_TOPUP','topup:p1','PAYMENT','p1') RETURNING id)
INSERT INTO ledger_entries (transaction_id,account_id,side,amount)
  SELECT id,1,'DEBIT'::entry_side,100000 FROM t UNION ALL SELECT id,2,'CREDIT'::entry_side,100000 FROM t;
COMMIT;
SQL
echo "ok: balanced top-up posted"
expect_fail "BEGIN; WITH t AS (INSERT INTO ledger_transactions (kind,idempotency_key,reference_type,reference_id) VALUES ('X','bad1','P','1') RETURNING id) INSERT INTO ledger_entries (transaction_id,account_id,side,amount) SELECT id,1,'DEBIT'::entry_side,5 FROM t; COMMIT;" "unbalanced transaction rejected at commit"
expect_fail "BEGIN; WITH t AS (INSERT INTO ledger_transactions (kind,idempotency_key,reference_type,reference_id) VALUES ('X','over','P','1') RETURNING id) INSERT INTO ledger_entries (transaction_id,account_id,side,amount) SELECT id,2,'DEBIT'::entry_side,100001 FROM t UNION ALL SELECT id,3,'CREDIT'::entry_side,100001 FROM t; COMMIT;" "wallet overdraft rejected by balance floor"
expect_fail "INSERT INTO ledger_transactions (kind,idempotency_key,reference_type,reference_id) VALUES ('WALLET_TOPUP','topup:p1','PAYMENT','p1')" "duplicate posting (idempotency key) rejected"
expect_fail "UPDATE ledger_entries SET amount = 1" "ledger entry UPDATE blocked"
expect_fail "DELETE FROM ledger_entries" "ledger entry DELETE blocked"
expect_fail "TRUNCATE ledger_entries" "ledger TRUNCATE blocked"
expect_fail "INSERT INTO ledger_entries (transaction_id,account_id,side,amount) VALUES (1,1,'DEBIT',1)" "late entry into committed transaction rejected"
test "$($P -tA -c 'SELECT balance FROM ledger_account_balances WHERE account_id=2')" = 100000 && echo "ok: projection = 100000"

# Concurrency: 1000 attempts against 10 codes, 50 parallel clients.
$P -c "INSERT INTO digital_codes (variant_id,code_hash,ciphertext,wrapped_dek,kek_version)
       SELECT 1, sha256(i::text::bytea), '\x00','\x00',1 FROM generate_series(1,10) i;"
seq 1 1000 | xargs -P 50 -I{} psql -X -q -tA "$DB" -c "BEGIN; SELECT count(*) FROM reserve_codes(1,1,{},'15 min'); COMMIT;" > /tmp/res_$$.txt
GOT=$(grep -c '^1$' /tmp/res_$$.txt || true); rm -f /tmp/res_$$.txt
RES=$($P -tA -c "SELECT count(*) FROM digital_codes WHERE status='RESERVED'")
DUP=$($P -tA -c "SELECT count(*) FROM (SELECT reservation_id FROM digital_codes WHERE reservation_id IS NOT NULL GROUP BY 1 HAVING count(*)>1) x")
echo "successful reservations=$GOT reserved rows=$RES reservations holding >1 code=$DUP"
test "$GOT" = 10 -a "$RES" = 10 -a "$DUP" = 0 && echo "ok: exactly 10 of 1000 attempts succeeded, no duplicates"
