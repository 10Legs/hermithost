#!/usr/bin/env bash
# Configure hermithost .env from .env.template before first boot.
# Safe to re-run — only fills empty values, never overwrites existing ones.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
ENV_FILE="$ROOT/.env"
TEMPLATE_FILE="$ROOT/.env.template"

# Portable in-place sed (macOS requires -i '', Linux requires -i)
sed_i() {
  if [[ "$OSTYPE" == darwin* ]]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

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
    sed_i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
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
    sed_i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    echo "[setup] Set ${key}."
  else
    echo "[setup] ${key} already set — skipping."
  fi
}

# ── Helper: prompt for network port mode and write 5 keys ────────────────────
prompt_port_mode() {
  # Migration hint: if HERMITHOST_PORT_MODE is unset but legacy NETWORK_MODE=internal is present,
  # pre-select LAN mode to preserve the operator's prior intent.
  local legacy_network_mode
  legacy_network_mode="$(grep -E '^NETWORK_MODE=' "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '[:space:]' || true)"

  # Idempotent: skip if already set
  local current_mode
  current_mode="$(grep -E '^HERMITHOST_PORT_MODE=' "$ENV_FILE" | cut -d'=' -f2- || true)"
  if [ -n "$current_mode" ]; then
    echo "[setup] Port mode already set: ${current_mode} — skipping"
    return
  fi

  if [ "$legacy_network_mode" = "internal" ]; then
    echo "[setup] Migrating: NETWORK_MODE=internal → HERMITHOST_PORT_MODE=lan (pre-selecting LAN mode)"
  fi

  local choice=""
  while true; do
    echo ""
    echo "[setup] Network mode for this hermithost?"
    echo "        [1] LAN  — binds host ports 80 / 443. Best for private/home network."
    echo "                   Requires 80 and 443 to be free on this host."
    echo "        [2] Internet — binds host ports 8080 / 8443. Use when 80/443 are"
    echo "                       reserved."
    local prompt_default="2"
    [ "$legacy_network_mode" = "internal" ] && prompt_default="1"
    read -rp "        Choose [1/2] (default: ${prompt_default}): " choice
    choice="${choice:-${prompt_default}}"

    # Migration: ensure LEGO_CA_CERTIFICATES key exists as an uncommented line
    # so the subsequent sed can match it. Handles legacy .env files where the
    # line was commented out (# LEGO_CA_CERTIFICATES=...) or absent entirely.
    if ! grep -qE '^LEGO_CA_CERTIFICATES=' "$ENV_FILE"; then
      echo "LEGO_CA_CERTIFICATES=" >> "$ENV_FILE"
    fi

    if [ "$choice" = "1" ]; then
      # Pre-flight: check if 80 or 443 are already bound
      local p80 p443
      p80="$(lsof -iTCP:80 -sTCP:LISTEN 2>/dev/null || true)"
      p443="$(lsof -iTCP:443 -sTCP:LISTEN 2>/dev/null || true)"
      if [ -n "$p80" ] || [ -n "$p443" ]; then
        echo ""
        echo "[setup] WARNING: one or more required ports are already in use:"
        [ -n "$p80" ]  && echo "  Port 80:"  && echo "$p80"
        [ -n "$p443" ] && echo "  Port 443:" && echo "$p443"
        local confirm=""
        read -rp "[setup] Continue with LAN mode anyway? [y/N]: " confirm
        confirm="${confirm:-N}"
        if [[ "$confirm" =~ ^[Yy]$ ]]; then
          choice="1"
        else
          # Loop back to mode prompt
          continue
        fi
      fi
      # Pre-flight: check if port 53 is already bound (TCP + UDP)
      # On macOS, mDNSResponder listens on UDP 53. The operator may need to
      # disable it (sudo launchctl unload /System/Library/LaunchDaemons/com.apple.mDNSResponder.plist)
      # or run hermithost as root for the bind to succeed.
      local p53tcp p53udp
      p53tcp="$(lsof -iTCP:53  -sTCP:LISTEN 2>/dev/null || true)"
      p53udp="$(lsof -iUDP:53             2>/dev/null || true)"
      if [ -n "$p53tcp" ] || [ -n "$p53udp" ]; then
        echo ""
        echo "[setup] WARNING: port 53 (DNS) is already in use:"
        [ -n "$p53tcp" ] && echo "  TCP 53:" && echo "$p53tcp"
        [ -n "$p53udp" ] && echo "  UDP 53:" && echo "$p53udp"
        echo "[setup] NOTE: On macOS, mDNSResponder typically occupies UDP 53."
        echo "[setup] To free it: sudo launchctl unload /System/Library/LaunchDaemons/com.apple.mDNSResponder.plist"
        echo "[setup] Alternatively, hermithost can be started as root to override the bind."
        local confirm53=""
        read -rp "[setup] Continue with LAN mode (DNS_PORT=53) anyway? [y/N]: " confirm53
        confirm53="${confirm53:-N}"
        if [[ ! "$confirm53" =~ ^[Yy]$ ]]; then
          # Loop back to mode prompt
          continue
        fi
      fi
      # Apply LAN
      sed_i "s|^HERMITHOST_PORT_MODE=.*|HERMITHOST_PORT_MODE=lan|"         "$ENV_FILE"
      sed_i "s|^TRAEFIK_HTTP_PORT=.*|TRAEFIK_HTTP_PORT=80|"                "$ENV_FILE"
      sed_i "s|^TRAEFIK_HTTPS_PORT=.*|TRAEFIK_HTTPS_PORT=443|"             "$ENV_FILE"
      sed_i "s|^PUBLIC_BASE_PORT_HTTP=.*|PUBLIC_BASE_PORT_HTTP=80|"        "$ENV_FILE"
      sed_i "s|^PUBLIC_BASE_PORT_HTTPS=.*|PUBLIC_BASE_PORT_HTTPS=443|"     "$ENV_FILE"
      sed_i "s|^DNS_PORT=.*|DNS_PORT=53|"                                  "$ENV_FILE"
      sed_i "s|^LEGO_CA_CERTIFICATES=.*|LEGO_CA_CERTIFICATES=/home/step/certs/root_ca.crt|" "$ENV_FILE"
      echo "[setup] Port mode set to lan: HTTP=80 HTTPS=443 DNS=53 LEGO_CA=/home/step/certs/root_ca.crt"
      break
    elif [ "$choice" = "2" ]; then
      # Apply internet
      sed_i "s|^HERMITHOST_PORT_MODE=.*|HERMITHOST_PORT_MODE=internet|"       "$ENV_FILE"
      sed_i "s|^TRAEFIK_HTTP_PORT=.*|TRAEFIK_HTTP_PORT=8080|"                 "$ENV_FILE"
      sed_i "s|^TRAEFIK_HTTPS_PORT=.*|TRAEFIK_HTTPS_PORT=8443|"               "$ENV_FILE"
      sed_i "s|^PUBLIC_BASE_PORT_HTTP=.*|PUBLIC_BASE_PORT_HTTP=8080|"          "$ENV_FILE"
      sed_i "s|^PUBLIC_BASE_PORT_HTTPS=.*|PUBLIC_BASE_PORT_HTTPS=8443|"        "$ENV_FILE"
      sed_i "s|^DNS_PORT=.*|DNS_PORT=5353|"                                    "$ENV_FILE"
      sed_i "s|^LEGO_CA_CERTIFICATES=.*|LEGO_CA_CERTIFICATES=|"               "$ENV_FILE"
      echo "[setup] Port mode set to internet: HTTP=8080 HTTPS=8443 DNS=5353 LEGO_CA="
      break
    else
      echo "[setup] Invalid choice. Please enter 1 or 2."
    fi
  done
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
prompt_port_mode
prompt_if_empty "ACME_EMAIL"         "Email for Let's Encrypt SSL certificates (e.g. you@example.com)"
prompt_if_empty "NS_HOSTNAME"        "Public IP or hostname of this server (e.g. 192.168.2.56 or ns1.example.com)"
prompt_if_empty "HERMITHOST_PASSWORD" "Password for the hermithost dashboard login"

