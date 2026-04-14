#!/usr/bin/env bash
# Show status of hermithost services
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PORT=5113
API_PORT=3013
export DOCKER_HOST=unix:///Users/rdemeritt/.docker/run/docker.sock
LOG_DIR="$ROOT/logs"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

echo ""
echo "hermithost status"
echo "-----------------"
echo ""

# Compose service status
docker compose -f "$ROOT/docker-compose.yml" ps
echo ""

# Port liveness checks
if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
  printf "   port %-6s ${GREEN}LISTENING${NC}\n" "$PORT"
else
  printf "   port %-6s ${RED}NOT OPEN${NC}\n" "$PORT"
fi

if nc -z 127.0.0.1 "$API_PORT" 2>/dev/null; then
  printf "   port %-6s ${GREEN}LISTENING${NC}\n" "$API_PORT"
else
  printf "   port %-6s ${RED}NOT OPEN${NC}\n" "$API_PORT"
fi

echo ""

# Log hints
echo "   Logs (all):      docker compose logs -f"
echo "   Logs (frontend): docker compose logs -f frontend"
echo "   Logs (api):      docker compose logs -f api"

if [[ -d "$LOG_DIR" ]] && compgen -G "$LOG_DIR/*.log" > /dev/null 2>&1; then
  echo ""
  echo "   Build logs: $LOG_DIR/"
  for logfile in "$LOG_DIR"/*.log; do
    [[ -f "$logfile" ]] || continue
    local_name="$(basename "$logfile")"
    local_size="$(wc -c < "$logfile" | tr -d ' ')"
    printf "     %-20s %s bytes\n" "$local_name" "$local_size"
  done
fi

echo ""
echo "   Dashboard  ->  http://localhost:${PORT}"
echo "   API        ->  http://localhost:${API_PORT}"
echo ""
