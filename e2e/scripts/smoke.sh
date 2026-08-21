#!/usr/bin/env bash
# Smoke test for the synchronous path (jalur A-D): BFF -> Payment Gateway -> Ledger
# Service -> Postgres. Assumes `docker compose up -d` and all three app components
# are already running (see e2e/PLAN.md Tahap 0 — no start-all orchestration yet).
set -euo pipefail

BFF_URL="${BFF_URL:-http://localhost:8082}"
PAYMENT_GATEWAY_URL="${PAYMENT_GATEWAY_URL:-http://localhost:8081}"
LEDGER_SERVICE_URL="${LEDGER_SERVICE_URL:-http://localhost:8080}"

pass=0
fail=0

check() {
  local description="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "ok   - $description"
    pass=$((pass + 1))
  else
    echo "FAIL - $description (expected $expected, got $actual)"
    fail=$((fail + 1))
  fi
}

echo "== health checks =="
status=$(curl -s -o /dev/null -w "%{http_code}" "$LEDGER_SERVICE_URL/healthz")
check "ledger-service /healthz" 200 "$status"

status=$(curl -s -o /dev/null -w "%{http_code}" "$PAYMENT_GATEWAY_URL/healthz")
check "payment-gateway /healthz" 200 "$status"

status=$(curl -s -o /dev/null -w "%{http_code}" "$BFF_URL/healthz")
check "bff /healthz (cascades to payment-gateway)" 200 "$status"

echo "== seed payer balance =="
# ledger-service enforces balanced (sum-to-zero) double-entry transactions and
# rejects any debit that would take an account negative — there is no
# genesis/top-up account yet (see e2e/PLAN.md open questions). A fresh payer
# account therefore has 0 balance and would always fail the first debit.
# We seed it by writing directly to Postgres, bypassing the app-layer balance
# invariant on purpose: this is fixture setup, not a jalur A-D request.
run_id="smoke-$(date +%s)-$$"
payer_account="acct-smoke-payer-$run_id"
payee_account="acct-smoke-payee-$run_id"
seed_key="seed-$run_id"

docker exec -i ledger-rail-postgres-1 psql -U ledger -d ledger -v ON_ERROR_STOP=1 >/dev/null <<SQL
INSERT INTO ledger_transactions (idempotency_key) VALUES ('$seed_key');
INSERT INTO ledger_entries (idempotency_key, account_id, amount_cents)
  VALUES ('$seed_key', '$payer_account', 100000);
SQL
echo "ok   - seed payer balance in postgres"
pass=$((pass + 1))

echo "== jalur A-D: submit payment through BFF =="
idempotency_key="$run_id"
payload=$(cat <<JSON
{"payer_account":"$payer_account","payee_account":"$payee_account","amount_cents":100,"idempotency_key":"$idempotency_key"}
JSON
)

response=$(curl -s -w "\n%{http_code}" -X POST "$BFF_URL/api/payments" \
  -H "content-type: application/json" \
  -d "$payload")
status="${response##*$'\n'}"
body="${response%$'\n'*}"

check "POST /api/payments (first submit)" 201 "$status"
echo "     body: $body"

echo "== idempotency retry: same key must not double-apply =="
response=$(curl -s -w "\n%{http_code}" -X POST "$BFF_URL/api/payments" \
  -H "content-type: application/json" \
  -d "$payload")
status="${response##*$'\n'}"
body="${response%$'\n'*}"

check "POST /api/payments (retry, same idempotency_key)" 201 "$status"
echo "     body: $body"

echo
echo "== summary: $pass passed, $fail failed =="
[[ "$fail" -eq 0 ]]
