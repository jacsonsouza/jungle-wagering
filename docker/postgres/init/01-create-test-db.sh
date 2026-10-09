#!/bin/sh
set -eu

TEST_DB="${POSTGRES_DB}_test"

exists="$(psql -tAc "SELECT 1 FROM pg_database WHERE datname = '${TEST_DB}'" \
  -U "${POSTGRES_USER}" -d "${POSTGRES_DB}")"

if [ "${exists}" = "1" ]; then
  echo "[init] database ${TEST_DB} already exists, skipping"
else
  psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
    -c "CREATE DATABASE \"${TEST_DB}\";"
  echo "[init] created database ${TEST_DB}"
fi
