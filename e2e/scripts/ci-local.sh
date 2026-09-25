#!/usr/bin/env bash
# Replays the steps of .github/workflows/e2e.yml locally, starting from the
# same clean state as a fresh runner: infra containers and the pgdata volume
# are removed first (docker compose down -v), so any local Postgres data for
# this project is discarded. Toolchains come from mise, as in CI; GnuCOBOL
# must already be installed (see legacy-core/README.md).
#
# Run from anywhere: ./e2e/scripts/ci-local.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

step() { echo; echo "######## [$(date -u +%H:%M:%SZ)] $* ########"; }

# A host service on these ports wins over Docker's port-forward for
# connections to localhost, so components and tests would silently talk to
# the wrong Postgres/Redis.
for port in 5432 6379; do
  owner="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1}')"
  if [[ -n "$owner" && "$owner" != com.docke* ]]; then
    echo "port $port is held by '$owner' on the host; stop it first" >&2
    echo "(e.g. brew services stop postgresql@14 / brew services stop redis)" >&2
    exit 1
  fi
done

step "Reset infra (fresh volume, like a new runner)"
docker compose down -v --remove-orphans
rm -f "$ROOT"/e2e/.run/*.log

step "Pre-fetch dependencies"
(cd ledger-service && mise exec go -- go mod download) &&
  (cd payment-gateway && mise exec java maven -- mvn -q -B dependency:resolve) &&
  (cd bff && mise exec node -- npm install) &&
  (cd fraud-check && mise exec uv -- uv sync) &&
  (cd e2e && mise exec node -- npm install) || {
  echo "pre-fetch failed" >&2
  exit 1
}

step "Start all components"
./e2e/scripts/start-all.sh
start_rc=$?

test_rc=skipped
if [[ $start_rc -eq 0 ]]; then
  step "Run e2e suite"
  (cd e2e && mise exec node -- npm test)
  test_rc=$?
fi

if [[ $start_rc -ne 0 || $test_rc != 0 ]]; then
  step "Dump component logs"
  for f in e2e/.run/*.log; do
    [[ -e "$f" ]] || continue
    echo "==== $f ===="
    cat "$f"
  done
fi

step "Stop all components"
./e2e/scripts/stop-all.sh

echo
echo "RESULT start_rc=$start_rc test_rc=$test_rc"
[[ $start_rc -eq 0 && $test_rc == 0 ]]
