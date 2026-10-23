#!/usr/bin/env bash
# Deploy a commit from origin/main to this host, recreating only the named services.
#
# Usage:
#   scripts/deploy.sh plan <sha> [auto | <service>...]
#   scripts/deploy.sh deploy <sha> [auto | <service>...]
#   scripts/deploy.sh rollback <previous-sha> <service>...
#   scripts/deploy.sh status
#
# plan:     read-only; prints what `deploy` would do (git fetch is its only side effect).
# deploy:   fast-forwards the checkout to <sha> (must be on origin/main), tags the
#           images currently running for each service as <image>:prev-<old-sha>,
#           builds and recreates ONLY those services (--no-deps), waits for them to
#           be healthy, then smoke-tests DEPLOY_SMOKE_URLS from .env.
#           "auto" derives the services from the files changed between the
#           current checkout and <sha>: build contexts, bind-mounted repo paths,
#           and services whose resolved docker-compose.yml definition changed.
# rollback: resets the checkout to <previous-sha> and re-points each service at
#           the :prev-<previous-sha> image tagged by the deploy that replaced it.
#
# Never touches volumes, networks, or one-shot init services, and never runs
# `docker compose down`.
#
# Designed to also run as an SSH forced command (authorized_keys command="...");
# the requested arguments are then read from SSH_ORIGINAL_COMMAND and split on
# whitespace without shell evaluation. With DEPLOY_READONLY=1 in the forced
# command, only `plan` and `status` are allowed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
cd "$ROOT"

# One-shot / bootstrap services must never be (re)started by a deploy.
DENY_SERVICES="coolify-keys-init coolify-server-setup sites-restore step-ca-init"
HEALTH_TIMEOUT="${DEPLOY_HEALTH_TIMEOUT:-180}"

log() { echo "[deploy] $*"; }
die() { echo "[deploy] ERROR: $*" >&2; exit 1; }

# Load only the specific vars needed from .env — do NOT export the entire file (SEC-S4).
env_get() {
  [ -f "$ROOT/.env" ] || return 0
  grep -E "^$1=" "$ROOT/.env" | tail -n1 | cut -d'=' -f2- | sed -e 's/^"//' -e 's/"$//' || true
}
COMPOSE_PROJECT_NAME="$(env_get COMPOSE_PROJECT_NAME | tr -d '[:space:]')"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-hermithost}"
HERMITHOST_PORT_MODE="$(env_get HERMITHOST_PORT_MODE | tr -d '[:space:]')"
DEPLOY_SMOKE_URLS="$(env_get DEPLOY_SMOKE_URLS)"
DEPLOY_SMOKE_CACERT="$(env_get DEPLOY_SMOKE_CACERT | tr -d '[:space:]')"

PROFILE_ARGS=()
if [ "$HERMITHOST_PORT_MODE" = "lan" ]; then PROFILE_ARGS=(--profile internal); fi
dc() { docker compose -p "$COMPOSE_PROJECT_NAME" "${PROFILE_ARGS[@]}" "$@"; }

# ── Arguments (SSH forced command or argv) ───────────────────────────────────
if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  # shellcheck disable=SC2086  # intentional word split; globbing disabled
  set -f; set -- $SSH_ORIGINAL_COMMAND; set +f
