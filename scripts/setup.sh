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
# Auto-detect public IP for NS_SERVER_IP; fall back to prompt if unavailable
if grep -qE "^NS_SERVER_IP=\s*$" "$ENV_FILE" 2>/dev/null; then
  AUTO_IP=$(curl -sf --max-time 5 https://ifconfig.me 2>/dev/null || echo "")
  if [ -n "$AUTO_IP" ]; then
    sed -i '' "s|^NS_SERVER_IP=.*|NS_SERVER_IP=${AUTO_IP}|" "$ENV_FILE"
    echo "[setup] Auto-detected NS_SERVER_IP: ${AUTO_IP}"
  else
    prompt_if_empty "NS_SERVER_IP" "Public IPv4 of this server for DNS glue records (e.g. 203.0.113.1)"
  fi
fi

# ── Coolify admin defaults ────────────────────────────────────────────────────
# Email defaults to ACME_EMAIL (a real, validated address — required for Coolify's RFC+DNS email check).
# Password is auto-generated to meet Coolify's policy: min 8 chars, mixed case, numbers, symbols.
echo ""
echo "[setup] Checking Coolify admin credentials..."
ACME_EMAIL_VALUE="$(grep -E '^ACME_EMAIL=' "$ENV_FILE" | cut -d'=' -f2-)"
set_if_empty "COOLIFY_ADMIN_EMAIL" "${ACME_EMAIL_VALUE}"
if grep -qE "^COOLIFY_ADMIN_PASSWORD=\s*$" "$ENV_FILE" 2>/dev/null; then
  GENERATED_PASSWORD="A$(openssl rand -hex 10)1!"
  sed -i '' "s|^COOLIFY_ADMIN_PASSWORD=.*|COOLIFY_ADMIN_PASSWORD=${GENERATED_PASSWORD}|" "$ENV_FILE"
  echo "[setup] Set COOLIFY_ADMIN_PASSWORD."
  echo ""
  echo "[setup] *** SAVE THIS PASSWORD — it will not be shown again ***"
  echo "[setup] Coolify admin password: ${GENERATED_PASSWORD}"
  echo ""
else
  echo "[setup] COOLIFY_ADMIN_PASSWORD already set — skipping."
fi

echo ""
echo "[setup] Configuration complete. Ready to start:"
echo "        docker compose up -d"
