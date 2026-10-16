#!/usr/bin/env bash
# Unit tests for scripts/lib/net-subnet.sh pure functions (no docker needed).
#   scripts/test/net-subnet.test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../lib/net-subnet.sh
source "$ROOT/scripts/lib/net-subnet.sh"
PASS=0; FAIL=0
t() { # t <description> <expected-exit> <command...>
  local desc="$1" want="$2"; shift 2
  "$@" >/dev/null 2>&1; local got=$?
  if [ "$got" = "$want" ]; then PASS=$((PASS + 1)); else echo "❌ $desc: exit $got, want $want"; FAIL=$((FAIL + 1)); fi
}
eq() { if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); else echo "❌ $1: got '$3', want '$2'"; FAIL=$((FAIL + 1)); fi; }

eq "ip_to_int"                 2887516160 "$(ip_to_int 172.28.0.0)"
eq "cidr_bounds /24"           "2887516160 2887516415" "$(cidr_bounds 172.28.0.0/24)"
eq "cidr_bounds normalises"    "2887516160 2887516415" "$(cidr_bounds 172.28.0.77/24)"
t  "cidr_bounds rejects junk"  1 cidr_bounds "172.28.0/24"
t  "cidr_bounds rejects /33"   1 cidr_bounds "172.28.0.0/33"

t  "same /24 overlaps"               0 cidrs_overlap 172.28.0.0/24 172.28.0.0/24
t  "/24 inside docker /16 overlaps"  0 cidrs_overlap 172.28.0.0/24 172.28.0.0/16
t  "/16 containing /24 overlaps"     0 cidrs_overlap 172.28.0.0/16 172.28.5.0/24
t  "adjacent /24s do not overlap"    1 cidrs_overlap 172.28.0.0/24 172.28.1.0/24
t  "different /16s do not overlap"   1 cidrs_overlap 172.28.0.0/24 172.29.0.0/16
t  "invalid input is an error"       2 cidrs_overlap bogus 172.28.0.0/24

t  "ip_in_cidr host"             0 ip_in_cidr 172.28.0.10 172.28.0.0/24
t  "ip_in_cidr network address"  1 ip_in_cidr 172.28.0.0 172.28.0.0/24
t  "ip_in_cidr broadcast"        1 ip_in_cidr 172.28.0.255 172.28.0.0/24
t  "ip_in_cidr other subnet"     1 ip_in_cidr 172.28.1.10 172.28.0.0/24

eq "technitium_ip_for default"   172.28.0.10 "$(technitium_ip_for 172.28.0.0/24)"
eq "technitium_ip_for N=7"       172.28.7.10 "$(technitium_ip_for 172.28.7.0/24)"

# pick_free_subnet / subnet_conflicts against a stubbed docker
docker() {
  case "$1 $2" in
    "network ls") printf '%s\n' bridge legacy other other-v6 ;;
    "network inspect")
      case "$3" in
        bridge) echo "172.17.0.0/16 " ;;
        legacy) echo "172.28.0.0/24 " ;;
        other) echo "172.28.1.0/24 " ;;
        other-v6) echo "fd00::/64 " ;;
        *) return 1 ;;   # unknown network → inspect fails, like real docker
      esac ;;
  esac
}
eq "pick_free_subnet skips used /24s"   172.28.2.0/24 "$(pick_free_subnet)"
eq "subnet_conflicts lists overlap"     "legacy 172.28.0.0/24" "$(subnet_conflicts 172.28.0.0/24)"
eq "subnet_conflicts excludes own net"  "" "$(subnet_conflicts 172.28.0.0/24 legacy)"
eq "ipv6 subnets are ignored"           "" "$(subnet_conflicts 172.28.9.0/24)"
t  "preflight: conflict on create"      1 hermithost_net_preflight mynet 172.28.0.0/24 172.28.0.10
t  "preflight: free subnet ok"          0 hermithost_net_preflight mynet 172.28.5.0/24 172.28.5.10
t  "preflight: IP outside subnet"       1 hermithost_net_preflight mynet 172.28.5.0/24 172.28.0.10
t  "preflight: own net exists → ok"     0 hermithost_net_preflight legacy 172.28.0.0/24 172.28.0.10
t  "preflight: recreate own net → ok"   0 hermithost_net_preflight legacy 172.28.0.0/24 172.28.0.10 x recreate
t  "preflight: recreate into other's"   1 hermithost_net_preflight legacy 172.28.1.0/24 172.28.1.10 x recreate

echo "net-subnet: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
