#!/bin/bash
# One codex attempt on every instance the full benchmark graded.
#
#   ./codex-backfill.sh                 every instance still owed one, in order
#   ./codex-backfill.sh --one <id>      exactly one instance (how a pipeline calls it)
#   ./codex-backfill.sh --jobs 2        run that many instances at once
#   ./codex-backfill.sh --lane sealed   the same population under the sealed condition
#   ./codex-backfill.sh --lane sealed-high   the sealed condition at high reasoning effort
#   ./codex-backfill.sh --list          what is left, and stop
#   ./codex-backfill.sh --status        counts, and stop
#   ./codex-backfill.sh --table         every instance, our verdict and codex's
#
# Every mode takes `--lane`, and it has to: `--status` on the wrong lane reads
# the wrong ledger.
#
# The full benchmark measures the flows harness on all 500 instances. It says
# nothing on its own: a resolved rate is a number about a benchmark until there
# is a second harness on the same instances under the same conditions. This runs
# that second harness over exactly the instances our side has already graded, so
# the two populations are the same set rather than two overlapping samples.
#
# Per instance, in one process, the same shape `lib/fullbench-instance.sh` uses
# and for the same reason — nothing multi-gigabyte may outlive the instance that
# needed it:
#
#   claim -> slot -> disk gate -> pull -> codex run -> archive -> grade -> delete
#
# **Grading happens here, while the image is still local.** Collecting 43 patches
# and grading them afterwards needs every image a second time.
#
# ## Concurrency
#
# `--one` is the unit. A pipeline runs many of them at once, and they share one
# docker daemon, one disk and one evaluator, so the docker-heavy span of an
# instance — its pull, its run, its grading and its delete — is held inside a
# **two-slot semaphore** at `fullbench/.codex-slots`. Two is what the full
# benchmark already proved this machine sustains: two extractions and two
# testbeds fit in the disk gate's 8 GiB headroom and a third does not.
#
# The semaphore is two `lib/lock.sh` locks rather than `flock`, for two reasons.
# `flock(1)` is a util-linux program and is not on macOS, which is the host this
# rig runs on. And a slot has to survive its holder being killed with `-9`: a
# `lib/lock.sh` slot records the holder's pid, so the next waiter takes a dead
# holder's slot on its next poll, while a lock released only by descriptor
# closure tells a waiter nothing about who is gone. That is the same protocol
# the extraction lock and the evaluator lock already use here.
#
# One instance is also claimed by pid, exactly as `lib/fullbench-instance.sh`
# claims its own: two invocations naming one id would be two paid agents writing
# one patch path.
#
# ## Resume
#
# `fullbench/codex-manifest.jsonl` is the ledger, append-only and fsynced.
# **An id with a verdict there is a no-op** — the script exits 0 without
# touching docker. A `started` row (a kill mid-instance) and a `failed` row both
# carry no verdict, so both are retried from the top on the next pass, and the
# retry purges the dead attempt's artifacts and its evaluator report first.
#
# This spends real API tokens and needs docker. See README.md, "The codex
# backfill".
set -u
S="$(cd "$(dirname "$0")" && pwd)"
FB="${FB_DIR:-$S/fullbench}"

# ---------------------------------------------------------------------------
# Lanes
#
# A lane is one measurement of the population under one condition. It moves four
# things at once — the archive, the ledger, the run index and the evaluator run
# id — plus the conditions the runs are given, because a lane that moved only
# some of them would grade one condition's patches into another condition's run
# id and no artifact would say so. `run-45.sh` names its lanes the same way and
# for the same reason.
#
# | lane | archive | ledger | index | evaluator run id | network | effort | testbed |
# | --- | --- | --- | --- | --- | --- | --- | --- |
# | `net` (default) | `fullbench/codex/` | `codex-manifest.jsonl` | `r90c` | `fullbench-codex` | `on` | `medium` | `bridge` |
# | `sealed` | `fullbench/codex-sealed/` | `codex-sealed-manifest.jsonl` | `r90s` | `fullbench-codex-sealed` | `sealed` | `medium` | `bridge` |
# | `sealed-high` | `fullbench/codex-sealed-high/` | `codex-sealed-high-manifest.jsonl` | `r90sh` | `fullbench-codex-sealed-high` | `sealed` | `high` | `bridge` |
# | `none` | `fullbench/codex-none/` | `codex-none-manifest.jsonl` | `r90n` | `fullbench-codex-none` | `sealed` | `high` | `none` |
#
# The lanes are a table rather than a name template: every one of them is a
# claim about how a number may be quoted, and inventing `--lane whatever` on the
# command line would produce an archive nothing in the rig knows how to read.
# `run-instance-codex.sh` documents what each network condition denies.
#
# **Effort is pinned per lane, not taken from the default.** The two `medium`
# lanes above ran before 2026-08-23, when `run-instance-codex.sh` had that value
# written into it as a literal; the default is `high` now, so a lane that did not
# pin its own value would silently re-run at a condition its recorded rows were
# never measured under. `sealed-high` is the same population and the same seal as
# `sealed` with the effort moved to `high`, which is what the flows arm has
# always run at — the whole point of the lane, and the reason two lanes may share
# a network condition while no two share an artifact.
#
# **The testbed network is pinned the same way, and for the same reason.** The
# three lanes above ran before 2026-08-24, when the testbed container kept the
# network so that test behaviour would not change with the condition — and two
# of the 45 `r90s` runs used exactly that, with a
# `docker exec <container> curl …` that fetched the merged upstream fix. The
# default is `none` now, and a lane that did not pin `bridge` would reproduce
# an old number under a condition its rows were never measured under. The
# `none` lane is `sealed-high` with the hole shut: same population, same seal on
# codex's own tools, same effort, and a container with no route out of the
# machine. `sealed-high` and `none` therefore share network *and* effort and
# differ in the testbed, which is why the conditions are checked as a triple.
# ---------------------------------------------------------------------------
LANE="${SWB_CODEX_LANE:-net}"
PREVIOUS=""
for ARGUMENT in "$@"; do
  if [ "$PREVIOUS" = "--lane" ]; then LANE="$ARGUMENT"; fi
  PREVIOUS="$ARGUMENT"