# ── Derive COOKIE_SECRET from HERMITHOST_PASSWORD ─────────────────────────────
# The secret is derived deterministically so re-runs with the same password
# produce the same secret (sessions survive setup re-runs). The password itself
# is never written to .env; only the derived secret lands there.
#
# Salt design:
#   "${password}${HOSTNAME}-hermithost-cookie-v1"
#   - HOSTNAME: ties the secret to this specific host, so two hosts sharing the
#     same operator password don't produce colliding secrets.
#   - "-hermithost-cookie-v1": versioned tag; bump to "v2" to force a global
#     rotation without requiring a password change.
#
# Idempotent: if COOKIE_SECRET is already set AND the password hasn't changed
# (i.e., the derivation produces the same value), we leave it alone.
# If the operator changed HERMITHOST_PASSWORD, the derived secret rotates —
# that is intentional: existing sessions are invalidated, which is correct.
derive_cookie_secret() {
  local current_pw
  current_pw="$(grep -E '^HERMITHOST_PASSWORD=' "$ENV_FILE" | cut -d'=' -f2- || true)"
  if [ -z "$current_pw" ]; then
    echo "[setup] HERMITHOST_PASSWORD is empty — skipping COOKIE_SECRET derivation."
    return
  fi

  # Derive: sha256(password + salt), base64-encoded, stripped to 64 URL-safe chars
  local derived
  # NOTE: printf is used (not echo) to avoid appending a newline into the hash input.
  derived="$(printf '%s' "${current_pw}${HOSTNAME}-hermithost-cookie-v1" \
    | openssl dgst -sha256 -binary \
    | base64 \
    | tr -d '=+/' \
    | head -c 64)"

  local current_secret
  current_secret="$(grep -E '^COOKIE_SECRET=' "$ENV_FILE" | cut -d'=' -f2- || true)"

  if [ "$current_secret" = "$derived" ]; then
    echo "[setup] COOKIE_SECRET already matches derived value — skipping."
  else
    sed_i "s|^COOKIE_SECRET=.*|COOKIE_SECRET=${derived}|" "$ENV_FILE"
    echo "[setup] COOKIE_SECRET derived and set."
  fi
}
derive_cookie_secret
# Auto-detect NS_SERVER_IP; strategy depends on HERMITHOST_PORT_MODE
if grep -qE "^NS_SERVER_IP=\s*$" "$ENV_FILE" 2>/dev/null; then
  PORT_MODE="$(grep -E '^HERMITHOST_PORT_MODE=' "$ENV_FILE" | cut -d'=' -f2- || true)"
  AUTO_IP=""
  if [ "$PORT_MODE" = "lan" ]; then
    if [[ "$OSTYPE" == darwin* ]]; then
      AUTO_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")"
    else
      AUTO_IP="$(ip route get 1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' || echo "")"
    fi
    FALLBACK_PROMPT="LAN IPv4 of this host for DNS glue records (e.g. 192.168.1.10)"
  else
    AUTO_IP="$(curl -sf --max-time 5 https://ifconfig.me 2>/dev/null || echo "")"
    FALLBACK_PROMPT="Public IPv4 of this server for DNS glue records (e.g. 203.0.113.1)"
  fi
  if [ -n "$AUTO_IP" ]; then
    sed_i "s|^NS_SERVER_IP=.*|NS_SERVER_IP=${AUTO_IP}|" "$ENV_FILE"
    echo "[setup] Auto-detected NS_SERVER_IP (${PORT_MODE}): ${AUTO_IP}"
  else
    prompt_if_empty "NS_SERVER_IP" "$FALLBACK_PROMPT"
  fi
