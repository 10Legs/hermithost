#!/usr/bin/env bash
# Start hermithost (frontend + API) via docker compose
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PORT="${TRAEFIK_HTTP_PORT:-8080}"
LOG_DIR="$ROOT/logs"
export DOCKER_HOST=unix:///Users/rdemeritt/.docker/run/docker.sock

mkdir -p "$LOG_DIR"

# Determine whether to force a rebuild
BUILD_FLAG=""
if [[ "${1:-}" == "--build" || "${1:-}" == "-b" ]]; then
  echo "   --build flag set — rebuilding images..."
  BUILD_FLAG="--build"
fi

echo "   Starting hermithost..."
docker compose -f "$ROOT/docker-compose.yml" up -d $BUILD_FLAG 2>&1 | tee "$LOG_DIR/compose.log"

# Wait for frontend port
echo "   Waiting for port $PORT..."
for i in $(seq 1 60); do
  if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
    echo "   Frontend ready"
    break
  fi
  if [[ $i -eq 60 ]]; then
    echo "   Frontend did not become ready. Check logs:"
    echo "   docker compose logs frontend"
    exit 1
  fi
  sleep 0.5
done

echo ""
echo "   hermithost fully running"
echo "   Dashboard  ->  http://localhost:${PORT}"
echo ""
echo "   Logs:   docker compose logs -f"
echo "   Stop:   bash $SCRIPT_DIR/stop.sh"