done
case "$LANE" in
  net)
    FBC="$FB/codex"
    CODEX_MANIFEST="$FB/codex-manifest.jsonl"
    LANE_INDEX="r90c"; LANE_RUN_ID="fullbench-codex"; LANE_NETWORK="on"; LANE_EFFORT="medium"; LANE_TESTBED="bridge" ;;
  sealed)
    FBC="$FB/codex-sealed"
    CODEX_MANIFEST="$FB/codex-sealed-manifest.jsonl"
    LANE_INDEX="r90s"; LANE_RUN_ID="fullbench-codex-sealed"; LANE_NETWORK="sealed"; LANE_EFFORT="medium"; LANE_TESTBED="bridge" ;;
  sealed-high)
    FBC="$FB/codex-sealed-high"
    CODEX_MANIFEST="$FB/codex-sealed-high-manifest.jsonl"
    LANE_INDEX="r90sh"; LANE_RUN_ID="fullbench-codex-sealed-high"; LANE_NETWORK="sealed"; LANE_EFFORT="high"; LANE_TESTBED="bridge" ;;
  none)
    FBC="$FB/codex-none"
    CODEX_MANIFEST="$FB/codex-none-manifest.jsonl"
    LANE_INDEX="r90n"; LANE_RUN_ID="fullbench-codex-none"; LANE_NETWORK="sealed"; LANE_EFFORT="high"; LANE_TESTBED="none" ;;
  *)
    echo "codex-backfill.sh: unknown lane '$LANE' — the lanes are net, sealed, sealed-high and none"; exit 2 ;;
esac

EVAL_RUN_ID="${SWB_CODEX_BACKFILL_RUN_ID:-$LANE_RUN_ID}"
INDEX="${SWB_CODEX_BACKFILL_INDEX:-$LANE_INDEX}"
# The conditions every run in this lane is given, and the two things about a lane
# that a child process has to be told rather than derive.
SWB_CODEX_NETWORK="${SWB_CODEX_NETWORK:-$LANE_NETWORK}"
SWB_CODEX_EFFORT="${SWB_CODEX_EFFORT:-$LANE_EFFORT}"
SWB_TESTBED_NETWORK="${SWB_TESTBED_NETWORK:-$LANE_TESTBED}"
export SWB_CODEX_NETWORK SWB_CODEX_EFFORT SWB_TESTBED_NETWORK
MODEL="${SWB_CODEX_MODEL:-gpt-6-sol}"
MODEL_NAME="${SWB_MODEL_NAME:-codex-cli}"
# The same per-instance budget the flows side was given by the full benchmark.
# A baseline run under a different clock is not a baseline.
BUDGET="${SWB_CODEX_BACKFILL_BUDGET:-1200}"
SLOTS="${SWB_CODEX_BACKFILL_SLOTS:-2}"
# How many instances a bare run works on at once. Each one is a separate process
# — `--one` is the unit, and it is what claims an instance and takes a slot — so
# a job never shares a pid, a claim or a trap with another. The two-slot
# semaphore still bounds the docker work whatever this says.
JOBS="${SWB_CODEX_BACKFILL_JOBS:-1}"
JOBS_POLL="${SWB_CODEX_BACKFILL_JOBS_POLL:-5}"
SLOT_TIMEOUT="${SWB_CODEX_BACKFILL_SLOT_TIMEOUT:-21600}"
SLOT_POLL="${SWB_CODEX_BACKFILL_SLOT_POLL:-15}"
MIN_FREE_MIB="${SWB_CODEX_BACKFILL_MIN_FREE_MIB:-8192}"
DISK_WAIT_MAX="${SWB_CODEX_BACKFILL_DISK_WAIT_MAX:-3600}"
DISK_INTERVAL="${SWB_CODEX_BACKFILL_DISK_INTERVAL:-60}"
EVAL_LOG_ROOT="${SWB_EVAL_LOG_ROOT:-$S/logs/run_evaluation}"
# The flows ledger is the population for every lane: the instances our own side
# graded, whatever condition the codex side is run under.
MANIFEST="$FB/manifest.jsonl"
# The slots are shared across lanes on purpose. Two lanes running at once would
# otherwise put four instances of docker work on one daemon and one disk gate.
SLOT_ROOT="$FB/.codex-slots"
WAITS="$FBC/waits.jsonl"

