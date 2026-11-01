#!/usr/bin/env bash
# Validates the prototype SQL against a throwaway local PostgreSQL 16+.
# Usage: ./test_prototypes.sh      (needs createdb/dropdb/psql access; no app code involved)
set -uo pipefail
cd "$(dirname "$0")"
DB=giftcard_proto_$$
createdb "$DB" || exit 2
trap 'dropdb --if-exists "$DB"' EXIT
PASS=0; FAILN=0
P() { psql -v ON_ERROR_STOP=1 -q -X -tA "$DB" "$@"; }
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAILN=$((FAILN+1)); }
expect_fail() { if P -c "$1" >/dev/null 2>&1; then bad "$2 (should have errored)"; else ok "$2"; fi; }
expect_eq()   { if [ "$1" = "$2" ]; then ok "$3 (=$1)"; else bad "$3 (expected $2, got $1)"; fi; }
# run a command N times with P-way parallelism; echo number of successful (exit 0) runs
par_ok() { # N P sql-with-{}-placeholder
  seq 1 "$1" | xargs -P "$2" -I{} sh -c "psql -X -q -tA $DB -c \"$3\" >/dev/null 2>&1 && echo ok" | grep -c '^ok$' || true
}

par_out() { # N P sql : print each run's stdout
  seq 1 "$1" | xargs -P "$2" -I{} sh -c "psql -X -q -tA $DB -c \"$3\" 2>/dev/null"
}

P -f 001_ledger.sql -f 002_inventory.sql -f 003_orders_payments.sql || { echo "schema load failed"; exit 2; }
echo "schema loaded"

echo "== LEDGER =="
P -c "INSERT INTO ledger_accounts (code,owner_type,owner_id,type,normal_side,min_balance) VALUES
 ('GATEWAY_CLEARING','GATEWAY','g1','ASSET','DEBIT'::entry_side,NULL),
 ('CUSTOMER_WALLET','USER','u1','LIABILITY','CREDIT'::entry_side,0),
 ('UNEARNED_REVENUE',NULL,NULL,'LIABILITY','CREDIT'::entry_side,NULL)" >/dev/null
# explicit casts on every enum-typed expression (fixes the earlier untyped-literal UNION error)
P -c "BEGIN;
 WITH t AS (INSERT INTO ledger_transactions (kind,idempotency_key,reference_type,reference_id)
            VALUES ('WALLET_TOPUP','topup:manual1','PAYMENT','m1') RETURNING id)
 INSERT INTO ledger_entries (transaction_id,account_id,side,amount)
   SELECT id,1,'DEBIT'::entry_side,1000000::bigint FROM t
   UNION ALL SELECT id,2,'CREDIT'::entry_side,1000000::bigint FROM t;
 COMMIT;" >/dev/null && ok "balanced multi-row posting accepted" || bad "balanced posting"
expect_fail "BEGIN; WITH t AS (INSERT INTO ledger_transactions (kind,idempotency_key,reference_type,reference_id) VALUES ('X','bad1','P','1') RETURNING id) INSERT INTO ledger_entries (transaction_id,account_id,side,amount) SELECT id,1,'DEBIT'::entry_side,5::bigint FROM t; COMMIT;" "unbalanced transaction rejected at COMMIT"
expect_fail "SELECT ledger_post2('ORDER_PAYMENT','overdraft1','ORDER','o1',2,3,1000001)" "wallet overdraft rejected by balance floor"
expect_fail "SELECT ledger_post2('WALLET_TOPUP','topup:manual1','PAYMENT','m1',1,2,1)" "duplicate posting (same idempotency key) rejected"
expect_fail "UPDATE ledger_entries SET amount = 1" "ledger_entries UPDATE blocked"
expect_fail "DELETE FROM ledger_entries" "ledger_entries DELETE blocked"
expect_fail "TRUNCATE ledger_entries" "ledger_entries TRUNCATE blocked"
expect_fail "UPDATE ledger_transactions SET kind='x'" "ledger_transactions UPDATE blocked"
expect_fail "INSERT INTO ledger_entries (transaction_id,account_id,side,amount) VALUES (1,1,'DEBIT'::entry_side,1)" "late entry into a committed transaction rejected"
expect_fail "INSERT INTO ledger_entries (transaction_id,account_id,side,amount) SELECT id,1,'DEBIT'::entry_side,0 FROM ledger_transactions LIMIT 1" "zero/negative amount rejected"
expect_eq "$(P -c 'SELECT balance FROM ledger_account_balances WHERE account_id=2')" 1000000 "wallet projection after top-up"
expect_eq "$(P -c "SELECT COALESCE(SUM(CASE side WHEN 'CREDIT' THEN amount ELSE -amount END),0) FROM ledger_entries WHERE account_id=2")" 1000000 "projection equals recomputation from entries"

echo "== IDEMPOTENCY =="
P -c "INSERT INTO payments (purpose,amount) VALUES ('WALLET_TOPUP',500000)" >/dev/null
GOT=$(par_out 100 25 "SELECT settle_topup(1,1,2)" | grep -c '^SETTLED$' || true)
expect_eq "$GOT" 1 "100 parallel duplicate callbacks -> exactly 1 settlement"
expect_eq "$(P -c "SELECT count(*) FROM ledger_transactions WHERE idempotency_key='topup:1'")" 1 "exactly 1 ledger transaction for the payment"
expect_eq "$(P -c 'SELECT balance FROM ledger_account_balances WHERE account_id=2')" 1500000 "wallet credited once (1,000,000 + 500,000)"
expect_eq "$(P -c "SELECT settle_topup(1,1,2)")" ALREADY_PROCESSED "sequential replay returns ALREADY_PROCESSED"
GOT=$(par_ok 50 25 "INSERT INTO supplier_orders (supplier_id,idempotency_key) VALUES (1,'so-1')")
expect_eq "$GOT" 1 "50 parallel supplier submissions with same key -> 1 supplier order"
expect_eq "$(P -c 'SELECT count(*) FROM supplier_orders')" 1 "supplier_orders rows"

