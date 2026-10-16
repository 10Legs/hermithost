#!/usr/bin/env bash
# Live end-to-end test for the site route reconciler (#126, #127).
#
# Builds a throwaway, fully isolated environment (everything is named hhtest-*):
#   - real Traefik (file provider) on network hhtest-coolify
#   - real docker-proxy sidecar built from this repo (COOLIFY_NETWORK_NAME=hhtest-coolify)
#   - two "sites" (nginx) labelled like Coolify apps, stranded on hhtest-legacy
#     (stands in for the legacy bare `coolify` network):
#       nixsite01  — nixpacks-style (coolify.name label), legacy raw-name route file
#       cmpsite01  — dockercompose-style (compose project/service labels), no route file
# Then runs the compiled reconciler (api/dist) against it and asserts, via HTTPS
# through Traefik, that drift produces 502/404 and a reconcile pass restores 200 —
# including after Coolify-style container recreation.
#
# Usage: scripts/test/route-drift-harness.sh     (needs docker; removes only hhtest-*)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
P=hhtest
CONF="$(mktemp -d)"
PASS=0; FAIL=0

cleanup_docker() {
  docker rm -f ${P}-traefik ${P}-docker-proxy ${P}-nixsite01-a ${P}-nixsite01-b app-cmpsite01-1 app-cmpsite01-2 >/dev/null 2>&1 || true
  docker network rm ${P}-coolify ${P}-legacy ${P}-ctl >/dev/null 2>&1 || true
}
trap 'cleanup_docker; rm -rf "$CONF"' EXIT
cleanup_docker

check() { # check <description> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  ✅ $1 ($3)"; PASS=$((PASS + 1)); else echo "  ❌ $1: expected $2, got $3"; FAIL=$((FAIL + 1)); fi
}

echo "▶ setup"
docker network create ${P}-coolify >/dev/null
docker network create ${P}-legacy >/dev/null
docker network create ${P}-ctl >/dev/null
cp "$ROOT/traefik/conf.d/shared-middleware.yml" "$CONF/"
chmod 777 "$CONF"

# Compile the API (the runner executes api/dist) and build the real docker-proxy sidecar.
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$ROOT:/w" -w /w/api node:22 \
  sh -c 'npm ci --no-audit --no-fund >/dev/null 2>&1 && npx tsc' >/dev/null
docker build -q -t ${P}-docker-proxy "$ROOT/sidecar/docker-proxy" >/dev/null
docker run -d --name ${P}-docker-proxy --network ${P}-ctl \
  -e COOLIFY_NETWORK_NAME=${P}-coolify -e COMPOSE_PROJECT_NAME=${P} \
  -v /var/run/docker.sock:/var/run/docker.sock ${P}-docker-proxy >/dev/null
# The reconcile runner lives on ${P}-coolify (it must reach Traefik for the post-heal
# probe), so the proxy joins that network too.
docker network connect ${P}-coolify ${P}-docker-proxy

docker run -d --name ${P}-traefik --network ${P}-coolify -v "$CONF:/conf:ro" traefik:v3.2 \
  --entrypoints.http.address=:80 --entrypoints.https.address=:443 \
  --providers.file.directory=/conf --providers.file.watch=true >/dev/null
TRAEFIK_IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"${P}-coolify\").IPAddress}}" ${P}-traefik)"

nixsite() { # nixsite <suffix>
  docker run -d --name ${P}-nixsite01-$1 --network ${P}-legacy \
    --label coolify.name=nixsite01 --label coolify.managed=true nginx:alpine >/dev/null
}
cmpsite() { # cmpsite <n> [extra docker args]
  local n="$1"; shift
  docker run -d --name app-cmpsite01-$n --network ${P}-legacy "$@" \
    --label com.docker.compose.project=cmpsite01 --label com.docker.compose.service=app \
    --label coolify.managed=true nginx:alpine >/dev/null
}
nixsite a
cmpsite 1
# Legacy-style route for the nixpacks site: raw container name upstream (pre-fix behaviour).
docker run --rm -v "$CONF:/conf" -v "$ROOT:/w:ro" node:22 node -e "
  const yml = require('/w/api/dist/routes/sites.js').buildTraefikRouteYaml('nixsite01','nixsite01.test','${P}-nixsite01-a:80','internal-ca');
  require('fs').writeFileSync('/conf/site-nixsite01.yml', yml);" >/dev/null