# Which images are never deleted. Defaults to the sample's pinned five, the ones
# the 5x5 best-of-n matrix needs kept warm; re-pulling one costs 3 GB.
PINNED="${SWB_FULLBENCH_PINNED:-}"
if [ -z "$PINNED" ] && [ -f "${SWB_SAMPLE:-$S/sample.json}" ]; then
  PINNED="$(node -e '
    const sample = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    process.stdout.write((sample.instances ?? []).slice(0, 5).join(" "))
  ' "${SWB_SAMPLE:-$S/sample.json}" 2>/dev/null || printf '')"
fi

for PAIR in "SLOTS:$SLOTS" "SLOT_TIMEOUT:$SLOT_TIMEOUT" "SLOT_POLL:$SLOT_POLL" \
  "MIN_FREE_MIB:$MIN_FREE_MIB" "DISK_WAIT_MAX:$DISK_WAIT_MAX" "DISK_INTERVAL:$DISK_INTERVAL" \
  "BUDGET:$BUDGET" "JOBS:$JOBS" "JOBS_POLL:$JOBS_POLL"; do
  NAME="${PAIR%%:*}"; VALUE="${PAIR#*:}"
  case "$VALUE" in
    ''|*[!0-9]*|0) echo "codex-backfill.sh: $NAME must be a positive integer, got '$VALUE'"; exit 2 ;;
  esac
done

now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
log() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${1:-backfill}" "${2:-}"; }
append() { node "$S/lib/manifest-append.mjs" "$1" "$2"; }
row() { node "$S/lib/fullbench-row.mjs" "$@"; }
queue() { node "$S/lib/codex-backfill-queue.mjs" "$MANIFEST" "$CODEX_MANIFEST" "$@"; }

if [ ! -f "$MANIFEST" ]; then
  echo "codex-backfill.sh: no full-benchmark ledger at $MANIFEST — there is nothing to back fill"
  exit 1
fi
mkdir -p "$FBC/patches" "$FBC/logs" "$FBC/timings" "$FBC/reports" "$FBC/claims" "$SLOT_ROOT"

# ---------------------------------------------------------------------------
# Auth, before anything else. The selected CODEX_HOME must hold the login
# requested by SWB_CODEX_AUTH. Subscription lanes use a ChatGPT login; older
# API-key lanes retain the isolated rig home.
# A backfill that discovers this per instance burns a pull, an extraction and a
# claim on each one before failing, so it is checked once, loudly, up front.
# ---------------------------------------------------------------------------
source "$S/lib/codex-auth.sh"
check_auth() {
  if [ -n "${SWB_CODEX_AUTH_CMD:-}" ]; then
    "$SWB_CODEX_AUTH_CMD" >/dev/null 2>&1
    return $?
  fi
  swb_codex_auth
}

require_auth() {
  if check_auth; then
    log backfill "codex auth ok (${SWB_CODEX_AUTH:-api-key}, $CODEX_HOME)"
    return 0
  fi
  echo "codex-backfill.sh: the requested Codex auth is unavailable" >&2
  exit 1
}

# The `net` lane runs codex with SWB_CODEX_NETWORK=on, which the runner refuses
# without SWB_CODEX_UNCONFINED=allowed (GHSA-6gr2-7qgm-27qh). Checked once up
# front for the same reason as auth; a stub run command starts no codex.
require_network_opt_in() {
  if [ "$SWB_CODEX_NETWORK" = "on" ] && [ -z "${SWB_CODEX_RUN_CMD:-}" ] \
    && [ "${SWB_CODEX_UNCONFINED:-}" != "allowed" ]; then
    echo "codex-backfill.sh: lane $LANE runs codex unconfined with network on; set SWB_CODEX_UNCONFINED=allowed to opt in" >&2
    exit 2
  fi
}

