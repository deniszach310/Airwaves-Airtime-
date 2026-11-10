#!/bin/sh
set -eu
# Read the restricted host file before the official entrypoint switches to postgres.
AIRWAVES_DB_APP_PASSWORD="$(cat /run/secrets/postgres_app_password)"
export AIRWAVES_DB_APP_PASSWORD
exec /usr/local/bin/docker-entrypoint.sh "$@"
