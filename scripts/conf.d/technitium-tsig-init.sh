#!/usr/bin/env bash
# One-shot: generate or reuse a TSIG key for RFC2136 dynamic updates and register it
# in Technitium. Called by setup.sh after the Technitium post-bootstrap section.
#
# Produces:
#   /coolify-api-token/rfc2136_tsig.secret   (0600) — raw base64 HMAC-SHA256 secret
#   /coolify-api-token/rfc2136_tsig.json             — manifest consumed by Phase 2
#
# Idempotent: if the secret file already exists the key is reused (not regenerated).
# If Technitium already has the key registered with the same name it is re-set to the
# same value (settings/set is idempotent for identical inputs).
#
# Spike findings (2026-05-01):
#   Q1: Technitium v15.0.1 accepts RFC2136 + HMAC-SHA256 TSIG natively.
#   Q2: settings/set uses tsigKeys=keyName|secret|algo (pipe-delimited, from web UI JS).
#       zones/options/set uses updateSecurityPolicies=keyName|domain|allowedTypes.
#       Correct update mode value for subnet ACL is "UseSpecifiedNetworkACL".
#   Q5: hermithost_hermithost-net CIDR = 172.18.0.0/16 (runtime-read, not hardcoded).
#
# ADR reference: adr-007-dns-01-internal-ca-2026-05-01.md

set -euo pipefail

# ── Inputs ────────────────────────────────────────────────────────────────────
TECHNITIUM_URL="${TECHNITIUM_URL:-http://localhost:5380}"
TECHNITIUM_TOKEN="${TECHNITIUM_TOKEN:-}"
TSIG_KEY_NAME="${RFC2136_TSIG_KEYNAME:-hermithost-acme}"
TSIG_ALGORITHM="${RFC2136_TSIG_ALGORITHM:-hmac-sha256}"
TSIG_SECRET_FILE="${RFC2136_TSIG_SECRET_FILE:-/coolify-api-token/rfc2136_tsig.secret}"
# Manifest lives alongside the secret file (same directory, Docker volume)
TSIG_MANIFEST_FILE="$(dirname "$TSIG_SECRET_FILE")/rfc2136_tsig.json"
ZONE="${RFC2136_ZONE:-hh}"

# ── Guards ────────────────────────────────────────────────────────────────────
if [ -z "$TECHNITIUM_TOKEN" ]; then
  echo "[tsig-init] TECHNITIUM_TOKEN is empty — skipping TSIG bootstrap (LAN mode only)."
  exit 0
fi

# Only run in LAN mode
if [ "${HERMITHOST_PORT_MODE:-}" != "lan" ]; then
  echo "[tsig-init] Not in LAN mode (HERMITHOST_PORT_MODE=${HERMITHOST_PORT_MODE:-unset}) — skipping TSIG bootstrap."
  exit 0
fi

echo "[tsig-init] Starting Technitium TSIG bootstrap..."
echo "[tsig-init]   Key name  : ${TSIG_KEY_NAME}"
echo "[tsig-init]   Algorithm : ${TSIG_ALGORITHM}"
echo "[tsig-init]   Zone      : ${ZONE}"
echo "[tsig-init]   Secret file: ${TSIG_SECRET_FILE}"

# ── Step 1: Generate or reuse the TSIG secret ─────────────────────────────────
if [ -f "$TSIG_SECRET_FILE" ]; then
  echo "[tsig-init] Secret file already exists — reusing."
  TSIG_SECRET="$(cat "$TSIG_SECRET_FILE")"
else
  echo "[tsig-init] Generating new 32-byte HMAC-SHA256 secret..."
  TSIG_SECRET="$(openssl rand -base64 32 | tr -d '\n')"
  # Ensure parent directory exists (shared volume must be mounted by now)
  mkdir -p "$(dirname "$TSIG_SECRET_FILE")"
  printf '%s' "$TSIG_SECRET" > "$TSIG_SECRET_FILE"
  chmod 0600 "$TSIG_SECRET_FILE"
  echo "[tsig-init] Secret written to ${TSIG_SECRET_FILE}."
fi

# ── Step 2: Determine the hermithost-net subnet at runtime ───────────────────
# The network name in docker compose is hermithost_hermithost-net.
# We use docker network inspect to get the actual CIDR rather than hardcoding.
HERMITHOST_NET_SUBNET=""
for NET_NAME in hermithost_hermithost-net hermithost-net; do
  if docker network inspect "$NET_NAME" --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' >/dev/null 2>&1; then
    HERMITHOST_NET_SUBNET="$(docker network inspect "$NET_NAME" --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null || true)"
    if [ -n "$HERMITHOST_NET_SUBNET" ]; then
      echo "[tsig-init] Detected hermithost-net subnet: ${HERMITHOST_NET_SUBNET}"
      break
    fi
  fi