# ---------------------------------------------------------------------------
# The two-slot semaphore. Every docker-heavy span takes one; a slot whose holder
# is gone is taken back by the next waiter on its next poll.
# ---------------------------------------------------------------------------
SLOT=""
acquire_slot() {
  WAITED=0
  while :; do
    N=0
    while [ "$N" -lt "$SLOTS" ]; do
      if "$S/lib/lock.sh" acquire "$SLOT_ROOT/$N" --owner $$ --timeout 0 --quiet \
        --label "codex-backfill $1"; then
        SLOT="$SLOT_ROOT/$N"
        if [ "$WAITED" -gt 0 ]; then log "$1" "took slot $N after ${WAITED}s"; fi
        return 0
      fi
      N=$((N + 1))
    done
    if [ "$WAITED" -ge "$SLOT_TIMEOUT" ]; then
      log "$1" "all $SLOTS slots were busy for ${WAITED}s — giving up"
      return 1
    fi
    if [ "$WAITED" = "0" ]; then log "$1" "waiting for one of $SLOTS docker slots"; fi
    sleep "$SLOT_POLL"
    WAITED=$((WAITED + SLOT_POLL))
  done
}

release_slot() {
  if [ -n "$SLOT" ]; then
    "$S/lib/lock.sh" release "$SLOT" --owner $$ --quiet || true
    SLOT=""
  fi
}

