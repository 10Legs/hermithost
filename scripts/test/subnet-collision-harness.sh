#!/usr/bin/env bash
# Live end-to-end test for the per-instance hermithost-net subnet (#125).
#
# In a throwaway clone with a synthetic .env (instance name hhtest125), next to a
# "blocker" network that already holds 172.28.0.0/24 (stands in for a second
# instance such as copper-rabbit):
#   1. reproduces the bug: compose with the old fixed subnet fails "Pool overlaps"
#   2. start.sh's preflight refuses with a clear message instead
#   3. setup.sh (non-interactive run) picks a free subnet + Technitium IP
#   4. technitium comes up on that subnet at that IP and answers DNS
#   5. restart.sh's preflight passes for its own network, refuses a conflicting change
# Everything it creates is named hhtest125*/hhtest-blocker and removed afterwards.
#
# Usage: scripts/test/subnet-collision-harness.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
P=hhtest125
WORK="$(mktemp -d)"
CLONE="$WORK/clone"
PASS=0; FAIL=0

cleanup() {
  [ -d "$CLONE" ] && (cd "$CLONE" && docker compose -p $P down -v --remove-orphans >/dev/null 2>&1)
  docker network rm hhtest-blocker >/dev/null 2>&1 || true
  docker image rm ${P}-technitium >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

check() { if [ "$2" = "$3" ]; then echo "  ✅ $1 ($3)"; PASS=$((PASS + 1)); else echo "  ❌ $1: expected $2, got $3"; FAIL=$((FAIL + 1)); fi; }

echo "▶ setup: throwaway clone + blocker network on 172.28.0.0/24"
git clone -q "$ROOT" "$CLONE"
# Test the working tree as it is now (uncommitted changes included).
(cd "$ROOT" && git ls-files -m -o --exclude-standard -z | grep -zv '^\.scratch/' | xargs -0 -I{} cp --parents {} "$CLONE/") 2>/dev/null
cd "$CLONE"
sed -e 's/^HERMITHOST_PORT_MODE=.*/HERMITHOST_PORT_MODE=internet/' \
    -e 's/^DNS_PORT=.*/DNS_PORT=53099/' "$CLONE/.env.template" > "$CLONE/.env"
for kv in ACME_EMAIL=test@example.com NS_HOSTNAME=ns.example.test NS_SERVER_IP=192.0.2.1 \
          HERMITHOST_PASSWORD=test-only COOLIFY_ADMIN_PASSWORD=Atest-only1! HERMITHOST_PORT_MODE=internet; do
  k="${kv%%=*}"
  if grep -q "^$k=" .env; then sed -i "s|^$k=.*|$kv|" .env; else echo "$kv" >> .env; fi
done
grep -q '^DNS_PORT=' .env || echo 'DNS_PORT=53099' >> .env
docker network create --subnet 172.28.0.0/24 hhtest-blocker >/dev/null

echo "▶ 1. bug reproduced: fixed 172.28.0.0/24 collides"
OUT="$(HERMITHOST_NET_SUBNET=172.28.0.0/24 TECHNITIUM_IP=172.28.0.10 \
       docker compose -p $P up -d --no-deps technitium 2>&1)"; RC=$?
check "compose up with colliding subnet fails" 1 "$([ $RC -ne 0 ] && echo 1 || echo 0)"
check "error is the pool overlap"             yes "$(grep -qi 'overlaps' <<<"$OUT" && echo yes || echo no)"
docker compose -p $P down -v >/dev/null 2>&1

echo "▶ 2. start.sh preflight refuses with a clear message"
# shellcheck source=../lib/net-subnet.sh
source "$CLONE/scripts/lib/net-subnet.sh"
OUT="$(hermithost_net_preflight ${P}_hermithost-net 172.28.0.0/24 172.28.0.10 '[start]')"; RC=$?
check "preflight exit"            1 "$RC"
check "names the blocker"         yes "$(grep -q 'hhtest-blocker 172.28.0.0/24' <<<"$OUT" && echo yes || echo no)"
check "suggests a free subnet"    yes "$(grep -q 'e.g. 172.28.1.0/24' <<<"$OUT" && echo yes || echo no)"

echo "▶ 3. setup.sh picks a free subnet (non-interactive run)"
printf '%s\n' "$P" | bash scripts/setup.sh >"$WORK/setup.log" 2>&1; RC=$?
check "setup.sh exit"             0 "$RC"
SUBNET="$(grep -E '^HERMITHOST_NET_SUBNET=' .env | cut -d= -f2)"
TIP="$(grep -E '^TECHNITIUM_IP=' .env | cut -d= -f2)"
check "HERMITHOST_NET_SUBNET"     172.28.1.0/24 "$SUBNET"
check "TECHNITIUM_IP"             172.28.1.10 "$TIP"
printf '%s\n' "$P" | bash scripts/setup.sh >/dev/null 2>&1
check "re-run keeps the value"    172.28.1.0/24 "$(grep -E '^HERMITHOST_NET_SUBNET=' .env | cut -d= -f2)"
check "setup never printed secrets" no "$(grep -q 'test-only' "$WORK/setup.log" && echo yes || echo no)"

echo "▶ 4. technitium runs on the chosen subnet and answers DNS"
check "preflight now passes" 0 "$(hermithost_net_preflight ${P}_hermithost-net "$SUBNET" "$TIP" >/dev/null; echo $?)"
docker compose -p $P up -d --build --no-deps technitium >"$WORK/up.log" 2>&1; RC=$?
check "compose up exit" 0 "$RC"
check "network subnet" "$SUBNET" "$(docker network inspect ${P}_hermithost-net -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null)"
check "technitium IP"  "$TIP" "$(docker inspect ${P}-technitium-1 -f "{{(index .NetworkSettings.Networks \"${P}_hermithost-net\").IPAddress}}" 2>/dev/null)"
H=""; for i in $(seq 1 30); do H="$(docker inspect -f '{{.State.Health.Status}}' ${P}-technitium-1 2>/dev/null)"; [ "$H" = healthy ] && break; sleep 2; done
check "technitium healthy" healthy "$H"
check "DNS answers on the pinned IP" yes \
  "$(docker exec ${P}-technitium-1 dig +norecurse +time=2 +tries=1 @"$TIP" . SOA >/dev/null 2>&1 && echo yes || echo no)"
check "blocker untouched" 172.28.0.0/24 "$(docker network inspect hhtest-blocker -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}')"

echo "▶ 5. restart.sh preflight (network will be recreated)"
check "own subnet → ok"               0 "$(hermithost_net_preflight ${P}_hermithost-net "$SUBNET" "$TIP" x recreate >/dev/null; echo $?)"
check "switch to blocker's → refused" 1 "$(hermithost_net_preflight ${P}_hermithost-net 172.28.0.0/24 172.28.0.10 x recreate >/dev/null; echo $?)"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
