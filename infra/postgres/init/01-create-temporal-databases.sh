#!/bin/bash
# Creates the extra databases Temporal needs, so it can share the development
# Postgres instance instead of running a second container.
#
# Runs once, on first initialisation of the data volume.
set -euo pipefail

if [ -z "${POSTGRES_MULTIPLE_DATABASES:-}" ]; then
  exit 0
fi

IFS=',' read -ra databases <<< "$POSTGRES_MULTIPLE_DATABASES"

for database in "${databases[@]}"; do
  echo "Creating database '$database'"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
      SELECT 'CREATE DATABASE $database'
      WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$database')\gexec
EOSQL
done
