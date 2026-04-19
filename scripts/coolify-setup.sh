#!/bin/sh
# Runs inside the coolify-server-setup container.
# Registers the ssh-bridge SSH key with Coolify, updates the server IP,
# and validates the server — fully automated, idempotent.
set -e
set -o pipefail

COOLIFY_URL="http://coolify:8080/api/v1"
KEY_FILE="/coolify-keys/hermithost_deploy"

auth_header() { echo "Authorization: Bearer $SESSION_TOKEN"; }

# ── 0. Wait for Coolify to seed, then create a session token via DB ──────────
echo "[setup] Waiting for Coolify to seed..."
WAIT=0
while true; do
  USER_COUNT=$(psql -t -A -c "SELECT COUNT(*) FROM users;" 2>/dev/null || echo "0")
  [ "$USER_COUNT" -gt 0 ] && break
  sleep 2; WAIT=$((WAIT+2))
  if [ $WAIT -gt 120 ]; then echo "[setup] ERROR: Coolify seeding timeout."; exit 1; fi
done
echo "[setup] Coolify seeded."

# Ensure root user is linked to root team (seeder doesn't do this)
psql -c "INSERT INTO team_user (team_id, user_id, role, created_at, updated_at) VALUES (0, 0, 'owner', NOW(), NOW()) ON CONFLICT DO NOTHING;" > /dev/null
echo "[setup] User linked to root team."

# Enable Coolify API (disabled by default on fresh install)
psql -c "UPDATE instance_settings SET is_api_enabled=true WHERE id=0;" > /dev/null
echo "[setup] API enabled."

PLAIN_TOKEN="hermithost-setup-$(date +%s)"
TOKEN_HASH=$(printf '%s' "$PLAIN_TOKEN" | sha256sum | cut -d' ' -f1)
USER_ID=$(psql -t -A -c "SELECT id FROM users ORDER BY id LIMIT 1;" | grep -E '^[0-9]+$')

# Clean up any previous hermithost-setup tokens
psql -c "DELETE FROM personal_access_tokens WHERE name='hermithost-setup';" > /dev/null

TOKEN_ID=$(psql -t -A -c "INSERT INTO personal_access_tokens (tokenable_type, tokenable_id, name, token, abilities, team_id, created_at, updated_at) VALUES ('App\Models\User', $USER_ID, 'hermithost-setup', '$TOKEN_HASH', '[\"*\"]', 0, NOW(), NOW()) RETURNING id;" | grep -E '^[0-9]+$')
SESSION_TOKEN="${TOKEN_ID}|${PLAIN_TOKEN}"
echo "[setup] Session token created."

# ── 1. Discover server UUID ───────────────────────────────────────────────────
echo "[setup] Discovering server UUID..."
SERVERS_RESP=$(curl -sf "$COOLIFY_URL/servers" -H "$(auth_header)")
SERVER_UUID=$(echo "$SERVERS_RESP" | jq -r '.[0].uuid')
if [ -z "$SERVER_UUID" ] || [ "$SERVER_UUID" = "null" ]; then
  echo "[setup] ERROR: Could not discover server UUID."
  exit 1
fi
echo "[setup] Server UUID: $SERVER_UUID"

# ── 2. Provision tokens (always — session tokens change each boot) ────────────
# Coolify API token — always re-provision so the file is always valid after DB reset
API_TOKEN_FILE="/coolify-api-token/token"
echo "[setup] Provisioning API token..."
API_PLAIN="hermithost-api-$(date +%s)"
API_HASH=$(printf '%s' "$API_PLAIN" | sha256sum | cut -d' ' -f1)
psql -c "DELETE FROM personal_access_tokens WHERE name='hermithost-api';" > /dev/null
API_TOKEN_ID=$(psql -t -A -c "INSERT INTO personal_access_tokens (tokenable_type, tokenable_id, name, token, abilities, team_id, created_at, updated_at) VALUES ('App\Models\User', $USER_ID, 'hermithost-api', '$API_HASH', '[\"*\"]', 0, NOW(), NOW()) RETURNING id;" | grep -E '^[0-9]+$')
printf '%s|%s' "$API_TOKEN_ID" "$API_PLAIN" > "$API_TOKEN_FILE"
echo "[setup] API token written."

