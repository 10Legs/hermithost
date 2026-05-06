#!/bin/bash
# Full hermithost shutdown — checkpoints and stops coolify-managed containers first,
# then brings down the hermithost stack.
#
# Usage: ./scripts/stack-down.sh [docker compose down flags]
# Example: ./scripts/stack-down.sh --volumes

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$PROJECT_DIR/data"
RESTORE_FILE="$DATA_DIR/restore-containers.json"

mkdir -p "$DATA_DIR"

echo "[stack-down] Checkpointing running coolify-managed containers..."
docker ps --filter label=coolify.managed=true --format '{{.ID}} {{.Names}}' > /tmp/coolify-running.txt

if [ -s /tmp/coolify-running.txt ]; then
  COUNT=$(wc -l < /tmp/coolify-running.txt | tr -d ' ')
  python3 -c "
import json
rows = [l.strip().split(None, 1) for l in open('/tmp/coolify-running.txt') if l.strip()]
print(json.dumps([{'id': r[0], 'name': r[1].lstrip('/')} for r in rows if len(r) == 2]))
" > "$RESTORE_FILE"
  echo "[stack-down] Checkpointed $COUNT container(s) → $RESTORE_FILE"

  echo "[stack-down] Stopping coolify-managed containers..."
  awk '{print $1}' /tmp/coolify-running.txt | xargs docker stop -t 10
  echo "[stack-down] Coolify containers stopped."
else
  echo "[stack-down] No running coolify-managed containers."
  echo "[]" > "$RESTORE_FILE"
fi

rm -f /tmp/coolify-running.txt

echo "[stack-down] Bringing down hermithost stack..."
cd "$PROJECT_DIR"
docker compose down "$@"
echo "[stack-down] Done. Run 'docker compose up -d' to restart and restore."
