#!/usr/bin/env bash
# Configure hermithost .env from .env.template before first boot.
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
  if grep -qE "^${key}=\s*$" "$ENV_FILE" 2>/dev/null; then
    sed -i '' "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    echo "[setup] Set ${key}."
  else
    echo "[setup] ${key} already set — skipping."
  fi
}

# ── Helper: prompt user for a required value if currently empty ───────────────
prompt_if_empty() {
  local key="$1"
  local prompt_text="$2"
  if grep -qE "^${key}=\s*$" "$ENV_FILE" 2>/dev/null; then
    local value=""
    while [ -z "$value" ]; do
      read -rp "[setup] ${prompt_text}: " value
      if [ -z "$value" ]; then
        echo "[setup] ${key} is required. Please enter a value."
      fi
    done
    sed -i '' "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    echo "[setup] Set ${key}."
  else
    echo "[setup] ${key} already set — skipping."
  fi
}

# ── Coolify admin defaults ────────────────────────────────────────────────────
echo "[setup] Checking Coolify admin credentials..."
set_if_empty "COOLIFY_ADMIN_EMAIL"    "admin@hermithost.local"
set_if_empty "COOLIFY_ADMIN_PASSWORD" "admin"

# ── Generate Coolify internal secrets ────────────────────────────────────────
echo "[setup] Checking Coolify secrets..."
set_if_empty "COOLIFY_APP_ID"            "$(openssl rand -hex 16)"
set_if_empty "COOLIFY_APP_KEY"           "base64:$(openssl rand -base64 32 | tr -d '\n')"
set_if_empty "COOLIFY_DB_PASSWORD"       "$(openssl rand -hex 16)"
set_if_empty "COOLIFY_REDIS_PASSWORD"    "$(openssl rand -hex 16)"
set_if_empty "COOLIFY_PUSHER_APP_ID"     "$(openssl rand -hex 8)"
set_if_empty "COOLIFY_PUSHER_APP_KEY"    "$(openssl rand -hex 16)"
set_if_empty "COOLIFY_PUSHER_APP_SECRET" "$(openssl rand -hex 16)"

# ── Prompt for required user-specific values ─────────────────────────────────
echo ""
echo "[setup] Checking required configuration..."
prompt_if_empty "ACME_EMAIL"   "Email for Let's Encrypt SSL certificates (e.g. you@example.com)"
prompt_if_empty "NS_HOSTNAME"  "Public IP or hostname of this server (e.g. 192.168.2.56 or ns1.example.com)"

echo ""
echo "[setup] Configuration complete. Ready to start:"
echo "        bash scripts/start.sh"
