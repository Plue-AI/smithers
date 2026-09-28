#!/bin/sh
# shellcheck disable=SC2154
set -eu
# shellcheck disable=SC1090
. "${SMITHERS_LIB:-/opt/smithers/lib.sh}"
load_database_url
: "${SMITHERS_DATA_ROOT:=/var/lib/smithers}"; : "${SMITHERS_BACKUP_ROOT:?SMITHERS_BACKUP_ROOT is required}"
export SMITHERS_DATA_ROOT
load_release; lock_maintenance; verify_state_matches_release; require pg_dump; require tar
case "$SMITHERS_BACKUP_ROOT/" in "$SMITHERS_DATA_ROOT/"*) die "backup root must be outside the live data root" ;; esac
mkdir -p "$SMITHERS_BACKUP_ROOT"; stamp=$(date -u +%Y%m%dT%H%M%SZ); final="$SMITHERS_BACKUP_ROOT/smithers-$stamp"; [ ! -e "$final" ] || die "backup destination already exists: $final"; staging=$(mktemp -d "$SMITHERS_BACKUP_ROOT/.smithers-backup-XXXXXX")
trap 'rm -rf "$staging"' EXIT HUP INT TERM
pg_dump --dbname="$smithers_pg_url" --format=custom --compress=6 --no-owner --file "$staging/postgres.dump"
tar -C "$SMITHERS_DATA_ROOT" --exclude=.maintenance.lock --exclude='.restore-staging.*' -cf "$staging/files.tar" .
umask 077
{ printf 'SMITHERS_DISTRIBUTION_VERSION=%s\n' "$release_version"; printf 'SMITHERS_SCHEMA_VERSION=%s\n' "$release_schema"; printf 'SMITHERS_POSTGRES_MAJOR=%s\n' "$release_postgres"; printf 'POSTGRES_SHA256=%s\n' "$(sha256_file "$staging/postgres.dump")"; printf 'FILES_SHA256=%s\n' "$(sha256_file "$staging/files.tar")"; } >"$staging/MANIFEST"
sync "$staging/postgres.dump" "$staging/files.tar" "$staging/MANIFEST"; mv "$staging" "$final"; trap - EXIT HUP INT TERM; printf '%s\n' "$final"
