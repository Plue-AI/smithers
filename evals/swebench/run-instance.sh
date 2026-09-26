#!/bin/bash
# Runs the flows built-in harness on one SWE-bench Verified instance.
#
#   run-instance.sh <instance_id> [model-seat] [timeout-seconds] [run-index]
#
# Produces work/<instance_id>/ (the agent workspace), patches/<instance_id>.patch
# (the model patch, empty if the agent changed nothing), timings/<instance_id>.json
# (wall clock, for the scorecard), logs-agent/<instance_id>.run.log, and
# journals/<instance_id>/ (the run's journal, copied out of the workspace).
#
# With a run index — `run-instance.sh <id> <seat> <budget> r3` — every one of
# those names carries `-r3`, journals/<instance_id>-r3/ included, so five runs
# of one instance coexist and each archive belongs to the patch beside it.
# `lib/run-paths.sh` owns the rule and both harnesses derive their names from
# it. A run
# given an index is a matrix run and deletes its extracted testbed once the patch
# is captured; a run without one keeps the workspace, which is what
# `regen-patch.sh` and the scorecard's default `--work work` read. See README,
# "Best-of-n".
#
# This spends real API tokens and needs docker, or, with SWB_TRANSPORT=plue, a
# Smithers Cloud account instead (lib/plue.py; README, "On Smithers Cloud").
#
# `./preflight.sh` must have pinned the subject first: every flows.sh call in
# here re-checks the pin, and the stamp is copied into the timings record so a
# scorecard can never attribute an instance to a subject it did not run.
set -euo pipefail
S="$(cd "$(dirname "$0")" && pwd)"
INSTANCE="${1:-}"
SEAT="${2:-openai:gpt-6-sol}"
BUDGET="${3:-1200}"
INDEX="${4:-}"
DATASET="${SWB_DATASET:-$S/swb-verified.json}"
# How the seat authenticates, handed down from the driver. `chatgpt` points the
# flows CLI at the codex session (ChatGPT plan) instead of OPENAI_API_KEY; the
# seat string is unchanged, so pricing stays on the committed table — derived,
# not billed. Recorded in the timings JSON so every instance names its basis.
OPENAI_AUTH="${SWB_FLOWS_OPENAI_AUTH:-api-key}"
case "$OPENAI_AUTH" in
  api-key|chatgpt) ;;
  *) echo "[$INSTANCE] SWB_FLOWS_OPENAI_AUTH must be 'api-key' or 'chatgpt', got '$OPENAI_AUTH'"; exit 2 ;;
esac

if [ ! -f "$DATASET" ]; then
  echo "[$INSTANCE] no dataset at $DATASET — run ./bootstrap.sh first"; exit 1
fi
# A configured helper takes precedence over the CLI's package/checkout
# resolver. Reject a broken override before a multi-GB image pull.
if [ -n "${SMITHERS_WORKSPACE_JJ_EXPORT_BINARY:-}" ] \
  && [ ! -x "$SMITHERS_WORKSPACE_JJ_EXPORT_BINARY" ]; then
  echo "[$INSTANCE] no executable workspace helper at $SMITHERS_WORKSPACE_JJ_EXPORT_BINARY" >&2
  exit 1
fi
BASE="$(node "$S/lib/validate-instance.mjs" "$DATASET" "$INSTANCE")" || exit $?
case "$BUDGET" in
  ''|*[!0-9]*) echo "[$INSTANCE] timeout must be a positive integer"; exit 2 ;;
  0) echo "[$INSTANCE] timeout must be a positive integer"; exit 2 ;;
esac

