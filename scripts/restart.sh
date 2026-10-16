#!/usr/bin/env bash
# Restart hermithost via docker compose
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
export DOCKER_HOST="${DOCKER_HOST:-unix://$HOME/.docker/run/docker.sock}"

# `down` removes hermithost-net; refuse before that if it could not be recreated
# because another network now holds its subnet (#125 — 2026-07-13 outage).
# shellcheck source=lib/net-subnet.sh
source "$SCRIPT_DIR/lib/net-subnet.sh"
_env() { grep -E "^$1=" "$ROOT/.env" 2>/dev/null | tail -n1 | cut -d'=' -f2- | tr -d '[:space:]"' || true; }
_PROJECT="$(_env COMPOSE_PROJECT_NAME)"; _SUBNET="$(_env HERMITHOST_NET_SUBNET)"; _TIP="$(_env TECHNITIUM_IP)"
hermithost_net_preflight "${_PROJECT:-hermithost}_hermithost-net" "${_SUBNET:-$HH_DEFAULT_SUBNET}" \
  "${_TIP:-172.28.0.10}" "[restart]" recreate || exit 1

echo "   Restarting hermithost..."
docker compose -f "$ROOT/docker-compose.yml" down
docker compose -f "$ROOT/docker-compose.yml" up -d --build "$@"