# Destination UUID
DEST_UUID=$(psql -t -A -c "SELECT d.uuid FROM standalone_dockers d JOIN servers s ON s.id = d.server_id WHERE s.uuid='$SERVER_UUID' LIMIT 1;" | grep -E '^[a-z0-9]+$' | head -1)
if [ -n "$DEST_UUID" ]; then
  printf '%s' "$DEST_UUID" > /coolify-api-token/destination_uuid
  echo "[setup] Destination UUID written: $DEST_UUID"
fi

# Technitium permanent API token (idempotent — recreate on every boot)
echo "[setup] Setting up Technitium permanent API token..."
TECH_URL="${TECHNITIUM_URL:-http://technitium:5380}"

# Step 1: get a session token to bootstrap
TECH_RESP=$(curl -sf -X POST "$TECH_URL/api/user/login" \
  -d "user=admin&pass=admin&includeInfo=false" 2>/dev/null || echo "")
TECH_SESSION=$(echo "$TECH_RESP" | jq -r '.token // empty' 2>/dev/null)

if [ -n "$TECH_SESSION" ]; then
  # Step 2: delete old permanent token (ignore errors if it doesn't exist)
  curl -sf -X POST "$TECH_URL/api/user/deleteToken?token=$TECH_SESSION&tokenName=hermithost-api" > /dev/null 2>&1 || true
  # Step 3: create new permanent token
  PERM_RESP=$(curl -sf -X POST "$TECH_URL/api/user/createToken?token=$TECH_SESSION&tokenName=hermithost-api" 2>/dev/null || echo "")
  PERM_TOKEN=$(echo "$PERM_RESP" | jq -r '.token // empty' 2>/dev/null)
  if [ -n "$PERM_TOKEN" ]; then
    printf '%s' "$PERM_TOKEN" > /coolify-api-token/technitium_token
    echo "[setup] Technitium permanent token written."
  else
    # Fallback: write session token — withTokenRetry in API handles expiry
    printf '%s' "$TECH_SESSION" > /coolify-api-token/technitium_token
    echo "[setup] WARNING: Could not create permanent Technitium token — wrote session token as fallback."
  fi
else
  echo "[setup] WARNING: Could not obtain Technitium token — DNS integration will be limited."
fi

# ── 3. Provision GitHub deploy key (always — DB is reset on each boot) ───────
GITHUB_KEY_FILE="/coolify-keys/github_deploy"
if [ ! -f "$GITHUB_KEY_FILE" ]; then
  echo "[setup] Generating GitHub deploy key..."
  ssh-keygen -t ed25519 -f "$GITHUB_KEY_FILE" -N '' -C 'hermithost@github' -q
  echo "[setup] GitHub deploy key generated."
fi

GITHUB_PRIV_JSON=$(jq -Rs . < "$GITHUB_KEY_FILE")
GITHUB_PUB_KEY=$(cat "${GITHUB_KEY_FILE}.pub")
cp "${GITHUB_KEY_FILE}.pub" /coolify-api-token/github_deploy.pub
echo "[setup] GitHub public key written to shared volume."

psql -c "DELETE FROM private_keys WHERE name='github-deploy';" > /dev/null 2>&1
GITHUB_KEY_RESP=$(curl -sf -X POST "$COOLIFY_URL/security/keys" \
  -H "$(auth_header)" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"github-deploy\",\"description\":\"HermitHost GitHub deploy key\",\"private_key\":$GITHUB_PRIV_JSON}" || echo "")
GITHUB_KEY_UUID=$(echo "$GITHUB_KEY_RESP" | jq -r '.uuid // empty')

if [ -n "$GITHUB_KEY_UUID" ]; then
  psql -c "UPDATE private_keys SET is_git_related=true WHERE uuid='$GITHUB_KEY_UUID';" > /dev/null
  printf '%s' "$GITHUB_KEY_UUID" > /coolify-api-token/github_key_uuid
  echo "[setup] GitHub deploy key registered: $GITHUB_KEY_UUID"
  echo "[setup] ══════════════════════════════════════════════════"
  echo "[setup] Add this deploy key to your GitHub repos:"
  echo "$GITHUB_PUB_KEY"
  echo "[setup] ══════════════════════════════════════════════════"
else
  echo "[setup] WARNING: Could not register GitHub deploy key."
fi

# ── 4. Skip if server already configured and reachable ───────────────────────
echo "[setup] Checking server status..."
SERVER_INFO=$(curl -sf "$COOLIFY_URL/servers" \
  -H "$(auth_header)" | jq -r --arg u "$SERVER_UUID" '.[] | select(.uuid==$u) | {ip: .ip, reachable: .is_reachable}')