# The flows arm's host shell, as a condition the lane states rather than one a
# report assumes. The prompt tells the agent to name the testbed container, but
# the flows CLI binds no policy that refuses a `mode: "unhermetic"` call without
# one, so such a call runs model-authored shell on this host, with the docker
# socket in reach. Nothing here can confine it, so no agent starts until the
# lane opts in with SWB_FLOWS_HOST_SHELL=allowed, and the value is stamped into
# the timings beside the testbed network. See README, "The flows host shell".
#
# On plue the host shell is sealed instead: SMITHERS_BASH_CONTAINER names the
# workspace, the CLI refuses every `bash` call naming anything else, and it
# offers no host file flow. That is stamped as `sealed` and needs no opt-in.
TRANSPORT="$("$S/lib/transport.sh")" || exit 2
HOST_SHELL="${SWB_FLOWS_HOST_SHELL:-}"
if [ "$TRANSPORT" = "plue" ]; then HOST_SHELL=sealed; fi
if [ "${SWB_SKIP_AGENT:-0}" != "1" ] && [ "$HOST_SHELL" != "allowed" ] && [ "$HOST_SHELL" != "sealed" ]; then
  echo "[$INSTANCE] SWB_FLOWS_HOST_SHELL must be 'allowed', got '$HOST_SHELL': the flows bash flow runs container-less calls on this host unconfined"
  exit 2
fi

# Cross-run memory is a benchmark condition of its own, off by default. With
# SWB_MEMORY=repo the CLI opens its memory store at memory/<repo>.db, OUTSIDE
# the workspace and shared by every instance of one repository and by nothing
# else: a django run may remember how django runs its tests, and the next
# django run may be shown it, but a sphinx run never sees a django fact. A wave
# run this way is therefore not the independent-instance score the scoreboard
# reports, and the condition is stamped into the timings so a report can
# separate the two rather than average them. Any value other than `repo` or
# unset is refused here, the way an unknown auth mode is.
MEMORY="${SWB_MEMORY:-off}"
case "$MEMORY" in
  off|repo) ;;
  *) echo "[$INSTANCE] SWB_MEMORY must be unset or 'repo', got '$MEMORY'"; exit 2 ;;
esac
# The repository is the id up to its issue number: `django__django-16612` is a
# run of `django__django`. The id was validated by lib/validate-instance.mjs
# above with the character class lib/run-paths.sh uses, so the prefix is a
# safe file name.
REPO="$(printf '%s' "$INSTANCE" | sed -E 's/-[0-9]+$//')"
if [ "$MEMORY" = "repo" ]; then
  if ! printf '%s' "$REPO" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*__[A-Za-z0-9][A-Za-z0-9._-]*$'; then
    echo "[$INSTANCE] cannot derive a repository name from the instance id"; exit 2
  fi
  mkdir -p "$S/memory"
fi

# The subject the wave measures, pinned by ./preflight.sh. It is stamped into
# this instance's timings record so the scorecard can state which bytes each
# instance ran, and refuse to average two subjects into one wave.
if [ ! -f "$S/.subject.json" ]; then
  echo "[$INSTANCE] no subject pinned — run ./preflight.sh first"; exit 1
fi
SUBJECT="$(node -e '
  process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).stamp);
' "$S/.subject.json")"

IMAGE_ID="$(echo "$INSTANCE" | sed 's/__/_1776_/')"
IMAGE="swebench/sweb.eval.x86_64.${IMAGE_ID}:latest"

# Every artifact name this run writes, from the one place that knows the rule.
# `run-paths.sh` re-validates the instance id and the index before either
# reaches a path or a container name.
RUN_PATHS="$("$S/lib/run-paths.sh" flows "$INSTANCE" ${INDEX:+"$INDEX"})" || exit $?
eval "$RUN_PATHS"
mkdir -p "$WORK_ROOT" "$PATCH_ROOT" "$LOG_ROOT" "$TIMINGS_ROOT" "$VCS_ROOT"
WORK_ROOT="$(cd "$WORK_ROOT" && pwd -P)"
WORK="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1], process.argv[2]))' "$WORK_ROOT" "$(basename "$WORK")")"
if [ "$(dirname "$WORK")" != "$WORK_ROOT" ]; then
  echo "[$RUN_ID] resolved work path escaped $WORK_ROOT"; exit 2