done

if [ -z "$HERMITHOST_NET_SUBNET" ]; then
  # Fallback: use the broad Docker bridge range but warn loudly
  HERMITHOST_NET_SUBNET="172.16.0.0/12"
  echo "[tsig-init] WARNING: Could not detect hermithost-net subnet. Falling back to ${HERMITHOST_NET_SUBNET}."
  echo "[tsig-init] To narrow the ACL, ensure the 'docker' command is available and the stack is running."
fi

# Loopback is included so Traefik (running inside the container stack) can update via 127.0.0.1
# when the compose network routes through the host stack.
UPDATE_ACL="${HERMITHOST_NET_SUBNET},127.0.0.0/8"

# ── Step 3: Register the TSIG key in Technitium ───────────────────────────────
# Format: tsigKeys=keyName|sharedSecret|algorithmName (pipe-delimited, from Technitium web UI).
# Key name is stored WITHOUT trailing dot; Technitium normalizes it internally.
echo "[tsig-init] Registering TSIG key '${TSIG_KEY_NAME}' in Technitium..."
TSIG_REGISTER_RESULT="$(
  curl -sf -X POST "${TECHNITIUM_URL}/api/settings/set" \
    --data-urlencode "token=${TECHNITIUM_TOKEN}" \
    --data-urlencode "tsigKeys=${TSIG_KEY_NAME}|${TSIG_SECRET}|${TSIG_ALGORITHM}" \
    2>/dev/null
)"
TSIG_STATUS="$(echo "$TSIG_REGISTER_RESULT" | grep -o '"status":"[^"]*"' | cut -d'"' -f4 || echo "unknown")"
if [ "$TSIG_STATUS" != "ok" ]; then
  echo "[tsig-init] ERROR: Failed to register TSIG key. Response: ${TSIG_REGISTER_RESULT}"
  exit 1
fi
echo "[tsig-init] TSIG key registered successfully."

# ── Step 4: Configure zone update permissions ─────────────────────────────────
# - update mode: UseSpecifiedNetworkACL (v15 name for subnet-restricted updates)
# - updateNetworkACL: hermithost-net subnet + loopback
# - updateSecurityPolicies: require TSIG signature matching the registered key,
#   allow TXT record type only (DNS-01 only needs TXT), domain=*.${ZONE}.
#   The wildcard domain *.${ZONE}. covers _acme-challenge.<host>.<zone> records.
echo "[tsig-init] Configuring zone '${ZONE}' update permissions..."
ZONE_SET_RESULT="$(
  curl -sf -X POST "${TECHNITIUM_URL}/api/zones/options/set" \
    --data-urlencode "token=${TECHNITIUM_TOKEN}" \
    --data-urlencode "zone=${ZONE}" \
    --data-urlencode "update=UseSpecifiedNetworkACL" \
    --data-urlencode "updateNetworkACL=${UPDATE_ACL}" \
    --data-urlencode "updateSecurityPolicies=${TSIG_KEY_NAME}|*.${ZONE}.|TXT" \
    2>/dev/null
)"
ZONE_STATUS="$(echo "$ZONE_SET_RESULT" | grep -o '"status":"[^"]*"' | cut -d'"' -f4 || echo "unknown")"
if [ "$ZONE_STATUS" != "ok" ]; then
  echo "[tsig-init] ERROR: Failed to configure zone permissions. Response: ${ZONE_SET_RESULT}"
  exit 1
fi
echo "[tsig-init] Zone '${ZONE}' configured: UseSpecifiedNetworkACL, ACL=${UPDATE_ACL}, TSIG policy=TXT."

# ── Step 5: Write the manifest ────────────────────────────────────────────────
cat > "$TSIG_MANIFEST_FILE" << MANIFEST_EOF
{
  "keyName": "${TSIG_KEY_NAME}",
  "algorithm": "${TSIG_ALGORITHM}",
  "zone": "${ZONE}",
  "subnet": "${HERMITHOST_NET_SUBNET}",
  "updateMode": "UseSpecifiedNetworkACL"
}
MANIFEST_EOF
echo "[tsig-init] Manifest written to ${TSIG_MANIFEST_FILE}."

echo "[tsig-init] TSIG bootstrap complete."
echo "[tsig-init]   Key name  : ${TSIG_KEY_NAME}"
echo "[tsig-init]   Algorithm : ${TSIG_ALGORITHM}"
echo "[tsig-init]   Zone      : ${ZONE}."
echo "[tsig-init]   Update ACL: ${UPDATE_ACL}"
echo "[tsig-init]   Policy    : TXT records on *.${ZONE}."
