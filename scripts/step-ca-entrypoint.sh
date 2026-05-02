#!/bin/sh
# step-ca-entrypoint.sh — wrapper that pins /etc/resolv.conf to Technitium
# before handing off to the real step-ca binary.
#
# The Compose dns: block is only written at container creation. On a
# stack restart (without --force-recreate) the container preserves its
# previous resolv.conf (127.0.0.11 — Docker's embedded resolver) instead
# of using 172.28.0.10 (Technitium). This wrapper enforces the correct
# nameserver on every container start, regardless of how the container
# was created.
#
# Must run as root (user: root is set in the step-ca service for the
# init container; the step-ca service itself runs as the step user so
# we need privileged write. The image runs as uid 1000 by default but
# /etc/resolv.conf is root-owned. Use tee under sh for POSIX compat.)

set -e

# Technitium static IP (matches ipv4_address in docker-compose.yml)
TECHNITIUM_DNS="${TECHNITIUM_DNS_IP:-172.28.0.10}"

# Write resolv.conf. Runs before step-ca starts, so DNS is correct from
# first ACME DNS-01 TXT lookup onward.
if [ -w /etc/resolv.conf ] || [ "$(id -u)" = "0" ]; then
  printf 'nameserver %s\nsearch hh\n' "$TECHNITIUM_DNS" > /etc/resolv.conf
  echo "[step-ca-entrypoint] resolv.conf set to nameserver ${TECHNITIUM_DNS}"
else
  echo "[step-ca-entrypoint] WARNING: cannot write /etc/resolv.conf (not root). DNS may be wrong." >&2
fi

# Hand off to the real step-ca binary with all original arguments.
exec /usr/local/bin/step-ca "$@"
