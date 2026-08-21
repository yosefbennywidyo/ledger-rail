#!/usr/bin/env bash
# Stops what start-all.sh started: the three app components (by port, since
# `go run`/`mvn spring-boot:run`/`npm run dev` each spawn a child process tree)
# and the infra containers. Postgres data is intentionally kept (docker compose
# stop, not down -v) so state can be inspected after a run.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

for port in 8080 8081 8082; do
  pids="$(lsof -ti:"$port" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "== stopping process on :$port =="
    echo "$pids" | xargs kill -9
  fi
done

echo "== stopping infra =="
(cd "$ROOT" && docker compose stop postgres redis)
