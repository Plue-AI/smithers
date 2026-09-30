#!/bin/sh
set -eu
umask 077
smithers_lib=${SMITHERS_LIB:-/opt/smithers/lib.sh}
die() { printf '%s\n' "$*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"; }
load_database_url() {
  if [ -z "${SMITHERS_DATABASE_URL:-}" ] && [ -n "${DATABASE_URL:-}" ]; then
    SMITHERS_DATABASE_URL=$DATABASE_URL
    export SMITHERS_DATABASE_URL
  fi
  [ -n "${SMITHERS_DATABASE_URL:-}" ] || die "SMITHERS_DATABASE_URL or DATABASE_URL is required"
  split_database_password
}
# Decodes a libpq URI component into $decoded. The value reaches awk through
# the environment, never argv, because it is a password.
percent_decode() {
  decoded=$(smithers_encoded=$1 LC_ALL=C awk 'BEGIN {
    s = ENVIRON["smithers_encoded"]; hex = "0123456789abcdef"
    while ((i = index(s, "%")) > 0) {
      printf "%s", substr(s, 1, i - 1)
      a = index(hex, tolower(substr(s, i + 1, 1))); b = index(hex, tolower(substr(s, i + 2, 1)))
      if (a == 0 || b == 0 || (a == 1 && b == 1)) exit 1
      printf "%c", (a - 1) * 16 + b - 1
      s = substr(s, i + 3)
    }
    printf "%s", s
  }' && printf x) || die "database URL has an invalid percent-encoding"
  decoded=${decoded%x}
}
# psql, pg_dump and pg_restore take the URL without its password, which moves
# to PGPASSWORD: /proc/<pid>/cmdline is readable by every host user, environ
# only by the same uid. libpq ends the userinfo at the first '@' before any '/',
# starts the query at the next '?', percent-decodes query keys and values, and
# lets a password= query parameter override the userinfo password.
split_database_password() {
  # shellcheck disable=SC2034 # read by entrypoint.sh, backup.sh and restore.sh
  smithers_pg_url=$SMITHERS_DATABASE_URL
  case "$SMITHERS_DATABASE_URL" in postgres://*|postgresql://*) ;; *) return 0 ;; esac
  pg_scheme=${SMITHERS_DATABASE_URL%%://*}; pg_rest=${SMITHERS_DATABASE_URL#*://}; pg_authority=${pg_rest%%/*}; pg_prefix=
  case "$pg_authority" in
    *@*)
      pg_userinfo=${pg_authority%%@*}; pg_rest=${pg_rest#*@}
      case "$pg_userinfo" in
        *:*) percent_decode "${pg_userinfo#*:}"; PGPASSWORD=$decoded; export PGPASSWORD; pg_userinfo=${pg_userinfo%%:*} ;;
      esac
      [ -z "$pg_userinfo" ] || pg_prefix="${pg_userinfo}@" ;;
  esac
  case "$pg_rest" in
    *\?*)
      pg_query=${pg_rest#*\?}; pg_rest=${pg_rest%%\?*}; pg_kept=
      while :; do
        pg_param=${pg_query%%&*}
        percent_decode "${pg_param%%=*}"
        if [ "$decoded" = password ] && [ "$pg_param" != "${pg_param#*=}" ]; then
          percent_decode "${pg_param#*=}"; PGPASSWORD=$decoded; export PGPASSWORD
        else pg_kept="$pg_kept&$pg_param"; fi
        case "$pg_query" in *\&*) pg_query=${pg_query#*&} ;; *) break ;; esac
      done
      pg_kept=${pg_kept#&}; pg_rest="$pg_rest${pg_kept:+?$pg_kept}" ;;
  esac
  # shellcheck disable=SC2034 # read by entrypoint.sh, backup.sh and restore.sh
  smithers_pg_url="${pg_scheme}://${pg_prefix}${pg_rest}"
}
field() {
  file=$1 key=$2
  value=$(sed -n "s/^${key}=//p" "$file")
  [ -n "$value" ] || die "missing ${key} in ${file}"
  case "$value" in *[!A-Za-z0-9._+-]*) die "invalid ${key} in ${file}" ;; esac
  printf '%s\n' "$value"
}
load_release() {
  release_file=${SMITHERS_RELEASE_FILE:-/opt/smithers/version.env}
  [ -f "$release_file" ] || die "distribution version manifest is unavailable: $release_file"
  release_version=$(field "$release_file" SMITHERS_DISTRIBUTION_VERSION)
  release_schema=$(field "$release_file" SMITHERS_SCHEMA_VERSION)
  release_postgres=$(field "$release_file" SMITHERS_POSTGRES_MAJOR)
}
state_file() { printf '%s/version.env\n' "$SMITHERS_DATA_ROOT"; }
require_complete_upgrade() {
  [ ! -e "$SMITHERS_DATA_ROOT/.upgrade-incomplete" ] || die "upgrade incomplete; keep the app stopped and restore the verified pre-upgrade backup with its old image into an empty database and data volume"
}
write_state() {
  destination=$(state_file); temporary="${destination}.tmp.$$"; umask 077
  { printf 'SMITHERS_DISTRIBUTION_VERSION=%s\n' "$release_version"; printf 'SMITHERS_SCHEMA_VERSION=%s\n' "$release_schema"; printf 'SMITHERS_POSTGRES_MAJOR=%s\n' "$release_postgres"; } >"$temporary" || return "$?"
  sync "$temporary" || return "$?"
  mv "$temporary" "$destination" || return "$?"
  sync "$SMITHERS_DATA_ROOT"
}
verify_state_matches_release() {
  require_complete_upgrade
  state=$(state_file); [ -f "$state" ] || die "state version manifest is missing; restore it with the data or initialize an empty installation"
  state_version=$(field "$state" SMITHERS_DISTRIBUTION_VERSION); state_schema=$(field "$state" SMITHERS_SCHEMA_VERSION); state_postgres=$(field "$state" SMITHERS_POSTGRES_MAJOR)
  [ "$state_version" = "$release_version" ] || die "state version ${state_version} requires an explicit upgrade to ${release_version}"
  [ "$state_schema" = "$release_schema" ] || die "state schema ${state_schema} is incompatible with image schema ${release_schema}; restore a verified backup or run the explicit upgrade"
  [ "$state_postgres" = "$release_postgres" ] || die "backup tools require PostgreSQL ${release_postgres}, state declares ${state_postgres}"
}
lock_maintenance() {
  require flock; mkdir -p "$SMITHERS_DATA_ROOT"; chmod 700 "$SMITHERS_DATA_ROOT"
  exec 9>"$SMITHERS_DATA_ROOT/.maintenance.lock"; flock -n 9 || die "Smithers is running; stop the app container before maintenance"
}
sha256_file() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
verify_backup() {
  backup=$1; [ -d "$backup" ] || die "backup directory does not exist: $backup"
  [ -f "$backup/MANIFEST" ] && [ -f "$backup/postgres.dump" ] && [ -f "$backup/files.tar" ] || die "backup is incomplete"
  [ "$(sha256_file "$backup/postgres.dump")" = "$(field "$backup/MANIFEST" POSTGRES_SHA256)" ] || die "PostgreSQL dump checksum failed"
  [ "$(sha256_file "$backup/files.tar")" = "$(field "$backup/MANIFEST" FILES_SHA256)" ] || die "file archive checksum failed"
  tar -tf "$backup/files.tar" | awk '/(^\/|(^|\/)\.\.($|\/))/ { bad=1 } END { exit bad }' || die "file archive contains an unsafe path"
}
# Succeeds when the archive path $2 resolves inside $1, following every link
# on the way. Links are relative to the directory holding them; absolute links,
# a climb above $1, and link loops are refused.
path_stays_inside() {
  root=$1 rest=$2 cur='' hops=0
  while [ -n "$rest" ]; do
    case $rest in */*) part=${rest%%/*}; rest=${rest#*/} ;; *) part=$rest; rest= ;; esac
    case $part in
      '' | .) ;;
      ..) [ -n "$cur" ] || return 1; case $cur in */*) cur=${cur%/*} ;; *) cur= ;; esac ;;
      *)
        next=${cur:+$cur/}$part
        if [ -L "$root/$next" ]; then
          hops=$((hops + 1)); [ "$hops" -le 40 ] || return 1
          target=$(readlink "$root/$next"); case $target in /*) return 1 ;; esac
          rest=$target${rest:+/$rest}
        else cur=$next; fi ;;
    esac
  done
}
# A restored tree is published into the live data root, so no link in it may
# lead outside: the backend would read and write through it.
verify_staged_links() {
  staged=$1
  find "$staged" -type l -exec sh -c '. "$0"; root=$1; shift; for link; do name=${link#"$root"/}; path_stays_inside "$root" "$name" || die "file archive link leaves the data root: $name"; done' "$smithers_lib" "$staged" {} + || die "file archive contains an unsafe link"
}