# ---------------------------------------------------------------------------
# One instance, from image to verdict to empty disk.
#
# Exit 0 when the instance reached a verdict or was already paid for. An agent
# that timed out or crashed still reaches a verdict — that is the benchmark
# measuring something — so it is a success here too.
# ---------------------------------------------------------------------------
run_one() {
  ID="$1"
  CLAIM="$FBC/claims/$ID"
  SLOT=""
  IMAGE=""
  KEEP_IMAGE=0

  BACKFILL_STATE=""
  FLOWS_VERDICT=""
  FLOWS_EVAL_ERROR=0
  CODEX_VERDICT=""
  eval "$(queue --row "$ID")"
  if [ -z "$BACKFILL_STATE" ]; then
    log "$ID" "REFUSED: could not read $CODEX_MANIFEST or $MANIFEST"
    return 1
  fi
  case "$BACKFILL_STATE" in
    done)
      log "$ID" "already has a codex verdict ($CODEX_VERDICT) — nothing to do"
      return 0 ;;
    unknown)
      log "$ID" "REFUSED: the full benchmark never graded it, so there is no flows attempt to compare against"
      return 1 ;;
  esac

  if ! "$S/lib/lock.sh" acquire "$CLAIM" --owner $$ --timeout 0 --quiet \
    --label "codex-backfill.sh $ID"; then
    log "$ID" "already claimed by live pid $("$S/lib/lock.sh" owner "$CLAIM") — refusing to run it twice"
    return 3
  fi

  cleanup_one() {
    release_slot
    "$S/lib/lock.sh" release "$CLAIM" --owner $$ --quiet || true
    "$S/lib/lock.sh" release "$S/.grade-lock" --owner $$ --quiet || true
    "$S/lib/lock.sh" release "$FB/.grade-lock" --owner $$ --quiet || true
  }
  trap 'cleanup_one' EXIT INT TERM

  # `run-paths.sh` prints `KEY=value` lines that are `eval`ed into this shell, and
  # one of them is `RUN_ID` — the *run's* id, `<instance>-r90c`. The evaluator run
  # id every instance accumulates into is therefore held in `EVAL_RUN_ID` and
  # never in `RUN_ID`, because this line would silently overwrite it and every
  # grading would file its report under a run id of its own. That is not a
  # hypothetical: `lib/fullbench-instance.sh` has the same two names and the same
  # `eval`, and the full benchmark's 45 graded instances are filed under 45
  # separate evaluator run ids rather than the one `fullbench` its documentation
  # and `--aggregate` both name.
  RUN_PATHS="$("$S/lib/run-paths.sh" codex "$ID" "$INDEX")" || {
    log "$ID" "run-paths refused ${ID}/${INDEX}"; cleanup_one; trap - EXIT INT TERM; return 1; }
  eval "$RUN_PATHS"

  IMAGE_ID="$(printf '%s' "$ID" | sed 's/__/_1776_/')"
  IMAGE="swebench/sweb.eval.x86_64.${IMAGE_ID}:latest"
  if [ -n "${SWB_IMAGE_MAP:-}" ] && [ -f "$SWB_IMAGE_MAP" ]; then
    MAPPED="$(node -e '
      const map = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
      process.stdout.write(map[process.argv[2]] ?? "")
    ' "$SWB_IMAGE_MAP" "$ID")"
    if [ -n "$MAPPED" ]; then IMAGE="$MAPPED"; fi
  fi
  for PIN in $PINNED; do
    if [ "$PIN" = "$ID" ]; then KEEP_IMAGE=1; fi
  done

  # The image and the testbed, gone — on the way out of a verdict and out of a
  # failure alike. A failed instance re-runs from the top and re-pulls what it
  # needs, so keeping its image buys nothing and costs 2-3 GB of the gate's
  # headroom. The diagnostic goes to stderr: this function's stdout is the image
  # state the ledger records.
  discard_image() {
    if [ -n "${CONTAINER:-}" ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
    if [ -n "${WORK:-}" ]; then rm -rf -- "$WORK"; fi
    if [ "$KEEP_IMAGE" = "1" ]; then printf 'kept'; return 0; fi
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then printf 'absent'; return 0; fi
    docker rmi -f "$IMAGE" >/dev/null 2>&1 || log "$ID" "could not delete $IMAGE" >&2
    if docker image inspect "$IMAGE" >/dev/null 2>&1; then printf 'present'; else printf 'deleted'; fi
  }

  fail_one() {
    REMOVED="$(discard_image)"
    append "$CODEX_MANIFEST" "$(row --kind instance --id "$ID" --state failed --at "$(now_ms)" \
      --image "$IMAGE" --image-state "$REMOVED" --run-id "$EVAL_RUN_ID" --index "$INDEX" \
      --flows-verdict "$FLOWS_VERDICT" --flows-eval-error "$FLOWS_EVAL_ERROR" --reason "$1")"
    log "$ID" "FAILED: $1 (image $REMOVED)"
    cleanup_one
    trap - EXIT INT TERM
    return 1
  }

  disk_gate() {
    PHASE="$1"
    WAITED=0
    while :; do
      FREE="$("$S/lib/disk-free.sh")"
      case "$FREE" in
        ''|*[!0-9]*) FREE=0 ;;
      esac
      if [ "$FREE" -ge "$MIN_FREE_MIB" ]; then
        if [ "$WAITED" -gt 0 ]; then log "$ID" "disk gate cleared after ${WAITED}s (${FREE} MiB free)"; fi
        return 0
      fi
      append "$WAITS" "$(row --kind wait --id "$ID" --phase "$PHASE" --at "$(now_ms)" \
        --freeMiB "$FREE" --neededMiB "$MIN_FREE_MIB" --waitedSeconds "$WAITED")"
      log "$ID" "disk gate ($PHASE): ${FREE} MiB free, need ${MIN_FREE_MIB} MiB — waiting ${DISK_INTERVAL}s (waited ${WAITED}s)"
      if [ "$WAITED" -ge "$DISK_WAIT_MAX" ]; then
        log "$ID" "disk gate ($PHASE): gave up after ${WAITED}s"
        return 1
      fi
      sleep "$DISK_INTERVAL"
      WAITED=$((WAITED + DISK_INTERVAL))
    done
  }

  if ! acquire_slot "$ID"; then
    append "$CODEX_MANIFEST" "$(row --kind instance --id "$ID" --state failed --at "$(now_ms)" \
      --run-id "$EVAL_RUN_ID" --index "$INDEX" --reason "no docker slot came free")"
    log "$ID" "FAILED: no docker slot came free"
    cleanup_one
    trap - EXIT INT TERM
    return 1
  fi

  STARTED_AT="$(now_ms)"
  append "$CODEX_MANIFEST" "$(row --kind instance --id "$ID" --state started --at "$STARTED_AT" \
    --run-id "$EVAL_RUN_ID" --index "$INDEX" --model "$MODEL" --budgetSeconds "$BUDGET" \
    --network "$SWB_CODEX_NETWORK" --effort "$SWB_CODEX_EFFORT" \
    --testbedNetwork "$SWB_TESTBED_NETWORK" \
    --flows-verdict "$FLOWS_VERDICT" --flows-eval-error "$FLOWS_EVAL_ERROR" --pid $$)"

  # Purge whatever a dead attempt at this instance left behind, in the shared
  # codex roots and under fullbench/codex/, so a retry runs clean rather than
  # inheriting half a workspace.
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf -- "$WORK"
  rm -f -- "$PATCH" "$PATCH.untracked" "$TIMINGS" "$LOG_PREFIX".*
  rm -f -- "$FBC/patches/$ID.patch" "$FBC/patches/$ID.patch.untracked" \
    "$FBC/timings/$ID.json" "$FBC/logs/$ID".* "$FBC/reports/$ID.json"
  # And the evaluator's own log directory for this instance. The official
  # evaluator skips any instance that already has a `report.json` under the run
  # id — 43 instances accumulating into one run id is exactly that layout — so a
  # retry whose predecessor was graded but never recorded would be handed the
  # dead attempt's verdict for this attempt's patch.
  rm -rf -- "$EVAL_LOG_ROOT/$EVAL_RUN_ID/$MODEL_NAME/$ID"

  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    log "$ID" "image $IMAGE already local"
    PULLED=cached
  else
    disk_gate pull || fail_one "disk gate timed out before the pull" || return 1
    log "$ID" "pulling $IMAGE"
    if ! docker pull --platform linux/amd64 "$IMAGE" > "$FBC/logs/$ID.pull.log" 2>&1; then
      fail_one "docker pull failed; see fullbench/codex/logs/$ID.pull.log" || return 1
    fi
    PULLED=pulled
  fi

  disk_gate extract || fail_one "disk gate timed out before the run" || return 1
  RUN_STARTED="$(now_ms)"
  if [ -n "${SWB_CODEX_RUN_CMD:-}" ]; then
    "$SWB_CODEX_RUN_CMD" "$ID" "$BUDGET" "$MODEL" "$INDEX"
  else
    "$S/run-instance-codex.sh" "$ID" "$BUDGET" "$MODEL" "$INDEX"
  fi
  RUN_STATUS=$?
  RUN_ENDED="$(now_ms)"
  log "$ID" "codex exit $RUN_STATUS in $(( (RUN_ENDED - RUN_STARTED) / 1000 ))s (pull $PULLED)"

  # The patch is captured after the agent, so its existence is what says the
  # workspace was built and the attempt really happened. An exit status is not:
  # a timeout exits 124 with a perfectly good patch.
  if [ ! -f "$PATCH" ]; then
    fail_one "the run captured no patch (exit $RUN_STATUS)" || return 1
  fi
  PATCH_BYTES="$(wc -c < "$PATCH" | tr -d ' ')"

  # Archive first, delete second. Everything downstream — the trace bundle, the
  # report, any later forensics — reads these and never the workspace.
  cp "$PATCH" "$FBC/patches/$ID.patch"
  if [ -f "$PATCH.untracked" ]; then cp "$PATCH.untracked" "$FBC/patches/$ID.patch.untracked"; fi
  if [ -f "$TIMINGS" ]; then cp "$TIMINGS" "$FBC/timings/$ID.json"; fi
  for SUFFIX_NAME in run.log last-message.txt prompt.md; do
    if [ -f "$LOG_PREFIX.$SUFFIX_NAME" ]; then cp "$LOG_PREFIX.$SUFFIX_NAME" "$FBC/logs/$ID.$SUFFIX_NAME"; fi
  done
  rm -rf -- "$WORK"
  rm -f -- "$PATCH" "$PATCH.untracked" "$TIMINGS" "$LOG_PREFIX".*

  # The CLI's own footer, when it printed one, and the codex process's own wall
  # clock. Both are optional — a run killed by its timeout prints no footer — and
  # both are spliced into the ledger row unquoted, so both are reduced to digits
  # or to nothing at all before they get there. A column the ledger cannot state
  # honestly is absent rather than zero.
  TOKENS="$(node "$S/lib/codex-tokens.mjs" "$FBC/logs/$ID.run.log" 2>/dev/null || printf '')"
  AGENT_SECONDS="$(node -e '
    const fs = require("fs")
    try {
      const timings = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
      process.stdout.write(String(timings.wallClockSeconds ?? ""))
    } catch { process.stdout.write("") }
  ' "$FBC/timings/$ID.json" 2>/dev/null || printf '')"
  case "$TOKENS" in ''|*[!0-9]*) TOKENS="" ;; esac
  case "$AGENT_SECONDS" in ''|*[!0-9]*) AGENT_SECONDS="" ;; esac
  OPTIONAL=""
  if [ -n "$TOKENS" ]; then OPTIONAL="$OPTIONAL --tokens $TOKENS"; fi
  if [ -n "$AGENT_SECONDS" ]; then OPTIONAL="$OPTIONAL --agentSeconds $AGENT_SECONDS"; fi

  # What `docker inspect` said the testbed container was on, taken off the
  # timings the run wrote rather than off the lane's own variable. The lane's
  # variable is a request; this is the observation, and it is what
  # `compare-codex-lanes.mjs` asserts a `none` lane against. A run that recorded
  # nothing leaves the field absent, which the scoreboard treats as a failed
  # assertion rather than as a pass — a lane cannot claim a seal it did not
  # measure.
  TESTBED_OBSERVED="$(node -e '
    const fs = require("fs")
    try {
      const timings = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
      const seen = timings.testbedNetworkObserved
      process.stdout.write(seen === "none" || seen === "bridge" ? seen : "")
    } catch { process.stdout.write("") }
  ' "$FBC/timings/$ID.json" 2>/dev/null || printf '')"
  if [ -n "$TESTBED_OBSERVED" ]; then
    OPTIONAL="$OPTIONAL --testbedNetworkObserved $TESTBED_OBSERVED"
  fi

  # Grade, immediately, into the one accumulating run id. Serialized across
  # invocations by the rig's evaluator lock, because `evaluate.sh` documents what
  # two concurrent evaluator processes do to each other's image cleanup — and the
  # flows benchmark grading beside this one is another such process.
  VERDICT=""
  GRADED_AT=""
  if [ "$PATCH_BYTES" = "0" ]; then
    # Not a grading. The official evaluator drops an empty prediction before it
    # starts a container, so there is no verdict to read; "the agent changed
    # nothing" is a fact about the patch and is recorded as one.
    VERDICT="empty patch"
    log "$ID" "patch is empty — recorded as 'empty patch' without invoking the evaluator"
  else
    # A stubbed evaluator starts no container and touches no image, so it takes a
    # lock under fullbench/ instead: the rig's lock is about real evaluator
    # processes on one docker daemon, and a dry run queued behind a live wave's
    # grading would be measuring that wave's clock rather than its own.
    if [ -n "${SWB_GRADE_CMD:-}" ]; then GRADE_LOCK="$FB/.grade-lock"; else GRADE_LOCK="$S/.grade-lock"; fi
    if ! "$S/lib/lock.sh" acquire "$GRADE_LOCK" --owner $$ --label "codex-backfill $ID" \
      --timeout "${SWB_GRADE_LOCK_TIMEOUT:-7200}"; then
      fail_one "another evaluator held $GRADE_LOCK for too long" || return 1
    fi
    if [ "$KEEP_IMAGE" = "1" ]; then CACHE_LEVEL=instance; else CACHE_LEVEL=env; fi
    log "$ID" "grading as $EVAL_RUN_ID (cache_level $CACHE_LEVEL)"
    if [ -n "${SWB_GRADE_CMD:-}" ]; then
      "$SWB_GRADE_CMD" "$EVAL_RUN_ID" "$ID" >> "$FBC/logs/$ID.grade.log" 2>&1
    else
      # An absolute SWB_PATCHES, so an FB_DIR inside or outside the rig grades
      # from the archive this lane just wrote.
      ABS_PATCHES="$(cd "$FBC/patches" && pwd)" || {
        "$S/lib/lock.sh" release "$GRADE_LOCK" --owner $$ --quiet || true
        fail_one "no patches directory under FB_DIR ($FB)" || return 1; }
      HARNESS=codex SWB_PATCHES="$ABS_PATCHES" SWB_MODEL_NAME="$MODEL_NAME" \
        SWB_CACHE_LEVEL="$CACHE_LEVEL" SWB_GRADE_LOCK_HELD=1 \
        "$S/evaluate.sh" "$EVAL_RUN_ID" "$ID" >> "$FBC/logs/$ID.grade.log" 2>&1
    fi
    GRADE_STATUS=$?
    REPORT="$EVAL_LOG_ROOT/$EVAL_RUN_ID/$MODEL_NAME/$ID/report.json"
    if [ -f "$REPORT" ]; then
      cp "$REPORT" "$FBC/reports/$ID.json"
      VERDICT="$(node -e '
        const report = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
        const row = report[process.argv[2]]
        if (row === undefined) { process.stdout.write("eval error") }
        else { process.stdout.write(row.resolved === true ? "resolved" : "unresolved") }
      ' "$REPORT" "$ID")"
    else
      VERDICT="eval error"
      log "$ID" "the evaluator wrote no report for this instance (exit $GRADE_STATUS)"
    fi
    # Released here rather than in the trap: the verdict is read, and the next
    # invocation's grading may start while this one deletes its image.
    "$S/lib/lock.sh" release "$GRADE_LOCK" --owner $$ --quiet || true
  fi
  GRADED_AT="$(now_ms)"

  REMOVED="$(discard_image)"
  if [ "$KEEP_IMAGE" = "1" ]; then log "$ID" "image kept: $ID is one of the pinned five"; fi

  append "$CODEX_MANIFEST" "$(row --kind instance --id "$ID" --state graded --at "$(now_ms)" \
    --verdict "$VERDICT" --wallSeconds "$(( (RUN_ENDED - RUN_STARTED) / 1000 ))" \
    --patchBytes "$PATCH_BYTES" \
    --startedAt "$STARTED_AT" --runStartedAt "$RUN_STARTED" --runEndedAt "$RUN_ENDED" \
    --gradedAt "$GRADED_AT" --exit "$RUN_STATUS" --pull "$PULLED" \
    --image "$IMAGE" --image-state "$REMOVED" --run-id "$EVAL_RUN_ID" --index "$INDEX" \
    --model "$MODEL" --budgetSeconds "$BUDGET" \
    --network "$SWB_CODEX_NETWORK" --effort "$SWB_CODEX_EFFORT" \
    --testbedNetwork "$SWB_TESTBED_NETWORK" \
    --flows-verdict "$FLOWS_VERDICT" --flows-eval-error "$FLOWS_EVAL_ERROR" \
    --freeMiB "$("$S/lib/disk-free.sh")" $OPTIONAL)"
  FLAG=""
  if [ "$FLOWS_EVAL_ERROR" = "1" ]; then FLAG=" [flagged: our own grading errored]"; fi
  log "$ID" "verdict: $VERDICT (ours: ${FLOWS_VERDICT}${FLAG}) — image $REMOVED"

  cleanup_one
  trap - EXIT INT TERM
  return 0
}

