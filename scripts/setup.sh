#!/usr/bin/env bash
# Generate hermithost .env from .env.template, auto-filling secrets.
# Safe to re-run — only fills empty values, never overwrites existing ones.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
ENV_FILE="$ROOT/.env"
TEMPLATE_FILE="$ROOT/.env.template"

# ── Create .env from template if it doesn't exist ────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  cp "$TEMPLATE_FILE" "$ENV_FILE"
  echo "[setup] Created .env from template."
fi

# ── Helper: set a value in .env only if the key is currently empty ────────────
set_if_empty() {
  local key="$1"
  local value="$2"
  # Match key= with empty or missing value
  if grep -qE "^${key}=\s*$" "$ENV_FILE" 2>/dev/null; then
    # Use | as sed delimiter to avoid issues with base64 / slashes
    sed -i '' "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    echo "[setup] Generated ${key}."
  else
    echo "[setup] ${key} already set — skipping."
  fi
}

# ── Generate Coolify internal secrets ────────────────────────────────────────
echo "[setup] Checking Coolify secrets..."

set_if_empty "COOLIFY_APP_ID"         "$(openssl rand -hex 16)"
set_if_empty "COOLIFY_APP_KEY"        "base64:$(openssl rand -base64 32 | tr -d '\n')"
set_if_empty "COOLIFY_DB_PASSWORD"    "$(openssl rand -hex 16)"
set_if_empty "COOLIFY_REDIS_PASSWORD" "$(openssl rand -hex 16)"
set_if_empty "COOLIFY_PUSHER_APP_ID"  "$(openssl rand -hex 8)"
set_if_empty "COOLIFY_PUSHER_APP_KEY" "$(openssl rand -hex 16)"
set_if_empty "COOLIFY_PUSHER_APP_SECRET" "$(openssl rand -hex 16)"

# ── Remind user about required manual entries ────────────────────────────────
echo ""
echo "[setup] Checking required manual entries..."

missing=0
for key in GITHUB_TOKEN COOLIFY_ADMIN_EMAIL COOLIFY_ADMIN_PASSWORD ACME_EMAIL NS_HOSTNAME; do
  if grep -qE "^${key}=\s*$" "$ENV_FILE" 2>/dev/null; then
    echo "[setup] WARNING: ${key} is not set — edit .env before running docker compose up."
    missing=$((missing + 1))
  fi
done

echo ""
if [ "$missing" -gt 0 ]; then
  echo "[setup] ${missing} required value(s) missing. Edit .env, then run:"
  echo "        bash scripts/start.sh"
else
  echo "[setup] All required values set. Ready to start:"
  echo "        bash scripts/start.sh"
fi