fi

# ── Coolify admin defaults ────────────────────────────────────────────────────
# Email defaults to ACME_EMAIL (a real, validated address — required for Coolify's RFC+DNS email check).
# Password is auto-generated to meet Coolify's policy: min 8 chars, mixed case, numbers, symbols.
echo ""
echo "[setup] Checking Coolify admin credentials..."
ACME_EMAIL_VALUE="$(grep -E '^ACME_EMAIL=' "$ENV_FILE" | cut -d'=' -f2- || true)"
set_if_empty "COOLIFY_ADMIN_EMAIL" "${ACME_EMAIL_VALUE}"
if grep -qE "^COOLIFY_ADMIN_PASSWORD=\s*$" "$ENV_FILE" 2>/dev/null; then
  GENERATED_PASSWORD="A$(openssl rand -hex 10)1!"
  sed_i "s|^COOLIFY_ADMIN_PASSWORD=.*|COOLIFY_ADMIN_PASSWORD=${GENERATED_PASSWORD}|" "$ENV_FILE"
  echo "[setup] Set COOLIFY_ADMIN_PASSWORD."
  echo ""
  echo "[setup] *** SAVE THIS PASSWORD — it will not be shown again ***"
  echo "[setup] Coolify admin password: ${GENERATED_PASSWORD}"
  echo ""
else
  echo "[setup] COOLIFY_ADMIN_PASSWORD already set — skipping."
fi

# ── Technitium TSIG bootstrap (LAN mode only) ────────────────────────────────
# Generates or reuses the RFC2136 TSIG key and registers it in Technitium.
# Only runs when HERMITHOST_PORT_MODE=lan and Technitium is reachable.
# Idempotent: re-running setup.sh reuses the existing key without re-registering.
echo ""
echo "[setup] Checking RFC2136 TSIG bootstrap (LAN mode only)..."
PORT_MODE_CURRENT="$(grep -E '^HERMITHOST_PORT_MODE=' "$ENV_FILE" | cut -d'=' -f2- || true)"
if [ "$PORT_MODE_CURRENT" = "lan" ]; then
  # Source the .env so TECHNITIUM_URL and TECHNITIUM_TOKEN are available.
  # At setup time the stack may not be running yet, so we skip gracefully if
  # TECHNITIUM_TOKEN is empty (the init script self-guards on empty token).
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  bash "$SCRIPT_DIR/conf.d/technitium-tsig-init.sh" || {
    echo "[setup] WARNING: TSIG bootstrap failed or was skipped."
    echo "[setup] Re-run 'bash scripts/setup.sh' after starting the stack to complete TSIG setup."
  }
else
  echo "[setup] Not in LAN mode — skipping TSIG bootstrap."
fi

echo ""
echo "[setup] Configuration complete. Ready to start:"
echo "        bash scripts/start.sh -d"
