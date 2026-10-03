#!/bin/sh
# Run repository checks against the exported revision, with its own lockfile
# and workspace-local build CLI. Never resolve declarations against the editor.
set -eu
export HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
# `drift` runs the cheap per-commit drift gates (formatting, target index,
# generated API and docs, declaration baseline) so drift surfaces as its own
# check within minutes instead of inside the full graph. The list mirrors the
# `driftCi` steps in PACKAGE.ts, which scripts/ci/drift-job.test.mjs enforces.
drift=0
[ "${1:-}" = drift ] && drift=1
drift_gates="lint //...:fmt
lint //:targetIndex
lint //:openapiBundle
lint //:openapiClients
lint //scripts:docsDrift
build //scripts:apiBaseline
lint //scripts:conflictMarkers
lint //scripts:trackedHygiene
lint //:driftCi"
if [ "${1:-}" = affected ]; then
  if [ -z "${SMITHERS_CHECK_FILES+set}" ]; then
    echo 'An affected check needs SMITHERS_CHECK_FILES from its check host.' >&2
    exit 2
  fi
  if [ -z "$SMITHERS_CHECK_FILES" ]; then
    echo 'The Change wrote no files; no target is affected.' >&2
    exit 0
  fi
fi
# Every check runs in a fresh export. Target results and downloaded packages
# persist in a host check cache (scripts/ci/check-cache.mjs) so a rebased
# revision replays every target whose content key is unchanged. The Bun cache
# is content-addressed and dedicated to checks, never the developer's own.
cache_root="${SMITHERS_CHECK_CACHE_DIR:-$HOME/.cache/smithers-checks/cache}"
export BUN_INSTALL_CACHE_DIR="$cache_root/bun"
# Bun can stop making progress after populating its cache. Bound bootstrap
# independently of the test deadline and retry only a timed-out installation.
install_attempt=1
while :; do
  install_status=0
  timeout --kill-after=5s "${SMITHERS_CHECK_INSTALL_TIMEOUT:-120s}" bun install --frozen-lockfile >&2 || install_status=$?
  [ "$install_status" -eq 0 ] && break
  case "$install_status" in
    124|137)
      [ "$install_attempt" -lt 2 ] || exit "$install_status"
      echo 'Dependency installation timed out; retrying once.' >&2
      install_attempt=$((install_attempt + 1))
      ;;
    *) exit "$install_status" ;;
  esac
done
# A cache failure only costs reuse, never the check's own verdict.
node scripts/ci/check-cache.mjs seed . || echo 'Check cache unavailable; running cold.' >&2
# The check is a child rather than exec'd so the cache can be saved after it;
# forward termination so signalling this wrapper still stops the check.
# `affected <verb> <patterns...>` runs only the targets the Change's written
# paths (SMITHERS_CHECK_FILES, one per line, from the check host) affect, and
# fails only on a target that is red and not on the known-red list. Anything
# else runs `test` on the named targets.
if [ "$drift" = 0 ] && [ "${1:-}" = affected ]; then
  shift
  set -- affected "$@" --known-red .github/ci-known-red.json
  newline='
'
  old_ifs=$IFS
  IFS=$newline
  # A written path is a name, never a pattern: `app/[id].tsx` stays itself.
  set -f
  for file in $SMITHERS_CHECK_FILES; do
    set -- "$@" --files "$file"
  done
  set +f
  IFS=$old_ifs
elif [ "$drift" = 1 ]; then
  :
else
  set -- test "$@"
fi
cli=packages/smithers/build/build-cli/src/main.js
test_status=0
if [ "$drift" = 1 ]; then
  # Every gate runs even after one fails, so a single verdict names all the
  # drift a commit carries. Each gate is judged by the known-red list, as the
  # generated drift workflow judges it.
  while IFS=' ' read -r verb pattern; do
    node "$cli" "$verb" "$pattern" --known-red .github/ci-known-red.json &
    check_pid=$!
    trap 'kill -TERM "$check_pid" 2>/dev/null; wait "$check_pid"; exit 143' TERM INT HUP
    gate_status=0
    wait "$check_pid" || gate_status=$?
    trap - TERM INT HUP
    [ "$gate_status" -eq 0 ] || { echo "Drift gate failed: $verb $pattern" >&2; test_status=1; }
  done <<EOF_GATES
$drift_gates
EOF_GATES
else
  node "$cli" "$@" &
  check_pid=$!
  trap 'kill -TERM "$check_pid" 2>/dev/null; wait "$check_pid"; exit 143' TERM INT HUP
  wait "$check_pid" || test_status=$?
  trap - TERM INT HUP
fi
node scripts/ci/check-cache.mjs save . || echo 'Check cache could not be saved.' >&2
exit "$test_status"
