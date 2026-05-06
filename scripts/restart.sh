#!/usr/bin/env bash
# Restart hermithost via docker compose
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
export DOCKER_HOST="${DOCKER_HOST:-unix://$HOME/.docker/run/docker.sock}"

echo "   Restarting hermithost..."
docker compose -f "$ROOT/docker-compose.yml" down
docker compose -f "$ROOT/docker-compose.yml" up -d --build "$@"
