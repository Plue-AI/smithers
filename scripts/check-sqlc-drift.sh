#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# Run independently of the db package's PostgreSQL-backed TestMain.
# Requires sqlc v1.30.0; generation and compilation use an isolated temp copy.
exec go test -count=1 -run '^TestSQLCRegenerationIsClean$' -v \
  packages/backend/internal/db/sqlc_regeneration_test.go