fi

# The extraction lock is released by owner, never by whoever happens to be
# exiting: this trap is installed before the lock is taken, and `rmdir` here
# used to hand another lane's live extraction to a third one.
LOCK="$S/.extract-lock"
TMPC=""
WS=""
WS_KEY=""
SHIM_HOME=""
cleanup() {
  if [ "$TRANSPORT" = "plue" ]; then
    # The workspace goes however the run ends; its ledger slot with it.
    if [ -n "$WS" ]; then "$S/lib/plue.py" down "$WS" --key "$WS_KEY" || true; fi
    if [ -n "$SHIM_HOME" ]; then rm -rf -- "$SHIM_HOME"; fi
    return 0
  fi
  if [ -n "$TMPC" ]; then docker rm -f "$TMPC" >/dev/null 2>&1 || true; fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  "$S/lib/lock.sh" release "$LOCK" --owner $$ --quiet || true
}
on_signal() {
  trap '' INT TERM
  cleanup
  trap - EXIT INT TERM
  kill -s "$1" "$$"
}
trap cleanup EXIT
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

echo "[$RUN_ID] image $IMAGE"
TESTBED_NETWORK="$("$S/lib/testbed-network.sh" resolve)" || exit 2
if [ "$TRANSPORT" = "plue" ]; then
  # The testbed is a workspace booted from the official image: nothing is
  # pulled or extracted here. `up` waits for a slot in the ledger every
  # harness process on this host shares, holds it in this script's name, and
  # creates the workspace `--network none`. The host keeps only the flow file
  # and the journal; the checkout the agent edits is the guest's /testbed.
  UP="$("$S/lib/plue.py" up "$RUN_ID" "$IMAGE" --holder $$)" || {
    echo "[$RUN_ID] WORKSPACE START FAILED"; exit 1; }
  WS="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).id)' "$UP")"
  WS_KEY="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).key)' "$UP")"
  CONTAINER="$WS"
  echo "[$RUN_ID] workspace $WS"
  rm -rf -- "$WORK"; mkdir -p "$WORK"
  CAPTURE_BASE="$("$S/lib/plue.py" snapshot "$WS")" || {
    echo "[$RUN_ID] CAPTURE BASE FAILED"; exit 1; }
  echo "[$RUN_ID] capture base $CAPTURE_BASE (base commit $BASE)"
  # The harness's `docker exec` (and lib/interpreter.sh's) reaches the
  # workspace through the Harbor adapter's shim, first on PATH.
  SHIM_HOME="$(mktemp -d "${TMPDIR:-/tmp}/swb-shim.XXXXXX")"
  SHIM_BIN="$("$S/lib/plue.py" shim "$SHIM_HOME")" || { echo "[$RUN_ID] SHIM FAILED"; exit 1; }
  export PATH="$SHIM_BIN:$PATH"
elif ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker pull --platform linux/amd64 "$IMAGE" >"$LOG_PREFIX.pull.log" 2>&1 || {
    echo "[$RUN_ID] PULL FAILED"; exit 1; }
fi

