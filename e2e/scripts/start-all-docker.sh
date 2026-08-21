#!/usr/bin/env bash
# Alternative to start-all.sh: builds and runs every component (infra +
# ledger-service/payment-gateway/bff/fraud-check) as containers via the root
# docker-compose.yml, instead of local background processes. Companion to
# stop-all-docker.sh. Legacy Core stays offline/batch, not part of this stack.
#
# Run from the ledger-rail repo root: ./e2e/scripts/start-all-docker.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cd "$ROOT"
docker compose up -d --build --wait
echo "== all components up =="
