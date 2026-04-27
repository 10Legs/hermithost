#!/bin/sh
# Ensure the external coolify network exists, then start the stack.
# The coolify network is external so docker compose down doesn't destroy it
# and take deployed site containers offline.
docker network inspect coolify >/dev/null 2>&1 || docker network create coolify
exec docker compose up "$@"
