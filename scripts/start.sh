#!/usr/bin/env bash
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

# ── Flag matrix ──────────────────────────────────────────────────────────────
BOOTSTRAP_FORCE=0
BOOTSTRAP_MODE=0
NO_BOOTSTRAP=0
_PASSTHROUGH_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --bootstrap)      BOOTSTRAP_MODE=1 ;;
    --force)          BOOTSTRAP_FORCE=1 ;;
    --no-bootstrap)   NO_BOOTSTRAP=1 ;;
    *)                _PASSTHROUGH_ARGS+=("$arg") ;;
  esac
done
set -- "${_PASSTHROUGH_ARGS[@]}"

docker network inspect coolify >/dev/null 2>&1 || docker network create coolify

# Load only the specific vars needed from .env — do NOT export the entire file.
# Broad export (set -a / source) would leak COOKIE_SECRET, HERMITHOST_PASSWORD,
# COOLIFY_DB_PASSWORD, etc. into docker compose up env. SEC-S4.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."
if [ -f "$ROOT/.env" ]; then
  HERMITHOST_PORT_MODE="$(grep -E '^HERMITHOST_PORT_MODE=' "$ROOT/.env" | cut -d'=' -f2- | tr -d '[:space:]' || true)"
  RFC2136_TSIG_SECRET_FILE="$(grep -E '^RFC2136_TSIG_SECRET_FILE=' "$ROOT/.env" | cut -d'=' -f2- | tr -d '[:space:]' || true)"
  COMPOSE_PROJECT_NAME="$(grep -E '^COMPOSE_PROJECT_NAME=' "$ROOT/.env" | cut -d'=' -f2- | tr -d '[:space:]' || true)"
fi
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-hermithost}"

# ── Race condition guard (Linux only; gracefully skipped on macOS) ────────────
if command -v flock >/dev/null 2>&1; then
  LOCK_FILE="/var/lock/hermithost-${COMPOSE_PROJECT_NAME}.lock"
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    echo "[start] ERROR: Another start.sh is already running for project '${COMPOSE_PROJECT_NAME}'. Aborting."
    exit 1
  fi
fi

PROFILE_ARG=""

# ── Migrate stale per-site Traefik route files (Phase 4 fix) ──────────────────
# Pre-Phase-4 route files emitted certresolver: internal-ca + domains per host,
# causing every site router to independently trigger a DNS-01 wildcard challenge.
# wildcard-internal.yml now owns the single *.hh cert acquisition. Site route
# files must only carry `tls: {}` so Traefik matches the pre-fetched cert by SNI.
#
# This migration is only needed in LAN mode — internet mode uses letsencrypt and
# never emits tls.domains on site routes.
if [ "${HERMITHOST_PORT_MODE:-}" = "lan" ]; then
  TRAEFIK_CONF="${ROOT}/traefik/conf.d"
  for f in "$TRAEFIK_CONF"/site-*.yml; do
    [ -f "$f" ] || continue
    if grep -q 'certResolver\|certresolver' "$f" 2>/dev/null; then
      echo "[start] Migrating stale wildcard cert config in: $f"
      # Replace the 3-line tls block (certResolver + domains + main) with bare tls: {}
      # Pattern covers both Phase-4 and any earlier variant that set certResolver directly.
      # sed -i '' is required on macOS (BSD sed); -i alone works on GNU sed.
      sed -i '' \
        -e '/certResolver:/d' \
        -e '/certresolver:/d' \
        -e '/domains:/d' \
        -e '/- main:/d' \
        -e 's/^      tls:$/      tls: {}/' \
        "$f"
      echo "[start]   Done: $f"
    fi
  done
fi

if [ "${HERMITHOST_PORT_MODE:-}" = "lan" ]; then
  PROFILE_ARG="--profile internal"
  echo "[start] LAN mode detected — activating internal CA profile (step-ca)"

  # ── RFC2136 TSIG bootstrap auto-detection ────────────────────────────────────
  # Four-state detection determines whether this is a first-time setup, a broken
  # partial state, or a normal start with an existing TSIG secret.
  # Flags --bootstrap / --force / --no-bootstrap allow operator override.
  TSIG_VOLUME_NAME="coolify-api-token"
  TSIG_VOLUME_PATH="${RFC2136_TSIG_SECRET_FILE:-/coolify-api-token/rfc2136_tsig.secret}"

  CONTAINER_COUNT=$(docker ps -a \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
    --format '{{.ID}}' 2>/dev/null | wc -l | tr -d ' ')

  TSIG_SECRET=""
  if docker volume inspect "$TSIG_VOLUME_NAME" >/dev/null 2>&1; then
    TSIG_SECRET="$(docker run --rm \
      -v "${TSIG_VOLUME_NAME}:/coolify-api-token:ro" \
      alpine sh -c "cat '${TSIG_VOLUME_PATH}' 2>/dev/null | tr -d '\n\r '" 2>/dev/null || true)"
  fi

  if [ "$NO_BOOTSTRAP" = "1" ]; then
    # --no-bootstrap: always fail-closed; CI/prod safety path
    if [ -z "$TSIG_SECRET" ]; then
      echo "[start] ERROR: --no-bootstrap set and TSIG secret is missing. Aborting."
      echo "[start]   Run 'bash scripts/setup.sh' with the stack running to provision the key."
      exit 1
    fi
  elif [ "$BOOTSTRAP_MODE" = "1" ]; then
    # --bootstrap: operator forces bootstrap path (required for Case B override)
    if [ "$CONTAINER_COUNT" -gt 0 ] && [ "$BOOTSTRAP_FORCE" != "1" ]; then
      echo "[start] ERROR: Containers already exist for project '${COMPOSE_PROJECT_NAME}'."
      echo "[start]   Pass --bootstrap --force to acknowledge destructive intent."
      exit 1
    fi
    echo "[start] Bootstrap mode forced by --bootstrap flag. TSIG will be provisioned by setup.sh after stack starts."
    BOOTSTRAP_MODE=1
  elif [ "$CONTAINER_COUNT" -eq 0 ] && [ -z "$TSIG_SECRET" ]; then
    # Case A: no containers AND no secret — first-time setup, auto-bootstrap
    echo "[start] New project detected — entering bootstrap mode. TSIG will be provisioned by setup.sh after stack starts."
    BOOTSTRAP_MODE=1
  elif [ "$CONTAINER_COUNT" -gt 0 ] && [ -z "$TSIG_SECRET" ]; then
    # Case B: containers exist but secret missing — broken partial state
    echo "[start] ERROR: Partial state — containers exist for project '${COMPOSE_PROJECT_NAME}' but TSIG secret is missing."
    echo "[start]   A prior bootstrap likely failed. Options:"
    echo "[start]     ./scripts/start.sh --bootstrap --force   (re-bootstrap, destroys existing state)"
    echo "[start]     docker compose down -v && re-run start.sh (clean and retry)"
    exit 1
  fi

  # Cases C/D: secret exists — load it and continue
  if [ -z "${BOOTSTRAP_MODE+x}" ] || [ "$BOOTSTRAP_MODE" != "1" ]; then
    export RFC2136_TSIG_SECRET="$TSIG_SECRET"
    echo "[start] RFC2136_TSIG_SECRET loaded from volume ${TSIG_VOLUME_NAME}."
  fi
fi

# shellcheck disable=SC2086
exec docker compose $PROFILE_ARG up "$@"