# Extract the testbed the image ships so the agent edits a real checkout at the
# base commit, then bind it back over /testbed so the same tree is what the
# container's interpreter sees.
#
# Serialize the extraction across concurrent lanes: docker cp of a multi-GB tree
# is the disk-bandwidth spike, and five at once can fill the drive before any
# lane's cleanup runs.
#
# `lib/lock.sh` owns the protocol: the lock records this process's pid, a waiter
# takes it back the moment that pid is gone rather than spinning for ever on a
# lock a `kill -9` left behind, and the wait is bounded so a wedged lane fails
# this run instead of hanging it.
if [ "$TRANSPORT" = "docker" ]; then
  "$S/lib/lock.sh" acquire "$LOCK" --owner $$ --label "$RUN_ID extraction" || {
    echo "[$RUN_ID] EXTRACTION LOCK TIMED OUT"; exit 1; }
  rm -rf -- "$WORK"; mkdir -p "$WORK"
  # Name it before acquisition so interruption during docker create is covered.
  TMPC="${CONTAINER}-extract-$$"
  docker create --platform linux/amd64 --name "$TMPC" "$IMAGE" >/dev/null
  docker cp "$TMPC:/testbed/." "$WORK/" >/dev/null 2>&1
  docker rm -f "$TMPC" >/dev/null 2>&1
  TMPC=""
  "$S/lib/lock.sh" release "$LOCK" --owner $$

  # Anchor the patch capture to the tree as extracted, before anything of ours
  # touches it. Everything the official image already changed relative to the base
  # commit is in this commit, so it cannot reappear as if the agent had written
  # it. See lib/snapshot-base.sh.
  CAPTURE_BASE="$("$S/lib/snapshot-base.sh" "$WORK")"
  echo "[$RUN_ID] capture base $CAPTURE_BASE (base commit $BASE)"

  # The testbed container's network is a benchmark condition, and since 2026-08-24
  # the default is that it has none. `lib/testbed-network.sh` owns the rule and
  # documents why; the short version is that the codex arm's environment seal was
  # a seal on the tools an agent reaches for, and two `r90s` runs got round it with
  # a `docker exec <container> curl …` because the container kept its network. A
  # `--network none` testbed makes that impossible in the kernel rather than
  # improbable in an environment variable, and `docker exec` — which is how both
  # arms run the project's tests — is unaffected by it.
  docker rm -f "$CONTAINER" >/dev/null 2>&1
  docker run -d --platform linux/amd64 --name "$CONTAINER" --network "$TESTBED_NETWORK" \
    -v "$WORK:/testbed" -w /testbed "$IMAGE" sleep infinity >/dev/null 2>&1 || {
    echo "[$RUN_ID] CONTAINER START FAILED"; exit 1; }
fi

# What docker says the container is actually on, read back off the live
# container. A lane's claim about its testbed is worth what this line says and
# nothing more, so it is recorded rather than assumed — and a container that is
# not on the condition the lane asked for stops the run here, before a token is
# spent inside it.
TESTBED_OBSERVED="$("$S/lib/testbed-network.sh" assert "$CONTAINER" "$TESTBED_NETWORK")" || {
  echo "[$RUN_ID] TESTBED NETWORK MISMATCH — asked for $TESTBED_NETWORK"; exit 1; }
echo "[$RUN_ID] testbed network $TESTBED_OBSERVED"

# Keep the harness scaffolding out of the model patch.
#
# `.flows-test-base` is the `test` flow's baseline worktree, and
# `.flows-checkpoints` is where `ctx.checkpoint()` and `ctx.base` are
# materialized. Both are detached worktrees checked out INSIDE the workspace,
# and both are inside it for the same reason: /testbed is a bind mount of this
# directory, so a scratch checkout anywhere else on the host is not present in
# the container at all. Each is removed however its call ends, but a run killed
# at its wall-clock budget is killed between those two points often enough to
# matter, and a leftover second checkout of the whole repository is exactly what
# the prompt promises the agent `git status` will not show it.
if [ "$TRANSPORT" = "docker" ]; then
  printf 'flows/\n.flows/\n.jj/\nagent-run.log\n.flows-test-base/\n.flows-checkpoints/\n' >> "$WORK/.git/info/exclude"
fi

# The repository's own test runner, from the pinned evaluator's spec map. The
# rig used to prescribe `python -m pytest` for every repo; Django ships no
# pytest module and Sphinx runs under tox, so that command could not verify a
# fix in either, and an agent that cannot run a check cannot know it is done.
TEST_CMD="$("$S/.venv-swb/bin/python" "$S/lib/test-command.py" "$DATASET" "$INSTANCE")" || {
  echo "[$RUN_ID] NO TEST COMMAND — run ./bootstrap.sh first"; exit 1; }