# ---------------------------------------------------------------------------
# Modes
# ---------------------------------------------------------------------------
MODE=all
ONE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --one) MODE=one; ONE="${2:-}"; shift 2 || shift ;;
    # Read before the defaults were computed; accepted again here so an unknown
    # argument is still refused.
    --lane) shift 2 || shift ;;
    --jobs) JOBS="${2:-}"; shift 2 || shift ;;
    --list) MODE=list; shift ;;
    --status) MODE=status; shift ;;
    --table) MODE=table; shift ;;
    *) echo "codex-backfill.sh: unknown argument '$1'"; exit 2 ;;
  esac
done
case "$JOBS" in
  ''|*[!0-9]*|0) echo "codex-backfill.sh: --jobs must be a positive integer, got '$JOBS'"; exit 2 ;;
esac

case "$MODE" in
  list)
    queue --remaining
    exit 0 ;;
  table)
    queue --table
    exit 0 ;;
  status)
    set -- $(queue --count)
    printf '%s of %s instances back filled, %s left, %s flagged (our own grading errored)\n' \
      "$1" "$3" "$2" "$4"
    exit 0 ;;
  one)
    if [ -z "$ONE" ]; then echo "codex-backfill.sh: --one needs an instance id"; exit 2; fi
    # The auth check runs before the claim and before any docker call, so a
    # logged-out rig costs nothing — and an id that is already paid for, or that
    # this backfill has no business running, needs no login at all.
    BACKFILL_STATE=""
    eval "$(queue --row "$ONE")"
    if [ "$BACKFILL_STATE" = "todo" ]; then require_network_opt_in; require_auth; fi
    run_one "$ONE"
    exit $? ;;
  all)
    REMAINING="$(queue --remaining)"
    if [ -z "$REMAINING" ]; then
      log backfill "nothing left: every instance the full benchmark graded already has a codex verdict"
      exit 0
    fi
    require_network_opt_in
    require_auth
    COUNT="$(printf '%s\n' "$REMAINING" | wc -l | tr -d ' ')"
    log backfill "lane $LANE ($SWB_CODEX_NETWORK network, $SWB_CODEX_EFFORT effort, $SWB_TESTBED_NETWORK testbed, index $INDEX, run id $EVAL_RUN_ID)"
    log backfill "$COUNT instances to back fill, $JOBS at a time, $SLOTS docker slots, budget ${BUDGET}s each"
    FAILURES=0
    if [ "$JOBS" = "1" ]; then
      for ID in $REMAINING; do
        run_one "$ID" || FAILURES=$((FAILURES + 1))
      done
    else
      # Every job is a separate `--one` process, which is the unit that claims an
      # instance, takes a slot and owns its traps. A background *subshell* would
      # share this shell's pid, and `lib/lock.sh` records the owner's pid: two
      # subshells would look to each other like one live owner and either could
      # release the other's claim.
      #
      # The marker file is written by this shell before the job starts rather
      # than by the job itself, so the count is right the instant the job is
      # scheduled and the loop cannot launch the whole queue while the first
      # child is still starting up.
      SPAWN="$(mktemp -d "${TMPDIR:-/tmp}/codex-backfill-jobs.XXXXXX")" || {
        echo "codex-backfill.sh: could not make a scratch directory for --jobs"; exit 1; }
      for ID in $REMAINING; do
        while [ "$(ls "$SPAWN"/*.running 2>/dev/null | wc -l | tr -d ' ')" -ge "$JOBS" ]; do
          sleep "$JOBS_POLL"
        done
        : > "$SPAWN/$ID.running"
        (
          "$0" --lane "$LANE" --one "$ID"
          printf '%s\n' "$?" > "$SPAWN/$ID.exit"
          rm -f "$SPAWN/$ID.running"
        ) &
      done
      wait
      for ID in $REMAINING; do
        if [ "$(cat "$SPAWN/$ID.exit" 2>/dev/null || printf 'missing')" != "0" ]; then
          FAILURES=$((FAILURES + 1))
        fi
      done
      rm -rf -- "$SPAWN"
    fi
    log backfill "done: $FAILURES of $COUNT instances did not reach a verdict"
    if [ "$FAILURES" -gt 0 ]; then exit 1; fi
    exit 0 ;;
esac
