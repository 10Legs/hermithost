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
  # The secret is generated once by setup.sh / conf.d/technitium-tsig-init.sh and
  # persisted in the coolify-api-token volume. We read it here so that Phase 2 can
  # reference RFC2136_TSIG_SECRET in docker-compose.yml without storing it in .env.
  TSIG_SECRET_FILE="${RFC2136_TSIG_SECRET_FILE:-/coolify-api-token/rfc2136_tsig.secret}"
  if [ -f "$TSIG_SECRET_FILE" ]; then
    RFC2136_TSIG_SECRET="$(cat "$TSIG_SECRET_FILE")"
    export RFC2136_TSIG_SECRET
    echo "[start] RFC2136_TSIG_SECRET loaded from ${TSIG_SECRET_FILE}."
  else
    echo "[start] WARNING: RFC2136 TSIG secret file not found at ${TSIG_SECRET_FILE}."
    echo "[start]   Run 'bash scripts/setup.sh' with the stack running to bootstrap the TSIG key."
    echo "[start]   DNS-01 certificate issuance will not work until the key is provisioned."
  fi
fi

# shellcheck disable=SC2086
exec docker compose $PROFILE_ARG up "$@"