# How this image runs the project's Python, read off the container it is about
# to run in. r91 spent 138 cells across 30 instances rediscovering this one
# path, because `interpreter: "python3"` resolves to a Python the repository's
# dependencies are not installed against. A fact the harness can measure at
# setup is stated once instead. A container that answers nothing usable simply
# leaves the bullet out; nothing here is fatal.
INTERPRETER="$("$S/lib/interpreter.sh" "$CONTAINER" 2>/dev/null)" || INTERPRETER=""
if [ -n "$INTERPRETER" ]; then
  echo "[$RUN_ID] project interpreter $INTERPRETER"
else
  echo "[$RUN_ID] project interpreter not measurable — the run discovers it"
fi

mkdir -p "$WORK/flows/fix"
SWB_TRANSPORT="$TRANSPORT" node "$S/lib/write-flow.mjs" "$DATASET" "$INSTANCE" "$SEAT" "$CONTAINER" "$TEST_CMD" "$INTERPRETER" \
  > "$WORK/flows/fix/flow.mdx"

# Version control for the harness, kept out of the task repository entirely.
#
# `flows` snapshots the working copy around every action through its `Jj` layer,
# and a COLOCATED jj repository writes those snapshots into `$WORK/.git`: it
# moves git's HEAD onto each settlement commit and exports one `refs/jj/keep/*`
# ref per visible change. `git log`, `git log --all -S` and `git fsck` then hand
# the agent its own attempt commits as if they were upstream history — measured
# on `django__django-13346` (~$0.54, two of them applied as a fake fix),
# `pydata__xarray-7229` (~$0.20, chased across three frames) and
# `django__django-13821` (~$0.06, `git show`-ed as evidence).
#
# Pointing jj at a bare git repository OUTSIDE the working copy fixes it at the
# source. jj keeps the same working copy, snapshots and restores exactly as
# before, and writes every commit, ref and object into `$VCS` instead. The task
# checkout's refs and object store are untouched, so `git log --all` and
# `git fsck` show only real history — and `git diff` starts working the way an
# agent expects, because jj no longer writes the task repository's index either.
# jj ignores `.git` in a non-colocated working copy, so the checkout's own
# history is never snapshotted.
#
# The scaffolding is excluded through the store's own `core.excludesFile`, which
# jj reads from its backing git repository. A colocated jj read the same list
# out of `$WORK/.git/info/exclude`; a non-colocated one has no reason to look
# there, and without this it would re-hash the growing journal database on every
# action snapshot.
#
# On plue the host directory holds only the flow and the journal, and it needs
# the repository all the same: it is what makes the directory the CLI's project
# root. Without one the CLI walks up to the nearest ancestor that has one (the
# operator's home, when the artifact root is under it) and finds no flow.
rm -rf -- "$VCS"
git init --bare --quiet "$VCS"
printf 'flows/\n.flows/\nagent-run.log\n.flows-test-base/\n.flows-checkpoints/\n' > "$VCS/flows-excludes"
git -C "$VCS" config core.excludesFile "$VCS/flows-excludes"
( cd "$WORK" && jj git init --git-repo="$VCS" >/dev/null 2>&1 )

# SWB_SKIP_AGENT=1 builds the workspace and captures its patch without running
# the agent or spending a token. The captured patch must then be empty, which is
# the standing proof that capture reports agent edits and nothing else. It
# writes no timings stamp, because no run happened to time.
if [ "${SWB_SKIP_AGENT:-0}" = "1" ]; then
  echo "[$RUN_ID] SWB_SKIP_AGENT=1 — no agent, capture proof only"
  RUN_STATUS=0
