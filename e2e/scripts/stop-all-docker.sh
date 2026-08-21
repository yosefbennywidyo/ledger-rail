#!/usr/bin/env bash
# Companion to start-all-docker.sh: stops and removes every container started
# via the root docker-compose.yml.
#
# Run from the ledger-rail repo root: ./e2e/scripts/stop-all-docker.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cd "$ROOT"
docker compose down
