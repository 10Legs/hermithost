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

# Load .env from project root so PORT_MODE is available even when start.sh is
# invoked directly (outside of a shell that already sourced .env).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."
if [ -f "$ROOT/.env" ]; then
  # shellcheck disable=SC1091
  set -a
  . "$ROOT/.env"
  set +a
fi

PROFILE_ARG=""
if [ "${HERMITHOST_PORT_MODE:-}" = "lan" ]; then
  PROFILE_ARG="--profile internal"
  echo "[start] LAN mode detected — activating internal CA profile (step-ca)"

  # ── RFC2136 TSIG secret (Phase 1: read and export; Phase 2: Traefik consumes) ──
  # The secret lives exclusively inside the coolify-api-token Docker volume.
  # It is never written to or read from the host filesystem (SEC-S1).
  # We use `docker run --rm` with the volume mounted to read it at start time.
  TSIG_VOLUME_PATH="${RFC2136_TSIG_SECRET_FILE:-/coolify-api-token/rfc2136_tsig.secret}"
  TSIG_VOLUME_NAME="coolify-api-token"
  TSIG_FILE_IN_VOLUME="$(basename "$TSIG_VOLUME_PATH")"
  TSIG_VOLUME_DIR="$(dirname "$TSIG_VOLUME_PATH")"
  if docker volume inspect "$TSIG_VOLUME_NAME" >/dev/null 2>&1; then
    RFC2136_TSIG_SECRET="$(
      docker run --rm \
        -v "${TSIG_VOLUME_NAME}:${TSIG_VOLUME_DIR}:ro" \
        alpine sh -c "cat '${TSIG_VOLUME_PATH}' 2>/dev/null" 2>/dev/null || true
    )"
    if [ -n "$RFC2136_TSIG_SECRET" ]; then
      export RFC2136_TSIG_SECRET
      echo "[start] RFC2136_TSIG_SECRET loaded from volume ${TSIG_VOLUME_NAME}."
    else
      echo "[start] WARNING: RFC2136 TSIG secret not found in volume ${TSIG_VOLUME_NAME} at ${TSIG_VOLUME_PATH}."
      echo "[start]   Run 'bash scripts/setup.sh' with the stack running to bootstrap the TSIG key."
      echo "[start]   DNS-01 certificate issuance will not work until the key is provisioned."
    fi
  else
    echo "[start] WARNING: Docker volume '${TSIG_VOLUME_NAME}' not found. TSIG secret unavailable."
    echo "[start]   Run 'bash scripts/setup.sh' to initialise the stack and provision the TSIG key."
  fi
fi

# shellcheck disable=SC2086
exec docker compose $PROFILE_ARG up "$@"