else
  echo "[$RUN_ID] agent start ($SEAT via $OPENAI_AUTH, ${BUDGET}s)"
  START=$(date +%s)
  set +e
  (
    cd "$WORK" || exit 1
    # How this repository runs its tests, declared to the CLI so the `test`
    # flow is in `ctx.flows` at all. Without a declaration the composition binds
    # no `test` flow, which is what r91 measured: zero `test` calls across 45
    # journals while the contract's doctrine assumed the call existed. The
    # container and the container-side path are the same ones `bash` uses, and
    # the pristine base the flow diffs against is the ref snapshot-base.sh
    # already wrote.
    #
    # The names are the CLI's own: `packages/smithers/src/Environment.ts` lists
    # every variable it reads, and nothing there begins with `FLOWS_`. The lane
    # exported `FLOWS_*` from 2026-08 until 2026-09-22, so the `test` flow was
    # never bound and the chatgpt seat fell back to the API key without a word.
    # `fixtures/check-env-names.mjs` refuses any export the CLI does not read.
    #
    # On plue the `test` flow is not declared: its baseline worktree is checked
    # out beside a host checkout, and there is none. The run is sealed to the
    # workspace instead, and the prompt states the test command.
    if [ "$TRANSPORT" = "plue" ]; then
      unset SMITHERS_TEST_COMMAND SMITHERS_TEST_CONTAINER SMITHERS_TEST_CWD
      export SMITHERS_BASH_CONTAINER="$WS"
    else
      export SMITHERS_TEST_COMMAND="$TEST_CMD"
      export SMITHERS_TEST_CONTAINER="$CONTAINER"
      export SMITHERS_TEST_CWD="/testbed"
    fi
    export SMITHERS_OPENAI_AUTH="$OPENAI_AUTH"
    # Conditional, and on a line of its own so fixtures/check-env-names.mjs
    # sees the name and holds it against the CLI's list.
    if [ "$MEMORY" = "repo" ]; then
      export SMITHERS_MEMORY_DB="$S/memory/$REPO.db"
    fi
    A=$("$S/flows.sh" --json plan fix | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(s).approval))}catch{process.exit(1)}})') || exit 1
    "$S/flows.sh" --json approve "$A" --scope run >/dev/null 2>&1 || {
      echo "[$RUN_ID] APPROVAL FAILED"; exit 1;
    }
    timeout "$BUDGET" "$S/flows.sh" --json run "$A"
  ) > "$LOG_PREFIX.run.log" 2>&1
  RUN_STATUS=$?
  set -e
  END=$(date +%s)
  echo "[$RUN_ID] agent done in $((END-START))s (status $RUN_STATUS)"

  # The wall clock the scorecard grades speed on. The journal's own span stops at
  # the last journaled event, which is not the same as how long the operator
  # waited for the process, so the process time is recorded here.
  # `testbedNetwork` is what the lane asked for and `testbedNetworkObserved` is
  # what `docker inspect` said the container was on. They are two fields rather
  # than one because a report that could only print the request would be
  # printing a claim; the ledger row and every scoreboard downstream carry the
  # observation. `hostShell` is the condition the agent's host-side shell ran
  # under; `allowed` is the only value an agent run can have today. `memory`
  # is the condition declared above; a report that pools a memory-on run with
  # the independent-instance score reads it. Whether the supervisor delivered
  # is the run's own `discipline-armed.judged`.
  printf '{\n  "instance_id": "%s",\n  "run_id": "%s",\n  "runIndex": "%s",\n  "seat": "%s",\n  "openaiAuth": "%s",\n  "subject": "%s",\n  "budgetSeconds": %s,\n  "transport": "%s",\n  "testbedNetwork": "%s",\n  "testbedNetworkObserved": "%s",\n  "hostShell": "%s",\n  "memory": "%s",\n  "startedAt": %s,\n  "endedAt": %s,\n  "wallClockSeconds": %s,\n  "exitStatus": %s,\n  "timedOut": %s\n}\n' \
    "$INSTANCE" "$RUN_ID" "$RUN_INDEX" "$SEAT" "$OPENAI_AUTH" "$SUBJECT" "$BUDGET" "$TRANSPORT" \
    "$TESTBED_NETWORK" "$TESTBED_OBSERVED" "$HOST_SHELL" "$MEMORY" "$((START*1000))" "$((END*1000))" "$((END-START))" \
    "$RUN_STATUS" "$([ "$RUN_STATUS" -eq 124 ] && printf true || printf false)" \
    > "$TIMINGS"
