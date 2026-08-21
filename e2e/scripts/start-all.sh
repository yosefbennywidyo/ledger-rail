#!/usr/bin/env bash
# Starts infra (Postgres, Redis) via docker compose and the three synchronous-path
# components (ledger-service, payment-gateway, bff) as local background processes,
# polling each /healthz before returning. Companion to stop-all.sh.
#
# Run from the ledger-rail repo root: ./e2e/scripts/start-all.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_DIR="$ROOT/e2e/.run"
mkdir -p "$RUN_DIR"

echo "== infra: postgres, redis =="
(cd "$ROOT" && docker compose up -d postgres redis)

echo "== waiting for postgres =="
for i in $(seq 1 30); do
  if docker exec ledger-rail-postgres-1 pg_isready -U ledger >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec ledger-rail-postgres-1 pg_isready -U ledger

echo "== applying schema =="
docker exec -i ledger-rail-postgres-1 psql -U ledger -d ledger -v ON_ERROR_STOP=1 \
  < "$ROOT/ledger-service/internal/postgres/schema.sql"

start_component() {
  local name="$1"
  shift
  echo "== starting $name =="
  ("$@" > "$RUN_DIR/$name.log" 2>&1 &)
}

start_component ledger-service bash -c "cd '$ROOT/ledger-service' && mise exec go -- go run ./cmd/ledger-service"
start_component payment-gateway bash -c "cd '$ROOT/payment-gateway' && mise exec java maven -- mvn -q spring-boot:run"
start_component bff bash -c "cd '$ROOT/bff' && mise exec node -- npm run dev"

wait_healthy() {
  local name="$1"
  local url="$2"
  for i in $(seq 1 60); do
    if [[ "$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)" == "200" ]]; then
      echo "== $name healthy after ${i}s =="
      return 0
    fi
    sleep 1
  done
  echo "== $name did not become healthy in time; see $RUN_DIR/$name.log ==" >&2
  return 1
}

wait_healthy ledger-service http://localhost:8080/healthz
wait_healthy payment-gateway http://localhost:8081/healthz
wait_healthy bff http://localhost:8082/healthz

echo "== all components up =="
