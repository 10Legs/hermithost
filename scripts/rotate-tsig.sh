#!/usr/bin/env bash
# Rotate the RFC2136 TSIG secret.
#
# Generates a fresh HMAC-SHA256 secret, re-registers it in Technitium, writes
# the new secret to the coolify-api-token Docker volume, and reminds the
# operator to restart Traefik (Phase 2 dependency).
#
# Usage:
#   TECHNITIUM_URL=http://localhost:5380 \
#   TECHNITIUM_TOKEN=<token> \
#   bash scripts/rotate-tsig.sh
#
# Or source .env selectively first:
#   export TECHNITIUM_URL TECHNITIUM_TOKEN
#   bash scripts/rotate-tsig.sh
#
# The script runs inside docker (coolify-api-token volume mounted) so the
# secret is never written to the host filesystem. SEC-S1.
#
# ADR reference: adr-007-dns-01-internal-ca-2026-05-01.md §Rotation

set -euo pipefail

# ── Temp-file cleanup trap (SEC-N2) ──────────────────────────────────────────
TSIG_BODY_FILE=""
ZONE_BODY_FILE=""
trap 'rm -f "$TSIG_BODY_FILE" "$ZONE_BODY_FILE" 2>/dev/null || true' EXIT INT TERM

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
ENV_FILE="$ROOT/.env"

# ── Resolve required vars ─────────────────────────────────────────────────────
TECHNITIUM_URL="${TECHNITIUM_URL:-}"
TECHNITIUM_TOKEN="${TECHNITIUM_TOKEN:-}"

if [ -z "$TECHNITIUM_URL" ] || [ -z "$TECHNITIUM_TOKEN" ]; then
  if [ -f "$ENV_FILE" ]; then
    _URL="$(grep -E '^TECHNITIUM_URL=' "$ENV_FILE" | cut -d'=' -f2- || true)"
    _TOKEN="$(grep -E '^TECHNITIUM_TOKEN=' "$ENV_FILE" | cut -d'=' -f2- || true)"
    TECHNITIUM_URL="${TECHNITIUM_URL:-$_URL}"
    TECHNITIUM_TOKEN="${TECHNITIUM_TOKEN:-$_TOKEN}"
  fi
fi

if [ -z "$TECHNITIUM_URL" ]; then
  echo "[rotate-tsig] ERROR: TECHNITIUM_URL is not set." >&2
  exit 1
fi
if [ -z "$TECHNITIUM_TOKEN" ]; then
  echo "[rotate-tsig] ERROR: TECHNITIUM_TOKEN is not set." >&2
  exit 1
fi

TSIG_KEY_NAME="${RFC2136_TSIG_KEYNAME:-hermithost-acme}"
TSIG_ALGORITHM="${RFC2136_TSIG_ALGORITHM:-hmac-sha256.}"
TSIG_SECRET_FILE="${RFC2136_TSIG_SECRET_FILE:-/coolify-api-token/rfc2136_tsig.secret}"
TSIG_MANIFEST_FILE="$(dirname "$TSIG_SECRET_FILE")/rfc2136_tsig.json"
ZONE="${RFC2136_ZONE:-hh}"

echo "[rotate-tsig] Rotating TSIG key '${TSIG_KEY_NAME}'..."

# ── Generate new secret ───────────────────────────────────────────────────────
NEW_SECRET="$(openssl rand -base64 32 | tr -d '\n')"

# ── Detect hermithost-net subnet ──────────────────────────────────────────────
HERMITHOST_NET_SUBNET=""
for NET_NAME in hermithost_hermithost-net hermithost-net; do
  HERMITHOST_NET_SUBNET="$(docker network inspect "$NET_NAME" --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null || true)"
  if [ -n "$HERMITHOST_NET_SUBNET" ]; then
    break
  fi
done

if [ -z "$HERMITHOST_NET_SUBNET" ]; then
  echo "[rotate-tsig] ERROR: hermithost-net subnet detection failed. Bring stack up first." >&2
  exit 1
