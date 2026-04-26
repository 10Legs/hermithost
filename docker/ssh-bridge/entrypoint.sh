#!/bin/sh
set -e
KEY_FILE="/coolify-keys/hermithost_deploy.pub"

echo "[ssh-bridge] Waiting for SSH public key..."
WAIT=0
while [ ! -f "$KEY_FILE" ]; do
  sleep 1; WAIT=$((WAIT+1))
  if [ $WAIT -gt 60 ]; then echo "ERROR: key never appeared"; exit 1; fi
done

# Install key for root (Coolify connects as root to avoid sudo-wrapper bugs)
mkdir -p /root/.ssh && chmod 700 /root/.ssh
cat "$KEY_FILE" > /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
echo "[ssh-bridge] Public key installed for root."

# Keep deploy user key for backwards compatibility
cat "$KEY_FILE" > /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
echo "[ssh-bridge] Public key installed for deploy."

# Align Docker GID to host socket (critical on macOS Docker Desktop)
SOCK_GID=$(stat -c '%g' /var/run/docker.sock 2>/dev/null || echo "")
if [ -n "$SOCK_GID" ] && [ "$SOCK_GID" != "0" ]; then
  if ! getent group docker > /dev/null 2>&1; then
    addgroup -g "$SOCK_GID" docker
  else
    sed -i "s/^docker:x:[0-9]*/docker:x:$SOCK_GID/" /etc/group
  fi
  adduser deploy docker
else
  # GID=0 (macOS Docker Desktop): socket owned by root:root — add deploy to root group
  adduser deploy root
fi

# Ensure the 'coolify' Docker network exists (required for app deployments)
if ! docker network inspect coolify > /dev/null 2>&1; then
  docker network create coolify > /dev/null 2>&1 && echo "[ssh-bridge] Created 'coolify' Docker network." || echo "[ssh-bridge] WARNING: could not create 'coolify' network."
else
  echo "[ssh-bridge] 'coolify' Docker network already exists."
fi

echo "[ssh-bridge] Starting sshd..."
exec /usr/sbin/sshd -D -e
