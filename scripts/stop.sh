#!/usr/bin/env bash
# Stop hermithost (frontend + API) via docker compose
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PORT=5113
API_PORT=3013
export DOCKER_HOST=unix:///Users/rdemeritt/.docker/run/docker.sock

echo "Stopping hermithost..."

# Stop compose-managed containers
docker compose -f "$ROOT/docker-compose.yml" down 2>/dev/null || echo "   (compose down failed or not running)"

# Also stop any legacy standalone hermithost container (non-compose)
for name in hermithost hermithost-frontend hermithost-api; do
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${name}$"; then
    echo "   . Removing legacy container: $name"
    docker stop "$name" > /dev/null 2>&1 || true
    docker rm "$name" > /dev/null 2>&1 || true
  fi
done

echo "Done"