fi

UPDATE_ACL="${HERMITHOST_NET_SUBNET}"

# ── Register new secret in Technitium ────────────────────────────────────────
# Write to temp file (mode 0600) to avoid argv leakage. SEC-S2.
TSIG_BODY_FILE="$(dirname "$TSIG_SECRET_FILE")/.tsig_rotate_req.tmp"
printf 'token=%s&tsigKeys=%s|%s|%s' \
  "${TECHNITIUM_TOKEN}" "${TSIG_KEY_NAME}" "${NEW_SECRET}" "${TSIG_ALGORITHM}" \
  > "$TSIG_BODY_FILE"
chmod 0600 "$TSIG_BODY_FILE"
REGISTER_RESULT="$(
  curl -sf -X POST "${TECHNITIUM_URL}/api/settings/set" \
    --data @"$TSIG_BODY_FILE" \
    2>/dev/null
)" || true
rm -f "$TSIG_BODY_FILE"

STATUS="$(echo "$REGISTER_RESULT" | grep -o '"status":"[^"]*"' | cut -d'"' -f4 || echo "unknown")"
if [ "$STATUS" != "ok" ]; then
  echo "[rotate-tsig] ERROR: Failed to register rotated TSIG key. Response: ${REGISTER_RESULT}" >&2
  exit 1
fi

# ── Re-apply zone permissions with new ACL ────────────────────────────────────
ZONE_BODY_FILE="$(dirname "$TSIG_SECRET_FILE")/.zone_rotate_req.tmp"
printf 'token=%s&zone=%s&update=UseSpecifiedNetworkACL&updateNetworkACL=%s&updateSecurityPolicies=%s|*.%s.|TXT' \
  "${TECHNITIUM_TOKEN}" "${ZONE}" "${UPDATE_ACL}" "${TSIG_KEY_NAME}" "${ZONE}" \
  > "$ZONE_BODY_FILE"
chmod 0600 "$ZONE_BODY_FILE"
ZONE_RESULT="$(
  curl -sf -X POST "${TECHNITIUM_URL}/api/zones/options/set" \
    --data @"$ZONE_BODY_FILE" \
    2>/dev/null
)" || true
rm -f "$ZONE_BODY_FILE"

ZONE_STATUS="$(echo "$ZONE_RESULT" | grep -o '"status":"[^"]*"' | cut -d'"' -f4 || echo "unknown")"
if [ "$ZONE_STATUS" != "ok" ]; then
  echo "[rotate-tsig] ERROR: Failed to re-apply zone permissions. Response: ${ZONE_RESULT}" >&2
  exit 1
fi

# ── Persist new secret to volume ──────────────────────────────────────────────
printf '%s' "$NEW_SECRET" > "$TSIG_SECRET_FILE"
chmod 0600 "$TSIG_SECRET_FILE"

# ── Update manifest ───────────────────────────────────────────────────────────
CREATED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
cat > "$TSIG_MANIFEST_FILE" << MANIFEST_EOF
{
  "keyName": "${TSIG_KEY_NAME}",
  "algorithm": "${TSIG_ALGORITHM}",
  "zone": "${ZONE}",
  "subnet": "${HERMITHOST_NET_SUBNET}",
  "updateMode": "UseSpecifiedNetworkACL",
  "createdAt": "${CREATED_AT}"
}
MANIFEST_EOF

echo "[rotate-tsig] TSIG key rotated successfully."
echo ""
echo "[rotate-tsig] *** ACTION REQUIRED ***"
echo "[rotate-tsig] Restart Traefik to pick up the new secret (Phase 2 dependency):"
echo "[rotate-tsig]   docker compose restart traefik"
echo "[rotate-tsig] Ad-hoc deletion of the secret file is discouraged — always use this"
echo "[rotate-tsig] script to rotate so Technitium and the volume stay in sync."
