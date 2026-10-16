#!/usr/bin/env bash
# Starts infra (Postgres, Redis, Redpanda) via docker compose and the four
# components on the sync + async paths (ledger-service, payment-gateway, bff,
# fraud-check) as local background processes, polling each /healthz before
# returning. Companion to stop-all.sh. Legacy Core (offline/batch) is not
# started here — see e2e/PLAN.md stage 3.
#
# Run from the ledger-rail repo root: ./e2e/scripts/start-all.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_DIR="$ROOT/e2e/.run"
mkdir -p "$RUN_DIR"

echo "== infra: postgres, redis, redpanda =="
(cd "$ROOT" && docker compose up -d postgres redis redpanda)

echo "== waiting for postgres =="
# pg_isready alone is not enough: on a fresh volume the image runs
# docker-entrypoint-initdb.d against a temporary server that already accepts
# connections (unix socket only) before POSTGRES_DB exists and before init
# scripts finish. Query the ledger database over TCP, which only the final
# server listens on.
for i in $(seq 1 30); do
  if docker exec ledger-rail-postgres-1 psql -h 127.0.0.1 -U ledger -d ledger -c 'select 1' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec ledger-rail-postgres-1 psql -h 127.0.0.1 -U ledger -d ledger -c 'select 1' >/dev/null

echo "== applying schema =="
docker exec -i ledger-rail-postgres-1 psql -U ledger -d ledger -v ON_ERROR_STOP=1 \
  < "$ROOT/ledger-service/internal/postgres/schema.sql"

echo "== waiting for redpanda =="
for i in $(seq 1 30); do
  if mise exec rpk -- rpk cluster info --brokers localhost:9092 >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
mise exec rpk -- rpk topic create transactions --brokers localhost:9092 2>/dev/null || true

start_component() {
  local name="$1"
  shift
  echo "== starting $name =="
  ("$@" > "$RUN_DIR/$name.log" 2>&1 &)
}

echo "== building ledger-service =="
(cd "$ROOT/ledger-service" && mise exec go -- go build -o "$RUN_DIR/ledger-service-bin" ./cmd/ledger-service)

start_component ledger-service "$RUN_DIR/ledger-service-bin"
start_component payment-gateway bash -c "cd '$ROOT/payment-gateway' && mise exec java maven -- mvn -q spring-boot:run"
start_component bff bash -c "cd '$ROOT/bff' && mise exec node -- npm run dev"
start_component fraud-check bash -c "cd '$ROOT/fraud-check' && mise exec uv -- uv run fraud-check"

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
wait_healthy fraud-check http://localhost:8090/healthz

echo "== all components up =="
