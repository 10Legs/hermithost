#!/bin/sh
# step-ca-init.sh — one-shot CA bootstrap for HermitHost internal mode.
# Runs as an init container; idempotent (safe to restart or re-run).
# Outputs root CA cert to /home/step/certs/root_ca.crt for Traefik + API.

set -e

export STEPPATH=/home/step

# ── Idempotency check ─────────────────────────────────────────────────────────
if [ -f "$STEPPATH/config/ca.json" ]; then
  echo "[step-ca-init] CA already initialized — nothing to do."
  exit 0
fi

echo "[step-ca-init] Initializing HermitHost CA (this runs once)..."

# Need jq to patch ca.json after init
apk add --no-cache jq -q 2>/dev/null

# Write a stable CA key password to a temp file.
# Not a secret — this CA only issues certs for .hh (homelab) and is
# never exported or used outside the local network.
CA_PASS="hermithost-internal-ca-key"
mkdir -p "$STEPPATH/secrets"
echo "$CA_PASS" > "$STEPPATH/secrets/password"

# ── Initialize root + intermediate CA ────────────────────────────────────────
step ca init \
  --name="HermitHost CA" \
  --dns="step-ca" \
  --address=":9000" \
  --provisioner="hermithost-admin" \
  --password-file="$STEPPATH/secrets/password" \
  --deployment-type=standalone

# ── Add ACME provisioner with 90-day cert lifetime ────────────────────────────
# The default JWK provisioner stays but is unused; Traefik will use 'acme'.
# 90 days (2160h) balances security and homelab convenience.
jq '.authority.provisioners += [{
  "type": "ACME",
  "name": "acme",
  "forceCN": false,
  "claims": {
    "defaultTLSCertDuration": "2160h",
    "maxTLSCertDuration": "8760h",
    "minTLSCertDuration": "5m"
  }
}]' "$STEPPATH/config/ca.json" > /tmp/ca.json.tmp \
  && mv /tmp/ca.json.tmp "$STEPPATH/config/ca.json"

# Fix ownership so step-ca (uid 1000) can read all files
chown -R 1000:1000 "$STEPPATH"

echo "[step-ca-init] ACME provisioner added (name: acme, 90-day certs)"
echo "[step-ca-init] Root CA: $STEPPATH/certs/root_ca.crt"
echo "[step-ca-init] Done."
