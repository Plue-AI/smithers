#!/bin/sh
# shellcheck disable=SC2154
set -eu
# shellcheck disable=SC1090
. "${SMITHERS_LIB:-/opt/smithers/lib.sh}"
[ "$#" -eq 1 ] || die "usage: upgrade.sh VERIFIED_PRE_UPGRADE_BACKUP"
load_database_url
: "${SMITHERS_DATA_ROOT:=/var/lib/smithers}"
export SMITHERS_DATA_ROOT; backup=$1
load_release; lock_maintenance; require_complete_upgrade; verify_backup "$backup"; state=$(state_file); [ -f "$state" ] || die "state version manifest is missing"
state_version=$(field "$state" SMITHERS_DISTRIBUTION_VERSION); state_schema=$(field "$state" SMITHERS_SCHEMA_VERSION); state_postgres=$(field "$state" SMITHERS_POSTGRES_MAJOR)
[ "$state_version" = "$(field "$backup/MANIFEST" SMITHERS_DISTRIBUTION_VERSION)" ] && [ "$state_schema" = "$(field "$backup/MANIFEST" SMITHERS_SCHEMA_VERSION)" ] && [ "$state_postgres" = "$(field "$backup/MANIFEST" SMITHERS_POSTGRES_MAJOR)" ] || die "backup does not match the installed pre-upgrade state"
[ "$state_postgres" = "$release_postgres" ] || die "PostgreSQL major upgrades require a separate dump and restore"
case "$state_schema:$release_schema" in *[!0-9:]*) die "schema versions must be numeric" ;; esac
[ "$state_schema" -le "$release_schema" ] || die "schema downgrade from ${state_schema} to ${release_schema} is refused"
[ "$state_version" != "$release_version" ] || die "state already matches image version ${release_version}"
marker="$SMITHERS_DATA_ROOT/.upgrade-incomplete"
printf '%s\n' "$backup" >"$marker"
sync "$marker"
sync "$SMITHERS_DATA_ROOT"
upgrade_failed() {
  printf 'upgrade failed; keep the app stopped and restore the verified pre-upgrade backup with its old image into an empty database and data volume: %s\nRecovery returns to the backup point; later changes are lost.\n' "$backup" >&2
  exit "$1"
}
if "${SMITHERS_BACKEND_BINARY:-/opt/smithers/bin/smithers-backend}" migrate apply 9>&-; then
  :
else
  migration_status=$?
  upgrade_failed "$migration_status"
fi
write_state || upgrade_failed "$?"
rm "$marker"
sync "$SMITHERS_DATA_ROOT"
printf 'upgraded %s to %s\n' "$state_version" "$release_version"