code() { # code <host>
  docker run --rm --network ${P}-coolify --add-host "$1:$TRAEFIK_IP" curlimages/curl \
    -sk -o /dev/null -w '%{http_code}' --max-time 5 "https://$1/" || true
}
waitcode() { # waitcode <host> <want> — Traefik's file watcher needs a moment
  local c i; for i in $(seq 1 10); do c="$(code "$1")"; [ "$c" = "$2" ] && break; sleep 1; done; echo "$c"
}

APPS='[
 {"uuid":"nixsite01","build_pack":"nixpacks","fqdn":"https://nixsite01.test","ports_exposes":"80"},
 {"uuid":"cmpsite01","build_pack":"dockercompose","fqdn":"https://cmpsite01.test",
  "docker_compose_raw":"services:\n  db:\n    image: postgres\n  app:\n    image: nginx\n"}
]'
reconcile() {
  docker run --rm --network ${P}-coolify -v "$ROOT:/w:ro" -v "$CONF:/conf" \
    -e DOCKER_PROXY_URL=http://${P}-docker-proxy:2375 -e COOLIFY_NETWORK_NAME=${P}-coolify \
    -e TRAEFIK_CONF_DIR=/conf -e NODE_TLS_REJECT_UNAUTHORIZED=0 -e APPS="$APPS" \
    --add-host nixsite01.test:$TRAEFIK_IP --add-host cmpsite01.test:$TRAEFIK_IP \
    node:22 node /w/scripts/test/route-drift-runner.cjs 2>/dev/null \
    | sed -n 's/^OUTCOMES //p' | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        for (const o of JSON.parse(s)) console.log(o.slug+"="+o.status);})'
}

echo "▶ 1. drift reproduced (before reconcile)"
sleep 2
check "nixpacks site on legacy network → 502"  502 "$(waitcode nixsite01.test 502)"
check "compose site with no route      → 404"  404 "$(waitcode cmpsite01.test 404)"

echo "▶ 2. reconcile pass heals both"
OUT="$(reconcile)"; echo "$OUT" | sed 's/^/     /'
check "nixsite01 outcome" healed "$(echo "$OUT" | sed -n 's/^nixsite01=//p')"
check "cmpsite01 outcome" healed "$(echo "$OUT" | sed -n 's/^cmpsite01=//p')"
check "nixpacks site → 200" 200 "$(waitcode nixsite01.test 200)"
check "compose site  → 200" 200 "$(waitcode cmpsite01.test 200)"
check "nix route targets stable alias" yes "$(grep -q 'http://site-nixsite01:80' "$CONF/site-nixsite01.yml" && echo yes || echo no)"

echo "▶ 3. second pass is a no-op"
OUT="$(reconcile)"
check "nixsite01 outcome" healthy "$(echo "$OUT" | sed -n 's/^nixsite01=//p')"
check "cmpsite01 outcome" healthy "$(echo "$OUT" | sed -n 's/^cmpsite01=//p')"

echo "▶ 4. Coolify-style recreate: new container, legacy network only (#127)"
docker rm -f ${P}-nixsite01-a >/dev/null; nixsite b
check "nixpacks site after recreate → 502" 502 "$(waitcode nixsite01.test 502)"
OUT="$(reconcile)"
check "nixsite01 outcome" healed "$(echo "$OUT" | sed -n 's/^nixsite01=//p')"
check "nixpacks site → 200" 200 "$(waitcode nixsite01.test 200)"

echo "▶ 5. recreate onto coolify network WITHOUT the alias (#126)"
docker rm -f app-cmpsite01-1 >/dev/null; cmpsite 2
docker network connect ${P}-coolify app-cmpsite01-2
check "compose site after recreate → 502" 502 "$(waitcode cmpsite01.test 502)"
OUT="$(reconcile)"
check "cmpsite01 outcome" healed "$(echo "$OUT" | sed -n 's/^cmpsite01=//p')"
check "compose site → 200" 200 "$(waitcode cmpsite01.test 200)"

echo "▶ 6. stopped site is left alone"
docker stop ${P}-nixsite01-b >/dev/null
OUT="$(reconcile)"
check "nixsite01 outcome" skipped "$(echo "$OUT" | sed -n 's/^nixsite01=//p')"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
