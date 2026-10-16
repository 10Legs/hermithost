#!/usr/bin/env bash
# Helpers for the per-instance hermithost-net subnet (#125). Sourced by setup.sh
# and start.sh. Pure bash + `docker network inspect`; no other dependencies.
#
# HERMITHOST_NET_SUBNET (a /24 or larger IPv4 CIDR) and TECHNITIUM_IP (Technitium's
# pinned address inside it) are per-instance .env values, consumed by
# docker-compose.yml. Defaults keep existing installs on 172.28.0.0/24 / .10.

HH_DEFAULT_SUBNET="172.28.0.0/24"
HH_TECHNITIUM_HOST_OCTET=10

# ip_to_int 172.28.0.10 → integer
ip_to_int() {
  local IFS=.
  # shellcheck disable=SC2206
  local o=($1)
  [ "${#o[@]}" -eq 4 ] || return 1
  echo $(( (o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3] ))
}

# cidr_bounds 172.28.0.0/24 → "<first> <last>" as integers
cidr_bounds() {
  local ip="${1%/*}" bits="${1#*/}" base mask
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$ ]] || return 1
  [ "$bits" -ge 0 ] && [ "$bits" -le 32 ] || return 1
  base="$(ip_to_int "$ip")" || return 1
  mask=$(( bits == 0 ? 0 : (0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF ))
  echo "$(( base & mask )) $(( (base & mask) | (~mask & 0xFFFFFFFF) ))"
}

# cidrs_overlap A B → exit 0 if the two IPv4 CIDRs share any address
cidrs_overlap() {
  local ra rb a1 a2 b1 b2
  ra="$(cidr_bounds "$1")" || return 2
  rb="$(cidr_bounds "$2")" || return 2
  read -r a1 a2 <<<"$ra"; read -r b1 b2 <<<"$rb"
  [ "$a1" -le "$b2" ] && [ "$b1" -le "$a2" ]
}

# ip_in_cidr IP CIDR → exit 0 if IP is a usable host address inside CIDR
ip_in_cidr() {
  local ip r lo hi
  ip="$(ip_to_int "$1")" || return 2
  r="$(cidr_bounds "$2")" || return 2
  read -r lo hi <<<"$r"
  [ "$ip" -gt "$lo" ] && [ "$ip" -lt "$hi" ]
}

# docker_ipv4_subnets [exclude-network] → "<network> <cidr>" per IPv4 subnet in use
docker_ipv4_subnets() {
  local exclude="${1:-}"
  docker network ls --format '{{.Name}}' | while read -r net; do
    [ "$net" = "$exclude" ] && continue
    docker network inspect "$net" --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null \
      | tr ' ' '\n' | { grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/' || true; } | sed "s|^|$net |"
  done
  return 0
}

# subnet_conflicts CIDR [exclude-network] → prints "<network> <cidr>" for each overlap
subnet_conflicts() {
  local want="$1" exclude="${2:-}" net cidr
  docker_ipv4_subnets "$exclude" | while read -r net cidr; do
    if cidrs_overlap "$want" "$cidr"; then echo "$net $cidr"; fi
  done
  return 0
}

# pick_free_subnet → first 172.28.N.0/24 (N = 0..255) not overlapping any docker network
pick_free_subnet() {
  local n cidr
  for n in $(seq 0 255); do
    cidr="172.28.${n}.0/24"
    if [ -z "$(subnet_conflicts "$cidr")" ]; then echo "$cidr"; return 0; fi
  done
  return 1
}

# technitium_ip_for CIDR → the .10 host address of the subnet's first /24
technitium_ip_for() {
  local r lo
  r="$(cidr_bounds "$1")" || return 1
  read -r lo _ <<<"$r"
  lo=$(( lo + HH_TECHNITIUM_HOST_OCTET ))
  echo "$(( (lo >> 24) & 255 )).$(( (lo >> 16) & 255 )).$(( (lo >> 8) & 255 )).$(( lo & 255 ))"
}

# hermithost_net_preflight <network> <subnet> <technitium-ip> [log-prefix] [recreate]
# Validates the values and, if <network> will be created (it does not exist yet, or
# `recreate` is passed because the caller is about to `compose down`), that <subnet>
# overlaps no other network. Prints the reason and returns 1 on failure.
hermithost_net_preflight() {
  local net="$1" subnet="$2" tip="$3" p="${4:-[preflight]}" recreate="${5:-}" conflicts
  if ! cidr_bounds "$subnet" >/dev/null; then
    echo "$p ERROR: HERMITHOST_NET_SUBNET='${subnet}' is not a valid IPv4 CIDR."; return 1
  fi
  if ! ip_in_cidr "$tip" "$subnet"; then
    echo "$p ERROR: TECHNITIUM_IP=${tip} is not inside HERMITHOST_NET_SUBNET=${subnet}."; return 1
  fi
  if [ "$recreate" != "recreate" ] && docker network inspect "$net" >/dev/null 2>&1; then return 0; fi
  conflicts="$(subnet_conflicts "$subnet" "$net")"
  if [ -n "$conflicts" ]; then
    echo "$p ERROR: ${net} needs subnet ${subnet}, which overlaps an existing network:"
    echo "$conflicts" | sed "s/^/$p   /"
    echo "$p Set HERMITHOST_NET_SUBNET (and TECHNITIUM_IP) in .env to a free range, e.g. $(pick_free_subnet || echo '<none free>'),"
    echo "$p then re-run scripts/setup.sh once the stack is up so the TSIG ACL matches the new subnet."
    return 1
  fi
  return 0
}
