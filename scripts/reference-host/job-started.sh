#!/bin/sh
# Job-started hook for the reference-host self-hosted runner (#3471).
#
# The runner runs this file before the first step of every job, as the
# `ghrunner` user, through ACTIONS_RUNNER_HOOK_JOB_STARTED in the runner's
# .env. setup-runner.sh installs it root:wheel 0555 at
# /usr/local/libexec/smithers-reference-host/job-started.sh, so a job cannot
# rewrite the guard that admits the next one.
#
# GUARD. The organization is on the free plan, which has no runner groups and
# so no "allowed workflows" list. Any workflow file, including one a fork pull
# request adds, can name `runs-on: [self-hosted, reference-host]`. This hook is
# the control that refuses it: a nonzero exit fails the job before any step
# runs. A job is admitted only when every one of these holds:
#
#   GITHUB_REPOSITORY   = smithersai/smithers
#   GITHUB_EVENT_NAME   = push or workflow_dispatch
#   GITHUB_REF          = refs/heads/main
#   GITHUB_WORKFLOW_REF = smithersai/smithers/.github/workflows/reference-host.yml@refs/heads/main
#
# The workflow ref is compared exactly, not as a prefix, so a branch named
# `main-x` cannot match. GITHUB_* values are set by the runner; a workflow's
# `env:` cannot override them.
#
# WIPE. After admission it removes what a previous job left behind: everything
# under the runner's _work directory except the current job's _actions and
# _temp (the runner rebuilt both for this job before calling the hook) and the
# workspace directory itself, whose contents are emptied; ghrunner's TMPDIR;
# ~/Library/Caches; and every process ghrunner owns that is not this hook, its
# children, or the runner chain that started it.
#
# Decision record: smithers-3f, #3471 issuecomment-6020436303 (persistent
# runner, wipe before every job, no stored minting credential). A pull-request
# trigger on the reference-host workflow reverses that decision.
set -u

expected_repository=smithersai/smithers
expected_ref=refs/heads/main
expected_workflow_ref=smithersai/smithers/.github/workflows/reference-host.yml@refs/heads/main
runner_user=ghrunner

refuse() {
  echo "reference-host guard: refused: $1" >&2
  echo "reference-host guard: this runner only runs $expected_workflow_ref on push or workflow_dispatch" >&2
  exit 1
}

[ "${GITHUB_REPOSITORY:-}" = "$expected_repository" ] ||
  refuse "GITHUB_REPOSITORY is '${GITHUB_REPOSITORY:-}', not '$expected_repository'"
case "${GITHUB_EVENT_NAME:-}" in
  push | workflow_dispatch) ;;
  *) refuse "GITHUB_EVENT_NAME is '${GITHUB_EVENT_NAME:-}', not push or workflow_dispatch" ;;
esac
[ "${GITHUB_REF:-}" = "$expected_ref" ] ||
  refuse "GITHUB_REF is '${GITHUB_REF:-}', not '$expected_ref'"
[ "${GITHUB_WORKFLOW_REF:-}" = "$expected_workflow_ref" ] ||
  refuse "GITHUB_WORKFLOW_REF is '${GITHUB_WORKFLOW_REF:-}', not '$expected_workflow_ref'"
[ -z "${GITHUB_HEAD_REF:-}" ] ||
  refuse "GITHUB_HEAD_REF is '${GITHUB_HEAD_REF}', so this is a pull-request job"

echo "reference-host guard: admitted $GITHUB_WORKFLOW_REF ($GITHUB_EVENT_NAME, ${GITHUB_SHA:-unknown sha})"

# Remove every entry of directory $1 except the names listed after it.
empty_dir() {
  dir=$1
  shift
  [ -d "$dir" ] || return 0
  for entry in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name=${entry##*/}
    keep=0
    for kept in "$@"; do [ "$name" = "$kept" ] && keep=1; done
    [ "$keep" -eq 1 ] && continue
    rm -rf -- "$entry" && echo "reference-host wipe: removed $entry"
  done
}

# Everything below deletes files and kills processes, so it runs only as
# ghrunner. Anywhere else, "this user's TMPDIR, caches and processes" is a
# person's session. The unit test sets REFERENCE_HOST_HOOK_FIXTURE=1 to wipe a
# fixture layout named by RUNNER_WORKSPACE, GITHUB_WORKSPACE, HOME and TMPDIR;
# fixture mode never kills processes and never asks the OS for the temp dir.
fixture=${REFERENCE_HOST_HOOK_FIXTURE:-0}
if [ "$(id -un)" != "$runner_user" ] && [ "$fixture" != 1 ]; then
  echo "reference-host wipe: not $runner_user, so nothing wiped"
  exit 0
fi

: "${RUNNER_WORKSPACE:?RUNNER_WORKSPACE is unset; the runner always sets it}"
: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is unset; the runner always sets it}"
work=${RUNNER_WORKSPACE%/*}
workspace_repo=${RUNNER_WORKSPACE##*/}
workspace_name=${GITHUB_WORKSPACE##*/}

# _work/<repo>/<repo> is this job's checkout directory: keep the directory,
# drop its contents. Every other repository directory and every stale
# top-level entry goes.
empty_dir "$work" _actions _temp "$workspace_repo"
empty_dir "$RUNNER_WORKSPACE" "$workspace_name"
empty_dir "$GITHUB_WORKSPACE"

user_tmp=${TMPDIR:-}
if [ "$fixture" != 1 ] && [ "$(uname -s)" = Darwin ]; then
  user_tmp=$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || printf '%s' "$user_tmp")
fi
[ -n "$user_tmp" ] && empty_dir "${user_tmp%/}"
empty_dir "$HOME/Library/Caches"

if [ "$fixture" = 1 ]; then
  echo "reference-host wipe: fixture mode, so no processes killed"
  exit 0
fi
# Kill every ghrunner process a previous job left behind: everything except
# this hook, its own children (the ps pipeline below) and the runner chain
# that started it. Apple's SIP-protected per-user agents are left alone.
uid=$(id -u)
chain=" $$ "
pid=$$
while [ "$pid" -gt 1 ]; do
  pid=$(ps -o ppid= -p "$pid" | tr -d ' ')
  [ -n "$pid" ] || break
  chain="$chain$pid "
done
ps -axo pid=,ppid=,uid=,comm= | while read -r pid ppid owner comm; do
  [ "$owner" = "$uid" ] || continue
  case "$chain" in *" $pid "*) continue ;; esac
  [ "$ppid" = "$$" ] && continue
  case "$comm" in /System/* | /usr/libexec/* | /usr/sbin/*) continue ;; esac
  kill -9 "$pid" 2>/dev/null && echo "reference-host wipe: killed $pid $comm"
done
exit 0
