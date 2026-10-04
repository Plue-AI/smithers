#!/bin/sh
# shellcheck disable=SC2154
set -eu
# shellcheck disable=SC1090
. "${SMITHERS_LIB:-/opt/smithers/lib.sh}"
[ "$#" -eq 1 ] || die "usage: restore.sh BACKUP_DIRECTORY"
load_database_url
: "${SMITHERS_DATA_ROOT:=/var/lib/smithers}"
export SMITHERS_DATA_ROOT; backup=$1
load_release; lock_maintenance; verify_backup "$backup"; require pg_restore; require psql
[ "$(field "$backup/MANIFEST" SMITHERS_DISTRIBUTION_VERSION)" = "$release_version" ] || die "backup distribution version is incompatible with image version ${release_version}"
[ "$(field "$backup/MANIFEST" SMITHERS_SCHEMA_VERSION)" = "$release_schema" ] || die "backup schema is incompatible with image schema ${release_schema}"
[ "$(field "$backup/MANIFEST" SMITHERS_POSTGRES_MAJOR)" = "$release_postgres" ] || die "backup PostgreSQL major is incompatible with image tools"
[ -z "$(find "$SMITHERS_DATA_ROOT" -mindepth 1 -maxdepth 1 ! -name '.maintenance.lock' -print -quit)" ] || die "restore target data root is not empty"
[ "$(psql --dbname="$smithers_pg_url" -v ON_ERROR_STOP=1 -Atqc "select count(*) from pg_catalog.pg_tables where schemaname not in ('pg_catalog','information_schema')")" = 0 ] || die "restore target database is not empty"
staging=$(mktemp -d "$SMITHERS_DATA_ROOT/.restore-staging.XXXXXX"); trap 'rm -rf "$staging"' EXIT HUP INT TERM
tar -C "$staging" -xf "$backup/files.tar"
verify_staged_links "$staging"
[ -f "$staging/version.env" ] || die "backup file archive has no state version manifest"
[ "$(field "$staging/version.env" SMITHERS_DISTRIBUTION_VERSION)" = "$(field "$backup/MANIFEST" SMITHERS_DISTRIBUTION_VERSION)" ] || die "backup manifests disagree on distribution version"
[ "$(field "$staging/version.env" SMITHERS_SCHEMA_VERSION)" = "$(field "$backup/MANIFEST" SMITHERS_SCHEMA_VERSION)" ] || die "backup manifests disagree on schema version"
[ "$(field "$staging/version.env" SMITHERS_POSTGRES_MAJOR)" = "$(field "$backup/MANIFEST" SMITHERS_POSTGRES_MAJOR)" ] || die "backup manifests disagree on PostgreSQL major"
pg_restore --dbname="$smithers_pg_url" --exit-on-error --single-transaction --no-owner --no-privileges "$backup/postgres.dump"
find "$staging" -mindepth 1 -maxdepth 1 -exec mv {} "$SMITHERS_DATA_ROOT/" \;
rmdir "$staging"; trap - EXIT HUP INT TERM; verify_state_matches_release; printf 'restored %s\n' "$backup"
