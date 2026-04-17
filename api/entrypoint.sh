#!/bin/sh
# Read tokens from shared volume if present
if [ -f "/coolify-api-token/token" ]; then
  export COOLIFY_API_TOKEN="$(cat /coolify-api-token/token)"
fi
if [ -f "/coolify-api-token/technitium_token" ]; then
  export TECHNITIUM_TOKEN="$(cat /coolify-api-token/technitium_token)"
fi
exec node dist/index.js