fi

# The model patch: the working tree against the capture base recorded before the
# agent started, with the harness scaffolding and build noise excluded.
if [ "$TRANSPORT" = "plue" ]; then
  "$S/lib/plue.py" capture "$WS" "$PATCH" || { echo "[$RUN_ID] PATCH CAPTURE FAILED"; exit 1; }
else
  "$S/lib/capture-patch.sh" "$WORK" "$PATCH" \
    ':(exclude)flows' ':(exclude).flows' ':(exclude).jj' ':(exclude)agent-run.log' \
    ':(exclude).flows-test-base' ':(exclude).flows-checkpoints' >/dev/null
fi

echo "[$RUN_ID] patch bytes: $(wc -c < "$PATCH" | tr -d ' ')"
echo "[$RUN_ID] untracked files left out of the patch: $(wc -l < "$PATCH.untracked" | tr -d ' ')"

# The journal, copied out of the workspace it lived in. It is the run's whole
# record — every frame, call, measurement and demand — and until now it only
# ever existed inside a workspace the next wave overwrites. The selector reads
# these and nothing else, so they outlive the tree they were written in.
#
# The CLI journals into two databases: `engine.db` holds the engine's events
# and `control.db` every `control.agent.*` event, which is the run's frames,
# calls and model usage. Both travel; `lib/journal-rows.mjs` reads them as one.
# The write-ahead log and shared-memory files travel with each database. The
# run process has exited by here, so the log is normally already folded in, and
# copying them costs nothing and cannot lose a tail that is not.
if [ -f "$WORK/.flows/engine.db" ]; then
  mkdir -p "$JOURNAL"
  for FILE in engine.db engine.db-wal engine.db-shm control.db control.db-wal control.db-shm; do
    if [ -f "$WORK/.flows/$FILE" ]; then cp "$WORK/.flows/$FILE" "$JOURNAL/$FILE"; fi
  done
  echo "[$RUN_ID] journal archived to ${JOURNAL#"$S/"}"
fi

# The extracted testbed, once nothing else needs it. A matrix run — one given a
# run index — produces five workspaces per instance and would otherwise keep all
# of them for the whole wave; the patch is captured and the journal is archived
# by this point, so what is left is a checkout the images can reproduce.
#
# A run without an index keeps its workspace: `regen-patch.sh` re-derives a
# patch from it and the scorecard's default `--work work` reads its journal in
# place, and neither may be broken by a change made for the matrix.
# SWB_KEEP_WORKSPACE=1 keeps a matrix run's workspace for debugging;
# SWB_DELETE_WORKSPACE=1 deletes an unindexed run's.
DELETE_WORKSPACE=0
if [ -n "$INDEX" ]; then DELETE_WORKSPACE=1; fi
if [ "${SWB_KEEP_WORKSPACE:-0}" = "1" ]; then DELETE_WORKSPACE=0; fi
if [ "${SWB_DELETE_WORKSPACE:-0}" = "1" ]; then DELETE_WORKSPACE=1; fi
if [ "$DELETE_WORKSPACE" = "1" ]; then
  if [ "$TRANSPORT" = "docker" ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
  rm -rf -- "$WORK" "$VCS"
  echo "[$RUN_ID] testbed deleted"
fi

exit "$RUN_STATUS"
