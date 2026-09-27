#!/bin/sh
set -eu
# shellcheck disable=SC1090
. "${SMITHERS_LIB:-/opt/smithers/lib.sh}"
load_database_url
: "${SMITHERS_DATA_ROOT:=/var/lib/smithers}"
if [ -n "${SMITHERS_AUTH_MODE:-}" ] && [ "$SMITHERS_AUTH_MODE" != selfhost ]; then
  die "the public distribution requires SMITHERS_AUTH_MODE=selfhost"
fi
SMITHERS_AUTH_MODE=selfhost
export SMITHERS_DATA_ROOT
export SMITHERS_AUTH_MODE
load_release
require flock
require sha256sum
mkdir -p "$SMITHERS_DATA_ROOT"
chmod 700 "$SMITHERS_DATA_ROOT"
exec 9>"$SMITHERS_DATA_ROOT/.maintenance.lock"
flock -n 9 || die "Smithers maintenance is running; wait for it to finish before starting"
backend=${SMITHERS_BACKEND_BINARY:-/opt/smithers/bin/smithers-backend}
for item in "$backend" /opt/smithers/bin/node /opt/smithers/bin/smithers-coding-host /opt/smithers/bin/smithers-model-host /opt/smithers/bin/smithers-jj-export /opt/smithers/bin/jj /opt/smithers/git/bin/git pg_dump pg_restore psql; do [ -x "$item" ] || command -v "$item" >/dev/null 2>&1 || die "packaged runtime is unavailable: $item"; done
[ -f /opt/smithers/web/index.html ] || die "packaged web application is unavailable"
[ -r /opt/smithers/bin/flow-hosts.json ] || die "packaged Flow host manifest is unavailable"
(cd /opt/smithers/bin && sha256sum -c smithers-coding-host.sha256 smithers-model-host.sha256 >/dev/null) || die "packaged host checksum failed"
export SMITHERS_WEB_ROOT=/opt/smithers/web
export SMITHERS_WORKSPACE_CODING_HOST_BINARY=/opt/smithers/bin/smithers-coding-host
export SMITHERS_MODEL_HOST_BUNDLE=/opt/smithers/bin/smithers-model-host
export SMITHERS_NODE_BINARY=/opt/smithers/bin/node
export SMITHERS_FLOW_HOST_MANIFEST=/opt/smithers/bin/flow-hosts.json
export SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=/opt/smithers/bin/smithers-jj-export
export SMITHERS_CODING_LOCAL_OWNER=1
export SMITHERS_JJ_PATH=/opt/smithers/bin/jj
export SMITHERS_FFI_LIBRARY_PATH=/opt/smithers/lib/libsmithers_ffi.so
export PATH="/opt/smithers/bin:/opt/smithers/git/bin:/usr/lib/postgresql/18/bin:$PATH"
state=$(state_file)
if [ ! -f "$state" ]; then
  [ -z "$(find "$SMITHERS_DATA_ROOT" -mindepth 1 -maxdepth 1 ! -name '.maintenance.lock' -print -quit)" ] || die "unversioned Smithers data exists; restore its version.env before starting"
  table_count=$(psql --dbname="$SMITHERS_DATABASE_URL" -v ON_ERROR_STOP=1 -Atqc "select count(*) from pg_catalog.pg_tables where schemaname not in ('pg_catalog','information_schema')" 9>&-)
  [ "$table_count" = 0 ] || die "database is not empty but state version.env is missing"
  "$backend" migrate apply 9>&-
  write_state
else
  verify_state_matches_release
  "$backend" migrate apply 9>&-
fi
mkdir -p "$SMITHERS_DATA_ROOT/repositories" "$SMITHERS_DATA_ROOT/blobs" "$SMITHERS_DATA_ROOT/workspaces" "$SMITHERS_DATA_ROOT/config"
chmod 700 "$SMITHERS_DATA_ROOT" "$SMITHERS_DATA_ROOT"/*
"$backend" "$@" 9>&- &
child=$!
# shellcheck disable=SC2329
shutdown() {
  trap - HUP INT TERM
  kill -TERM "$child" 2>/dev/null || true
  set +e
  wait "$child"
  status=$?
  set -e
  exit "$status"
}
trap shutdown HUP INT TERM
set +e
wait "$child"
status=$?
set -e
trap - HUP INT TERM
exit "$status"