fi
for a in "$@"; do
  [[ "$a" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid argument: '$a'"
done
MODE="${1:-}"; shift || true
if [ "${DEPLOY_READONLY:-0}" = "1" ] && [ "$MODE" != "plan" ] && [ "$MODE" != "status" ]; then
  die "this key is read-only (plan/status); '$MODE' refused"
fi

# ── Compose config helpers ───────────────────────────────────────────────────
# CFG holds the resolved compose config (JSON) that the deploy targets.
CFG=""

# compose_json <compose-file>: resolved config, interpolated with this checkout's .env.
compose_json() {
  docker compose -f "$1" --project-directory "$ROOT" -p "$COMPOSE_PROJECT_NAME" \
    "${PROFILE_ARGS[@]}" config --format json
}

# load_cfg <commit>: CFG := resolved docker-compose.yml as of <commit>.
load_cfg() {
  local tmp
  tmp="$(mktemp --suffix=.yml)"
  git show "$1:docker-compose.yml" >"$tmp" || { rm -f "$tmp"; die "cannot read docker-compose.yml at $1"; }
  CFG="$(compose_json "$tmp")" || { rm -f "$tmp"; die "docker compose config failed for $1"; }
  rm -f "$tmp"
}

cfg_services() { jq -r '.services | keys[]' <<<"$CFG"; }
has_build()    { jq -e --arg s "$1" '.services[$s].build != null' <<<"$CFG" >/dev/null; }

# image_ref <svc>: the image reference compose runs for <svc> (always with a tag).
image_ref() {
  local ref
  ref="$(jq -r --arg s "$1" --arg p "$COMPOSE_PROJECT_NAME" '.services[$s].image // ($p + "-" + $s)' <<<"$CFG")"
  [[ "$ref" =~ :[^/]+$ ]] || ref="${ref}:latest"
  echo "$ref"
}
# image_repo <ref>: <ref> without its tag (registry ports are kept).
image_repo() { local r="$1"; [[ "$r" =~ ^(.*):[^/]+$ ]] && r="${BASH_REMATCH[1]}"; echo "$r"; }

is_denied() { local d; for d in $DENY_SERVICES; do [ "$1" = "$d" ] && return 0; done; return 1; }

validate_services() {
  local known s
  known="$(cfg_services)"
  for s in "$@"; do
    grep -qxF "$s" <<<"$known" || die "unknown service: $s"
    if is_denied "$s"; then die "refusing to deploy one-shot service: $s"; fi
  done
  return 0
}

# auto_services <old> <new>: services affected by the change. CFG must be <new>'s.
#   - a file changed inside the service's build context
#   - a file changed inside a repo path bind-mounted into the service
#   - the service's resolved compose definition differs between <old> and <new>
auto_services() {
  local old="$1" new="$2" changed svc path old_cfg out=()
  # --no-renames: report both sides of a move (a file moved out of a context counts).
  changed="$(git diff --name-only --no-renames "$old" "$new")" || return 1
  [ -n "$changed" ] || return 0

  local old_tmp
  old_tmp="$(mktemp --suffix=.yml)"
  git show "$old:docker-compose.yml" >"$old_tmp" || { rm -f "$old_tmp"; return 1; }
  old_cfg="$(compose_json "$old_tmp")" || { rm -f "$old_tmp"; return 1; }
  rm -f "$old_tmp"

  while read -r svc; do
    if is_denied "$svc"; then continue; fi

    # Build context and bind-mount sources, as repo-relative paths.
    while read -r path; do
      [ -n "$path" ] || continue
      case "$path" in
        "$ROOT")   path="" ;;
        "$ROOT"/*) path="${path#"$ROOT"/}" ;;
        *)         continue ;;   # outside the repo (host paths, docker socket)
      esac
      # Traefik's file provider watches traefik/conf.d and reloads it live; route
      # changes there never need a container restart.
      [ "$path" = "traefik/conf.d" ] && continue
      if [ -z "$path" ]; then
        # Root build context (frontend): only the SvelteKit app inputs count.
        if grep -qE '^(src/|static/|package(-lock)?\.json$|svelte\.config\.js$|vite\.config\.ts$|tsconfig\.json$|Dockerfile$)' <<<"$changed"; then
          out+=("$svc")
        fi
      elif grep -qE "^${path//./\\.}(/|$)" <<<"$changed"; then
        out+=("$svc")
      fi
    done < <(jq -r --arg s "$svc" '.services[$s] | (.build.context // empty), ((.volumes // [])[] | select(.type == "bind") | .source)' <<<"$CFG")

    if [ "$(jq -S --arg s "$svc" '.services[$s]' <<<"$old_cfg")" != "$(jq -S --arg s "$svc" '.services[$s]' <<<"$CFG")" ]; then
      out+=("$svc")
    fi
  done < <(cfg_services)

  if [ "${#out[@]}" -gt 0 ]; then printf '%s\n' "${out[@]}" | sort -u; fi
}

# ── Verification ─────────────────────────────────────────────────────────────
wait_healthy() {
  local svc="$1" cid status="" health="" restarts0 waited=0
  while :; do
    cid="$(dc ps -q "$svc" | head -n1)"
    if [ -n "$cid" ]; then
      status="$(docker inspect -f '{{.State.Status}}' "$cid")"
      health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid")"
      if [ "$health" = "healthy" ]; then log "  $svc: healthy"; return 0; fi
      if [ "$health" = "none" ] && [ "$status" = "running" ]; then
        restarts0="$(docker inspect -f '{{.RestartCount}}' "$cid")"
        sleep 15
        if [ "$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$cid")" = "running $restarts0" ]; then
          log "  $svc: running (no healthcheck, stable 15s)"; return 0
        fi
      fi
    fi
    if [ "$waited" -ge "$HEALTH_TIMEOUT" ]; then
      log "  $svc: NOT healthy after ${HEALTH_TIMEOUT}s (status=${status:-missing} health=${health:-n/a})"
      return 1
    fi
    sleep 3; waited=$((waited + 3))
  done
}

# Each URL must answer 2xx after following redirects, with a verified certificate
# (DEPLOY_SMOKE_CACERT points at a CA bundle for internal-CA hosts in LAN mode).
smoke_test() {
  local url code rc=0 urls
  local curl_args=(-sS -L -o /dev/null -w '%{http_code}' --max-time 15)
  [ -n "$DEPLOY_SMOKE_CACERT" ] && curl_args+=(--cacert "$DEPLOY_SMOKE_CACERT")
  read -r -a urls <<<"$DEPLOY_SMOKE_URLS"   # word split only; no globbing
  if [ "${#urls[@]}" -eq 0 ]; then log "smoke: DEPLOY_SMOKE_URLS not set in .env — skipped"; return 0; fi
  for url in "${urls[@]}"; do
    code="$(curl "${curl_args[@]}" "$url" 2>/dev/null)" || code="${code:-000}"
    if [[ "$code" =~ ^2 ]]; then log "  smoke $url → $code"; else log "  smoke $url → $code FAILED"; rc=1; fi
  done
  return "$rc"
}

verify() {
  local svc rc=0
  log "Waiting for services (timeout ${HEALTH_TIMEOUT}s)..."
  for svc in "$@"; do wait_healthy "$svc" || rc=1; done
  smoke_test || rc=1
  return "$rc"
}

lock() {
  exec 9>"/var/lock/hermithost-deploy-${COMPOSE_PROJECT_NAME}.lock"
  flock -n 9 || die "another deploy is already running for '${COMPOSE_PROJECT_NAME}'"
}

require_clean_main() {
  [ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "checkout is not on main"
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die "working tree has local modifications — refusing to deploy"
}

# ── Modes ────────────────────────────────────────────────────────────────────
# The whole dispatch is one brace group ending in `exit`, so bash parses it in
# full before running it. `git merge`/`git reset` below may rewrite this very
# file, and bash would otherwise keep reading the script from its old offset.
{
case "$MODE" in
  status)
    log "project=$COMPOSE_PROJECT_NAME mode=${HERMITHOST_PORT_MODE:-unset} head=$(git rev-parse --short HEAD) branch=$(git rev-parse --abbrev-ref HEAD)"
    dc ps --format 'table {{.Service}}\t{{.Status}}'
    ;;

  deploy|plan)
    TARGET="${1:-}"; shift || true
    [[ "$TARGET" =~ ^[0-9a-f]{7,40}$ ]] || die "usage: $MODE <sha> [auto | <service>...]"
    if [ "$MODE" = "deploy" ]; then lock; fi
    require_clean_main
    git fetch --quiet origin main
    NEW="$(git rev-parse --verify --quiet "${TARGET}^{commit}")" || die "unknown commit: $TARGET"
    git merge-base --is-ancestor "$NEW" origin/main || die "$TARGET is not on origin/main"
    OLD="$(git rev-parse HEAD)"
    git merge-base --is-ancestor "$OLD" "$NEW" || die "$TARGET is not a fast-forward of the current checkout ($(git rev-parse --short HEAD))"

    load_cfg "$NEW"
    SERVICES=()
    if [ $# -eq 0 ] || [ "$1" = "auto" ]; then
      detected="$(auto_services "$OLD" "$NEW")" || die "service detection failed — pass services explicitly"
      if [ -n "$detected" ]; then mapfile -t SERVICES <<<"$detected"; fi
    else
      SERVICES=("$@")
    fi
    log "$(git rev-parse --short "$OLD") → $(git rev-parse --short "$NEW") ; services: ${SERVICES[*]:-(none)}"
    if [ "${#SERVICES[@]}" -gt 0 ]; then validate_services "${SERVICES[@]}"; fi

    if [ "$MODE" = "plan" ]; then
      git log --oneline "$OLD..$NEW" | sed 's/^/[deploy]   /'
      exit 0
    fi

    if [ "${#SERVICES[@]}" -eq 0 ]; then
      if [ "$OLD" != "$NEW" ]; then git merge --ff-only --quiet "$NEW"; fi
      log "No service changes — checkout updated, nothing recreated."
      exit 0
    fi

    # Keep the currently running images addressable for rollback.
    PREV_TAG="prev-${OLD:0:12}"
    for svc in "${SERVICES[@]}"; do
      cid="$(dc ps -q "$svc" | head -n1)"
      if [ -n "$cid" ]; then
        repo="$(image_repo "$(image_ref "$svc")")"
        docker tag "$(docker inspect -f '{{.Image}}' "$cid")" "${repo}:${PREV_TAG}"
        log "Tagged running $svc image as ${repo}:${PREV_TAG}"
      fi
    done

    git merge --ff-only --quiet "$NEW"

    BUILD=()
    for svc in "${SERVICES[@]}"; do
      if has_build "$svc"; then BUILD+=("$svc"); fi
    done
    if [ "${#BUILD[@]}" -gt 0 ]; then
      log "Building: ${BUILD[*]}"
      if ! dc build "${BUILD[@]}"; then
        # A partial build may already have moved some :latest tags — put them back.
        for svc in "${BUILD[@]}"; do
          ref="$(image_ref "$svc")"; repo="$(image_repo "$ref")"
          if docker image inspect "${repo}:${PREV_TAG}" >/dev/null 2>&1; then
            docker tag "${repo}:${PREV_TAG}" "$ref"
          fi
        done
        git reset --quiet --hard "$OLD"
        die "build failed — images and checkout restored to $(git rev-parse --short "$OLD"); nothing was recreated"
      fi
    fi

    log "Recreating: ${SERVICES[*]}"
    if dc up -d --no-deps --no-build "${SERVICES[@]}" && verify "${SERVICES[@]}"; then
      log "OK — deployed $(git rev-parse --short HEAD)"
    else
      log "FAILED. To roll back:"
      log "  scripts/deploy.sh rollback ${OLD:0:12} ${SERVICES[*]}"
      exit 1
    fi
    ;;

  rollback)
    TARGET="${1:-}"; shift || true
    { [[ "$TARGET" =~ ^[0-9a-f]{7,40}$ ]] && [ $# -gt 0 ]; } || die "usage: rollback <previous-sha> <service>..."
    lock
    require_clean_main
    PREV="$(git rev-parse --verify --quiet "${TARGET}^{commit}")" || die "unknown commit: $TARGET"
    git merge-base --is-ancestor "$PREV" HEAD || die "$TARGET is not an ancestor of the current checkout"
    load_cfg "$PREV"
    validate_services "$@"
    PREV_TAG="prev-${PREV:0:12}"
    for svc in "$@"; do
      repo="$(image_repo "$(image_ref "$svc")")"
      docker image inspect "${repo}:${PREV_TAG}" >/dev/null 2>&1 || die "no ${repo}:${PREV_TAG} image to roll back to"
    done
    git reset --quiet --hard "$PREV"
    for svc in "$@"; do
      ref="$(image_ref "$svc")"; repo="$(image_repo "$ref")"
      docker tag "${repo}:${PREV_TAG}" "$ref"
      log "Re-pointed $ref at ${repo}:${PREV_TAG}"
    done
    dc up -d --no-deps --no-build "$@"
    verify "$@" || die "rollback verification failed — investigate manually"
    log "OK — rolled back to $(git rev-parse --short HEAD)"
    ;;

  *)
    die "usage: deploy.sh {plan|deploy <sha> [auto|<service>...] | rollback <previous-sha> <service>... | status}"
    ;;
esac
exit
}
