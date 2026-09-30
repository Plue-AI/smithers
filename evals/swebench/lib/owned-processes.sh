#!/bin/bash
# Process ownership for the dry runs, sourced by `fullbench-dryrun.sh` and
# `codex-backfill-dryrun.sh`: kill only what this invocation started.
#
#   . "$S/lib/owned-processes.sh"
#   kill_owned "$TMP" [pid...]
#
# Every dry run uses the same instance ids and the same rig scripts, so a
# command-line pattern such as `fullbench-instance.sh stubfull__` also selects
# another invocation's workers — or an unrelated process that merely looks like
# one. Ownership is therefore read from this invocation's own records: the pids
# it launched, the pid files its drivers, workers and claims wrote under its
# private temporary directory, and processes whose arguments name that
# directory. Each of those is killed with every descendant it has, collected
# before the first signal so a parent's death cannot orphan a child out of reach.
#
# A pid read from a file is used only while its command line still names this
# rig or the temporary directory, so a recycled pid is never signalled. A dry
# run that fails before it starts anything owns nothing and kills nothing.

# PID and every live descendant, parents first.
tree_pids() {
  local pid child
  for pid in "$@"; do
    case "$pid" in '' | *[!0-9]*) continue ;; esac
    kill -0 "$pid" 2>/dev/null || continue
    printf '%s\n' "$pid"
    for child in $(pgrep -P "$pid" 2>/dev/null); do tree_pids "$child"; done
  done
}

# True while PID's command line names this rig (S) or the temporary directory.
names_ours() {
  local command
  command="$(ps -o command= -p "$1" 2>/dev/null)" || return 1
  case "$command" in *"$S/"* | *"$2"*) return 0 ;; esac
  return 1
}

# kill_owned TMP [PID...]: SIGKILL the given pids, every recorded pid under TMP
# that still names this rig or TMP, every process whose arguments name TMP, and
# all of their descendants. Never this shell.
kill_owned() {
  local tmp="$1" pid file
  shift
  local roots=("$@")
  if [ -d "$tmp" ]; then
    while IFS= read -r file; do
      pid="$(cat "$file" 2>/dev/null || printf '')"
      case "$pid" in '' | *[!0-9]*) continue ;; esac
      if names_ours "$pid" "$tmp"; then roots+=("$pid"); fi
    done < <(find "$tmp" -type f \( -name '*.pid' -o -name pid \) 2>/dev/null)
    for pid in $(pgrep -f -- "$tmp/" 2>/dev/null); do roots+=("$pid"); done
  fi
  [ "${#roots[@]}" -gt 0 ] || return 0
  local victims=()
  for pid in $(tree_pids "${roots[@]}" | sort -u); do
    if [ "$pid" != "$$" ] && [ "$pid" != "${BASHPID:-$$}" ]; then victims+=("$pid"); fi
  done
  [ "${#victims[@]}" -gt 0 ] || return 0
  kill -9 "${victims[@]}" >/dev/null 2>&1 || true
}