SERVER_IP=$(echo "$SERVER_INFO" | jq -r '.ip // empty')
REACHABLE=$(echo "$SERVER_INFO" | jq -r '.reachable // empty')
echo "[setup] Server IP=$SERVER_IP reachable=$REACHABLE"

if [ "$SERVER_IP" = "ssh-bridge" ] && [ "$REACHABLE" = "true" ]; then
  echo "[setup] Server already configured and reachable — skipping server setup."
  exit 0
fi

# ── 5. Update server IP to ssh-bridge ────────────────────────────────────────
echo "[setup] Updating server IP to ssh-bridge..."
curl -sf -X PATCH "$COOLIFY_URL/servers/$SERVER_UUID" \
  -H "$(auth_header)" -H "Content-Type: application/json" \
  -d '{"ip":"ssh-bridge","port":22,"user":"deploy"}' > /dev/null
echo "[setup] Server IP updated."

# ── 4. Register private key with Coolify ─────────────────────────────────────
echo "[setup] Registering private key with Coolify..."
PRIV_JSON=$(jq -Rs . < "$KEY_FILE")

KEY_RESP=$(curl -sf -X POST "$COOLIFY_URL/security/keys" \
  -H "$(auth_header)" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"hermithost-deploy\",\"private_key\":$PRIV_JSON}")

KEY_UUID=$(echo "$KEY_RESP" | jq -r '.uuid // empty')

# Key may already exist — look it up
if [ -z "$KEY_UUID" ]; then
  echo "[setup] Key may already exist, looking up..."
  KEY_UUID=$(curl -sf "$COOLIFY_URL/security/keys" \
    -H "$(auth_header)" \
    | jq -r '.[] | select(.name=="hermithost-deploy") | .uuid' | head -1)
fi

if [ -z "$KEY_UUID" ]; then
  echo "[setup] ERROR: Could not register or find SSH key in Coolify."
  exit 1
fi
echo "[setup] Key UUID: $KEY_UUID"

# ── 5. Link key to server via DB (Coolify API silently ignores private_key_uuid PATCH) ─
echo "[setup] Linking key to server..."
KEY_ID=$(psql -t -A -c "SELECT id FROM private_keys WHERE uuid='$KEY_UUID' LIMIT 1;" | grep -E '^[0-9]+$')
if [ -z "$KEY_ID" ]; then
  echo "[setup] ERROR: Could not find key ID in DB for UUID $KEY_UUID."
  exit 1
fi
psql -c "UPDATE servers SET private_key_id=$KEY_ID WHERE uuid='$SERVER_UUID';" > /dev/null
echo "[setup] Key linked (private_key_id=$KEY_ID)."

# Coolify's localhost server (id=0) internally calls PrivateKey::findOrFail(0) during
# ValidateServer — not findOrFail(private_key_id). Without a row at id=0 the job throws
# immediately, marking the server unreachable and blocking all deploys.
# Copy the hermithost-deploy key to id=0 so that lookup succeeds.
psql -c "INSERT INTO private_keys (id, uuid, name, description, private_key, is_git_related, team_id, created_at, updated_at, fingerprint)
  SELECT 0, '00000000-0000-0000-0000-000000000000', name, description, private_key, is_git_related, team_id, created_at, updated_at, fingerprint
  FROM private_keys WHERE id=$KEY_ID
  ON CONFLICT (id) DO UPDATE SET private_key = EXCLUDED.private_key, updated_at = NOW();" > /dev/null
echo "[setup] PrivateKey id=0 ensured for Coolify localhost server validation."


# ── 8. Validate server ────────────────────────────────────────────────────────
echo "[setup] Validating server (may take a few seconds)..."
sleep 3
RESULT=$(curl -sf "$COOLIFY_URL/servers/$SERVER_UUID/validate" \
  -H "$(auth_header)")
echo "[setup] Validate response: $RESULT"

# ── 9. Confirm ────────────────────────────────────────────────────────────────
sleep 8
STATUS=$(curl -sf "$COOLIFY_URL/servers" \
  -H "$(auth_header)" | jq -r --arg u "$SERVER_UUID" '.[] | select(.uuid==$u) | {reachable: .is_reachable, usable: .is_usable}')
echo "[setup] Final server status: $STATUS"
echo "[setup] Done."
