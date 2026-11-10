#!/bin/sh
# Sourced by the official PostgreSQL image when initializing an empty volume.
(
  set -eu
  : "${AIRWAVES_DB_APP_PASSWORD:?Application DB password is missing}"
  psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v ON_ERROR_STOP=1 <<'SQL'
\getenv app_password AIRWAVES_DB_APP_PASSWORD
CREATE ROLE airwaves LOGIN PASSWORD :'app_password';
ALTER DATABASE airwaves OWNER TO airwaves;
SQL
)
