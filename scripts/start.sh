#!/bin/sh
# Ensure the external coolify network exists, then start the stack.
# The coolify network is external so docker compose down doesn't destroy it
# and take deployed site containers offline.
#
# Profile selection:
#   HERMITHOST_PORT_MODE=lan      → passes --profile internal (activates step-ca + step-ca-init)
#   HERMITHOST_PORT_MODE=internet → no profile (uses Let's Encrypt)
#   unset                         → no profile (safe default)
#
# Idempotent: docker compose up is a no-op for already-running services.

docker network inspect coolify >/dev/null 2>&1 || docker network create coolify

# Load only the specific vars needed from .env — do NOT export the entire file.
# Broad export (set -a / source) would leak COOKIE_SECRET, HERMITHOST_PASSWORD,
# COOLIFY_DB_PASSWORD, etc. into docker compose up env. SEC-S4.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."
if [ -f "$ROOT/.env" ]; then
  HERMITHOST_PORT_MODE="$(grep -E '^HERMITHOST_PORT_MODE=' "$ROOT/.env" | cut -d'=' -f2- | tr -d '[:space:]' || true)"
  RFC2136_TSIG_SECRET_FILE="$(grep -E '^RFC2136_TSIG_SECRET_FILE=' "$ROOT/.env" | cut -d'=' -f2- | tr -d '[:space:]' || true)"
fi

PROFILE_ARG=""
if [ "${HERMITHOST_PORT_MODE:-}" = "lan" ]; then
  PROFILE_ARG="--profile internal"
  echo "[start] LAN mode detected — activating internal CA profile (step-ca)"

  # ── RFC2136 TSIG secret (read from volume; Traefik consumes in DNS-01 flow) ──
  # The secret lives exclusively inside the coolify-api-token Docker volume.
  # It is never written to or read from the host filesystem (SEC-S1).
  # We use `docker run --rm` with the volume mounted to read it at start time.
  # Fail closed: missing or empty secret aborts startup — DNS-01 cannot work without it.
  TSIG_VOLUME_PATH="${RFC2136_TSIG_SECRET_FILE:-/coolify-api-token/rfc2136_tsig.secret}"
  TSIG_VOLUME_NAME="coolify-api-token"
  TSIG_VOLUME_DIR="$(dirname "$TSIG_VOLUME_PATH")"
  if ! docker volume inspect "$TSIG_VOLUME_NAME" >/dev/null 2>&1; then
    echo "[start] ERROR: Docker volume '${TSIG_VOLUME_NAME}' not found."
    echo "[start]   Run 'bash scripts/setup.sh' to initialise the stack and provision the TSIG key."
    echo "[start]   If you need to rotate the key, run 'bash scripts/rotate-tsig.sh'."
    exit 1
  fi
  RFC2136_TSIG_SECRET="$(
    docker run --rm \
      -v "${TSIG_VOLUME_NAME}:${TSIG_VOLUME_DIR}:ro" \
      alpine sh -c "cat '${TSIG_VOLUME_PATH}' 2>/dev/null" 2>/dev/null || true
  )"
  if [ -z "$RFC2136_TSIG_SECRET" ]; then
    echo "[start] ERROR: RFC2136 TSIG secret not found or empty in volume '${TSIG_VOLUME_NAME}' at '${TSIG_VOLUME_PATH}'."
    echo "[start]   Run 'bash scripts/setup.sh' with the stack running to bootstrap the TSIG key."
    echo "[start]   If the key was rotated, run 'bash scripts/rotate-tsig.sh'."
    exit 1
  fi
  export RFC2136_TSIG_SECRET
  echo "[start] RFC2136_TSIG_SECRET loaded from volume ${TSIG_VOLUME_NAME}."
fi

# shellcheck disable=SC2086
exec docker compose $PROFILE_ARG up "$@"