echo "== WALLET CONCURRENCY (S2) =="
# wallet has 1,500,000; 500 parallel debits of 10,000 => exactly 150 can succeed
GOT=$(par_ok 500 50 "SELECT ledger_post2('ORDER_PAYMENT','wdebit:{}','ORDER','{}',2,3,10000)")
expect_eq "$GOT" 150 "500 parallel debits -> exactly floor(balance/amount) succeed"
expect_eq "$(P -c 'SELECT balance FROM ledger_account_balances WHERE account_id=2')" 0 "wallet drained to exactly 0, never negative"
expect_eq "$(P -c "SELECT count(*) FROM ledger_account_balances WHERE min_balance IS NOT NULL AND balance < min_balance")" 0 "no account below its floor"

echo "== INVENTORY: 1,000 attempts vs 10 codes (S1 core) =="
P -c "INSERT INTO digital_codes (variant_id,code_hash,ciphertext,wrapped_dek,kek_version)
      SELECT 1, sha256(i::text::bytea), '\x00','\x00',1 FROM generate_series(1,10) i" >/dev/null
GOT=$(par_ok 1000 50 "SELECT reserve_for_order({},1,1,'15 min')")
expect_eq "$GOT" 10 "successful reservations out of 1000 attempts"
expect_eq "$(P -c "SELECT count(*) FROM digital_codes WHERE status='RESERVED'")" 10 "codes in RESERVED"
expect_eq "$(P -c "SELECT count(*) FROM (SELECT reservation_id FROM digital_codes WHERE reservation_id IS NOT NULL GROUP BY 1 HAVING count(*)<>1) x")" 0 "every reservation holds exactly one code (no code shared)"
expect_eq "$(P -c "SELECT count(*) FROM digital_codes WHERE status='AVAILABLE'")" 0 "available stock exhausted, never negative"
expect_eq "$(P -c "SELECT count(*) FROM inventory_reservations WHERE status='ACTIVE'")" 10 "failed attempts left no orphan reservations (rolled back)"
expect_fail "INSERT INTO digital_codes (variant_id,code_hash,ciphertext,wrapped_dek,kek_version) VALUES (2, sha256('1'::bytea), '\x00','\x00',1)" "duplicate code hash rejected (global UNIQUE)"
expect_fail "UPDATE digital_codes SET status='SOLD', order_item_id=1 WHERE id=1" "RESERVED code cannot become SOLD without a CONSUMED reservation"
expect_fail "UPDATE digital_codes SET status='AVAILABLE' WHERE id=1" "inconsistent status/link combination rejected by CHECK"

echo "== LATE PAYMENT / EXPIRED RESERVATION =="
P -c "INSERT INTO digital_codes (variant_id,code_hash,ciphertext,wrapped_dek,kek_version) VALUES (9, sha256('late'::bytea), '\x00','\x00',1)" >/dev/null
RID=$(P -c "SELECT reserve_for_order(9001,9,1,'1 second')")
sleep 2
expect_eq "$(P -c "SELECT consume_reservation($RID)")" LATE "payment verified after TTL -> LATE (not consumed)"
expect_eq "$(P -c "SELECT expire_reservations()")" 1 "sweeper releases the expired code"
CODE=$(P -c "SELECT id FROM digital_codes WHERE variant_id=9")
RID2=$(P -c "SELECT reserve_for_order(9002,9,1,'15 min')")
expect_eq "$(P -c "SELECT reservation_id FROM digital_codes WHERE id=$CODE")" "$RID2" "released code re-reserved by a different order"
expect_fail "UPDATE digital_codes SET status='SOLD', order_item_id=9001 WHERE id=$CODE" "late order cannot take the code now held by another order's reservation"
expect_eq "$(P -c "SELECT consume_reservation($RID)")" LATE "late reservation stays unconsumable"
P -c "SELECT consume_reservation($RID2)" >/dev/null
P -c "UPDATE digital_codes SET status='SOLD', order_item_id=9002 WHERE id=$CODE" >/dev/null && ok "on-time order: consume then SOLD succeeds" || bad "on-time delivery"
expect_fail "UPDATE digital_codes SET order_item_id=1 WHERE id=$CODE" "SOLD code cannot be reassigned to another order item"

echo "== COUNTED STOCK =="
P -c "INSERT INTO stock_counters VALUES (5, 10, 0)" >/dev/null
GOT=$(par_out 1000 50 "UPDATE stock_counters SET available=available-1, reserved=reserved+1 WHERE variant_id=5 AND available>=1 RETURNING 1" | grep -c '^1$' || true)
expect_eq "$GOT" 10 "counted stock: successful reservations out of 1000 attempts"
expect_eq "$(P -c 'SELECT reserved FROM stock_counters WHERE variant_id=5')" 10 "counted stock: 1000 attempts reserve exactly 10"
expect_eq "$(P -c 'SELECT available FROM stock_counters WHERE variant_id=5')" 0 "counted stock: available never negative"
expect_fail "UPDATE stock_counters SET available = -1 WHERE variant_id=5" "negative stock rejected by CHECK"

echo
echo "RESULT: $PASS passed, $FAILN failed"
[ "$FAILN" = 0 ]
