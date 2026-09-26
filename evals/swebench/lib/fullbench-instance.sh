#!/bin/bash
# One instance of the full benchmark, from image to verdict to empty disk.
#
#   lib/fullbench-instance.sh <instance_id>
#
# This is the streaming unit `fullbench.sh` schedules two of at a time. It runs
# the whole life of one instance in one process so that nothing multi-gigabyte
# outlives the instance that needed it:
#
#   disk gate -> pull -> disk gate -> run -> archive -> grade -> delete
#
# **Grading happens here, per instance, while the image is still local.** The
# alternative — run all 500, then grade all 500 — needs every image twice and a
# second pass that re-pulls 1.5 TB. Grading one instance the moment its patch
# exists costs one image, once.
#
# Every state it reaches is appended to the manifest before the next one starts,
# so a kill at any point leaves a ledger that says exactly how far this instance
# got. `graded` is the resume boundary: anything short of it re-runs from the
# top on the next start, and this script purges its own instance's artifacts on
# entry so that re-run is clean.
#
# Environment, all set by `fullbench.sh`:
#
#   FB_DIR                        the fullbench directory
#   SWB_FULLBENCH_INDEX           the run index every artifact carries (r90)
#   SWB_FULLBENCH_RUN_ID          the evaluator run id all 500 accumulate into
#   SWB_FULLBENCH_MIN_FREE_MIB    the disk gate, in MiB (8192)
#   SWB_FULLBENCH_DISK_WAIT_MAX   how long the gate may block before giving up
#   SWB_FULLBENCH_DISK_INTERVAL   how often the gate re-checks
#   SWB_FULLBENCH_PINNED          ids whose images are never deleted
#   SWB_SEAT, SWB_FULLBENCH_BUDGET, SWB_MODEL_NAME
#   SWB_FLOWS_OPENAI_AUTH         api-key (default) or chatgpt; run-instance.sh
#                                 reads it from the environment directly
#   SWB_FLOWS_HOST_SHELL          must be `allowed` on docker; run-instance.sh
#                                 refuses to start an agent otherwise, because
#                                 the flows bash flow runs container-less calls
#                                 on the host unconfined. Recorded as
#                                 `hostShell` (`sealed` on plue)
#   SWB_TRANSPORT                 docker (default) or plue (lib/transport.sh).
#                                 On plue the testbed and the grading are
#                                 Smithers Cloud workspaces: no pull, no disk
#                                 gate, no image to delete, no grade lock, and
#                                 the ledger's image state is `remote`
#
# Two stubs exist for the rig's own dry run, and they are the same convention
# `run-matrix.sh` already uses for `SWB_RUN_CMD`:
#
#   SWB_RUN_CMD     replaces the harness run: <cmd> <id> <budget> "" <index>
#   SWB_GRADE_CMD   replaces the evaluator:   <cmd> <run-id> <id>
#   SWB_IMAGE_MAP   a JSON file of id -> image ref, so a dry run can pull a
#                   4 MB image through the real pull/delete path
#
# Exit status: 0 when the instance reached a verdict, non-zero when it did not.
# A harness run that timed out or crashed still reaches a verdict — that is the
# benchmark measuring something — so it is a success here.
set -u
S="$(cd "$(dirname "$0")/.." && pwd)"
ID="${1:-}"
FB="${FB_DIR:-$S/fullbench}"
INDEX="${SWB_FULLBENCH_INDEX:-r90}"
# EVAL_RUN_ID, not RUN_ID: `eval "$RUN_PATHS"` below exports the per-run
# RUN_ID (e.g. <id>-r90) and silently clobbered the accumulating evaluator
# run id — 44 instances graded into per-run ids with no `fullbench` report
# tree, and --aggregate would have re-graded all of them from scratch.
EVAL_RUN_ID="${SWB_FULLBENCH_RUN_ID:-fullbench}"
MIN_FREE_MIB="${SWB_FULLBENCH_MIN_FREE_MIB:-8192}"
DISK_WAIT_MAX="${SWB_FULLBENCH_DISK_WAIT_MAX:-3600}"
DISK_INTERVAL="${SWB_FULLBENCH_DISK_INTERVAL:-60}"
PINNED="${SWB_FULLBENCH_PINNED:-}"
SEAT="${SWB_SEAT:-openai:gpt-6-sol}"
BUDGET="${SWB_FULLBENCH_BUDGET:-1200}"
MODEL="${SWB_MODEL_NAME:-flows-cell-harness}"
DATASET="${SWB_DATASET:-$S/swb-verified.json}"
EVAL_LOG_ROOT="${SWB_EVAL_LOG_ROOT:-$S/logs/run_evaluation}"

if [ -z "$ID" ]; then echo "usage: lib/fullbench-instance.sh <instance_id>" >&2; exit 2; fi
TRANSPORT="$("$S/lib/transport.sh")" || exit 2

MANIFEST="$FB/manifest.jsonl"
WAITS="$FB/waits.jsonl"

now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
log() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ID" "$*"; }
append() { node "$S/lib/manifest-append.mjs" "$1" "$2"; }

# A JSON row, built by node so that a value this script splices in can never
# produce a manifest line that does not parse.
row() { node "$S/lib/fullbench-row.mjs" "$@"; }

# ---------------------------------------------------------------------------
# The claim. One instance, one live run — the rule `run-matrix.sh` enforces by
# scheduling, enforced here by the filesystem as well, because two drivers is a
# thing an operator can do by accident and two runs of one instance share an
# image, an image cache and a testbed.
#
# The claim is a `lib/lock.sh` lock holding this worker's pid, and that is what
# makes it survive the driver rather than the session: a driver that is killed
# on its own — `pkill -f fullbench.sh` matches the driver and not this script —
# leaves its workers running, and the next driver must not schedule a second
# attempt beside one of them. A claim whose owner is gone is taken back on the
# spot; a claim whose owner is alive refuses this attempt with exit 3.
# ---------------------------------------------------------------------------
CLAIM="$FB/claims/$ID"
mkdir -p "$FB/claims"
if ! "$S/lib/lock.sh" acquire "$CLAIM" --owner $$ --timeout 0 --quiet \
  --label "fullbench-instance.sh $ID"; then
  log "already claimed by live worker pid $("$S/lib/lock.sh" owner "$CLAIM") — refusing to run it twice"
  exit 3
fi

IMAGE_ID="$(printf '%s' "$ID" | sed 's/__/_1776_/')"
IMAGE="swebench/sweb.eval.x86_64.${IMAGE_ID}:latest"
if [ -n "${SWB_IMAGE_MAP:-}" ] && [ -f "$SWB_IMAGE_MAP" ]; then
  MAPPED="$(node -e '
    const map = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    process.stdout.write(map[process.argv[2]] ?? "")
  ' "$SWB_IMAGE_MAP" "$ID")"
  if [ -n "$MAPPED" ]; then IMAGE="$MAPPED"; fi
fi

KEEP_IMAGE=0
for PIN in $PINNED; do
  if [ "$PIN" = "$ID" ]; then KEEP_IMAGE=1; fi
done

cleanup() {
  if [ -n "${ARCHIVE_STAGE:-}" ]; then rm -rf -- "$ARCHIVE_STAGE"; fi
  if [ "${ARCHIVE_LINKS_PENDING:-0}" = 1 ]; then
    rm -f -- "$FB/patches/$ID.patch" "$FB/patches/$ID.patch.untracked" \
      "$FB/timings/$ID.json" "$FB/logs/$ID.run.log" "$FB/journals/$ID"
  fi
  "$S/lib/lock.sh" release "$CLAIM" --owner $$ --quiet || true
  # Whichever of the two this worker took. Releasing by owner makes the other
  # call a no-op rather than a lock someone else loses.
  "$S/lib/lock.sh" release "$S/.grade-lock" --owner $$ --quiet || true
  "$S/lib/lock.sh" release "$FB/.grade-lock" --owner $$ --quiet || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The image and the testbed this instance pulled, gone. Called on the way out of
# a verdict and on the way out of a failure alike: an instance that failed is
# re-run from the top on the next resume and re-pulls what it needs, so keeping
# its image buys nothing and costs 2–3 GB of a 16 GiB budget. Leaving them
# behind is what turns a handful of failures into a disk gate that never opens
# again.
discard_image() {
  # `run-paths.sh` may not have run yet — the first `fail` is the one that says
  # it refused this instance — so neither name is assumed to exist.
  if [ -n "${WORK:-}" ]; then rm -rf -- "$WORK"; fi
  # On plue the image never reached this machine, and the workspace went with
  # the run that created it.
  if [ "$TRANSPORT" = "plue" ]; then printf 'remote'; return 0; fi
  if [ -n "${CONTAINER:-}" ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
  if [ "$KEEP_IMAGE" = "1" ]; then printf 'kept'; return 0; fi
  # An instance that failed before its pull never had one, and a ledger that
  # says `deleted` for it reads as if a pull had happened.
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then printf 'absent'; return 0; fi
  # The diagnostic goes to stderr: this function's stdout is the image state its
  # caller records, and a log line spliced into it would become the state.
  docker rmi -f "$IMAGE" >/dev/null 2>&1 || log "could not delete $IMAGE" >&2
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then printf 'present'; else printf 'deleted'; fi
}

fail() {
  REMOVED="$(discard_image)"
  append "$MANIFEST" "$(row --kind instance --id "$ID" --state failed --at "$(now_ms)" \
    --image "$IMAGE" --image-state "$REMOVED" --reason "$1")"
  log "FAILED: $1 (image $REMOVED)"
  exit 1
}

# All evidence belongs to one directory, published by one same-filesystem
# rename. The familiar paths are relative links into it, prepared while the
# target is still absent. A failed copy, comparison, link or rename leaves the
# sources untouched; cleanup removes only staging and unpublished links.
copy_checked() {
  cp "$1" "$2" && cmp -s "$1" "$2"
}

archive_evidence() {
  local destination="$1" links="${2:-0}"
  mkdir -p "$FB/archives" || return 1
  [ ! -e "$destination" ] || return 1
  ARCHIVE_STAGE="$(mktemp -d "$FB/archives/.$ID.XXXXXX")" || return 1
  copy_checked "$PATCH" "$ARCHIVE_STAGE/patch" || return 1
  if [ -f "$PATCH.untracked" ]; then
    copy_checked "$PATCH.untracked" "$ARCHIVE_STAGE/untracked" || return 1
  fi
  if [ -f "$TIMINGS" ]; then
    copy_checked "$TIMINGS" "$ARCHIVE_STAGE/timings.json" || return 1
  fi
  if [ -f "$LOG_PREFIX.run.log" ]; then
    copy_checked "$LOG_PREFIX.run.log" "$ARCHIVE_STAGE/run.log" || return 1
  fi
  if [ -d "$JOURNAL" ]; then
    cp -R "$JOURNAL" "$ARCHIVE_STAGE/journal" || return 1
    diff -r "$JOURNAL" "$ARCHIVE_STAGE/journal" >/dev/null || return 1
  fi
  if [ "$links" = 1 ]; then
    ARCHIVE_LINKS_PENDING=1
    ln -s "../archives/$ID/patch" "$FB/patches/$ID.patch" || return 1
    if [ -f "$PATCH.untracked" ]; then
      ln -s "../archives/$ID/untracked" "$FB/patches/$ID.patch.untracked" || return 1
    fi
    if [ -f "$TIMINGS" ]; then
      ln -s "../archives/$ID/timings.json" "$FB/timings/$ID.json" || return 1
    fi
    if [ -f "$LOG_PREFIX.run.log" ]; then
      ln -s "../archives/$ID/run.log" "$FB/logs/$ID.run.log" || return 1
    fi
    if [ -d "$JOURNAL" ]; then
      ln -s "../archives/$ID/journal" "$FB/journals/$ID" || return 1
    fi
  fi
  mv -- "$ARCHIVE_STAGE" "$destination" || return 1
  ARCHIVE_STAGE=""
  ARCHIVE_LINKS_PENDING=0
}

# ---------------------------------------------------------------------------
# The disk gate. Before every pull, and again before the extraction, because
# both are multi-gigabyte and the 5x5 matrix in the same rig is spending the
# same disk. Every wait is a row in waits.jsonl and a line in the driver log:
# a benchmark that silently sat still for two hours is indistinguishable from a
# hung one, and the difference is the whole reason this is logged.
# ---------------------------------------------------------------------------
disk_gate() {
  PHASE="$1"
  WAITED=0
  while :; do
    FREE="$("$S/lib/disk-free.sh")"
    case "$FREE" in
      ''|*[!0-9]*) FREE=0 ;;
    esac
    if [ "$FREE" -ge "$MIN_FREE_MIB" ]; then
      if [ "$WAITED" -gt 0 ]; then log "disk gate cleared after ${WAITED}s (${FREE} MiB free)"; fi
      return 0
    fi
    append "$WAITS" "$(row --kind wait --id "$ID" --phase "$PHASE" --at "$(now_ms)" \
      --freeMiB "$FREE" --neededMiB "$MIN_FREE_MIB" --waitedSeconds "$WAITED")"
    log "disk gate ($PHASE): ${FREE} MiB free, need ${MIN_FREE_MIB} MiB — waiting ${DISK_INTERVAL}s (waited ${WAITED}s)"
    if [ "$WAITED" -ge "$DISK_WAIT_MAX" ]; then
      log "disk gate ($PHASE): gave up after ${WAITED}s"
      return 1
    fi
    sleep "$DISK_INTERVAL"
    WAITED=$((WAITED + DISK_INTERVAL))
  done
}

# ---------------------------------------------------------------------------
# Purge. Whatever a previous attempt at this instance left behind, in the shared
# roots and under fullbench/, goes before this attempt starts. A resumed
# instance re-runs clean rather than inheriting half a workspace, and the
# manifest's `pulled` row is what says an attempt began.
# ---------------------------------------------------------------------------
RUN_PATHS="$("$S/lib/run-paths.sh" flows "$ID" "$INDEX")" || fail "run-paths refused ${ID}/${INDEX}"
eval "$RUN_PATHS"
# An archive-failed attempt may be the only copy of paid evidence. Preserve it
# before the normal retry purge, using the same checked publication protocol.
if [ -f "$PATCH" ]; then
  archive_evidence "$FB/archives/$ID.recovered-$(now_ms)-$$" || fail "archive-failed"
fi
if [ "$TRANSPORT" = "docker" ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
rm -rf -- "$WORK" "$JOURNAL"
rm -f -- "$PATCH" "$PATCH.untracked" "$TIMINGS" "$LOG_PREFIX".*
rm -rf -- "$FB/journals/$ID"
rm -rf -- "$FB/archives/$ID"
rm -f -- "$FB/patches/$ID.patch" "$FB/patches/$ID.patch.untracked" \
  "$FB/timings/$ID.json" "$FB/logs/$ID.run.log" "$FB/logs/$ID.pull.log" "$FB/reports/$ID.json"
# The official evaluator's own log directory for this instance, too. It skips
# any instance that already has a `report.json` under the run id — 500 instances
# accumulating into one run id is exactly that layout — so a re-run whose
# predecessor was graded but never recorded (killed between the report and the
# manifest row) would be handed the dead attempt's verdict for this attempt's
# patch. Deleting the directory is what makes a re-run a re-grade.
rm -rf -- "$EVAL_LOG_ROOT/$EVAL_RUN_ID/$MODEL/$ID"
mkdir -p "$FB/patches" "$FB/journals" "$FB/timings" "$FB/logs" "$FB/reports"

# ---------------------------------------------------------------------------
# Pull. Skipped when the image is already here — which it is for the five the
# 5x5 matrix pinned, and for nothing else, because this script deletes every
# other one on its way out.
# ---------------------------------------------------------------------------
STARTED_AT="$(now_ms)"
if [ "$TRANSPORT" = "plue" ]; then
  log "image $IMAGE boots as a Smithers Cloud workspace; nothing to pull"
  PULLED=remote
elif docker image inspect "$IMAGE" >/dev/null 2>&1; then
  log "image $IMAGE already local"
  PULLED=cached
else
  disk_gate pull || fail "disk gate timed out before the pull"
  log "pulling $IMAGE"
  if ! docker pull --platform linux/amd64 "$IMAGE" > "$FB/logs/$ID.pull.log" 2>&1; then
    fail "docker pull failed; see fullbench/logs/$ID.pull.log"
  fi
  PULLED=pulled
fi
append "$MANIFEST" "$(row --kind instance --id "$ID" --state pulled --at "$(now_ms)" \
  --image "$IMAGE" --pull "$PULLED" --startedAt "$STARTED_AT" --index "$INDEX" --transport "$TRANSPORT")"

# ---------------------------------------------------------------------------
# Run. One attempt, no retries: the whole point of the full benchmark is what
# one flows attempt scores on all 500, and the best-of-5 matrix is the other
# measurement. The extraction inside `run-instance.sh` takes the rig's existing
# `.extract-lock`, so however many workers are in flight only one multi-gigabyte
# `docker cp` runs at a time.
# ---------------------------------------------------------------------------
if [ "$TRANSPORT" = "docker" ]; then
  disk_gate extract || fail "disk gate timed out before the run"
fi
RUN_STARTED="$(now_ms)"
if [ -n "${SWB_RUN_CMD:-}" ]; then
  "$SWB_RUN_CMD" "$ID" "$BUDGET" "" "$INDEX"
else
  "$S/run-instance.sh" "$ID" "$SEAT" "$BUDGET" "$INDEX"
fi
RUN_STATUS=$?
RUN_ENDED="$(now_ms)"
log "harness exit $RUN_STATUS in $(( (RUN_ENDED - RUN_STARTED) / 1000 ))s"

# The patch is captured after the agent, so its existence is what says the
# workspace was built and the attempt really happened. An exit status is not:
# a timeout exits 124 with a perfectly good patch, and a pull failure exits 1
# with nothing at all.
if [ ! -f "$PATCH" ]; then
  fail "the run captured no patch (exit $RUN_STATUS)"
fi
PATCH_BYTES="$(wc -c < "$PATCH" | tr -d ' ')"

# Archive first, delete second. Everything downstream — the report, any later
# forensics, the next drive — reads these and never the workspace.
archive_evidence "$FB/archives/$ID" 1 || fail "archive-failed"
# The shared roots stay as the matrix left them: this instance's artifacts live
# under fullbench/ now, and 500 stray `-r90` files in `patches/` would bury the
# matrix's own.
rm -rf -- "$JOURNAL"
rm -f -- "$PATCH" "$PATCH.untracked" "$TIMINGS" "$LOG_PREFIX".*

COST="$(node "$S/lib/run-cost.mjs" "$FB/journals/$ID" 2>/dev/null || printf '{}')"
# A provider refusal can leave an exit status and an empty patch while serving
# no model call. That is an infrastructure failure, not a graded agent attempt.
# The stubbed dry run has no journal by design and exercises the pipeline only.
if [ -z "${SWB_RUN_CMD:-}" ]; then
  SERVED="$(node -e '
    const c = JSON.parse(process.argv[1])
    process.stdout.write(String(Number.isInteger(c.modelCalls) ? c.modelCalls : 0))
  ' "$COST" 2>/dev/null || printf 0)"
  if [ "$SERVED" -eq 0 ]; then
    fail "no model call served; run exit $RUN_STATUS (see archived run.log)"
  fi
fi
# What `docker inspect` said this instance's testbed container was on, taken off
# the timings `run-instance.sh` wrote rather than off the driver's variable. The
# variable is the request; this is the observation, and the flows arm records it
# for the same reason the codex arm does — a lane's claim about its testbed is
# worth what the container reported and nothing more.
TESTBED_OBSERVED="$(node -e '
  const fs = require("fs")
  try {
    const timings = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const seen = timings.testbedNetworkObserved
    process.stdout.write(seen === "none" || seen === "bridge" ? seen : "")
  } catch { process.stdout.write("") }
' "$FB/timings/$ID.json" 2>/dev/null || printf '')"
TESTBED_ROW=""
if [ -n "$TESTBED_OBSERVED" ]; then
  TESTBED_ROW="--testbedNetworkObserved $TESTBED_OBSERVED"
fi
# The host-shell condition the harness stamped, carried the same way, so a
# report states what the agent's host shell could reach instead of assuming it.
HOST_SHELL="$(node -e '
  const fs = require("fs")
  try {
    const shell = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).hostShell
    process.stdout.write(shell === "allowed" || shell === "sealed" ? shell : "")
  } catch { process.stdout.write("") }
' "$FB/timings/$ID.json" 2>/dev/null || printf '')"
if [ -n "$HOST_SHELL" ]; then
  TESTBED_ROW="$TESTBED_ROW --hostShell $HOST_SHELL"
fi
append "$MANIFEST" "$(row --kind instance --id "$ID" --state ran --at "$RUN_ENDED" \
  --image "$IMAGE" --exit "$RUN_STATUS" --patchBytes "$PATCH_BYTES" \
  --runStartedAt "$RUN_STARTED" --runEndedAt "$RUN_ENDED" \
  --testbedNetwork "${SWB_TESTBED_NETWORK:-none}" $TESTBED_ROW \
  --wallSeconds "$(( (RUN_ENDED - RUN_STARTED) / 1000 ))" --cost-json "$COST")"

# ---------------------------------------------------------------------------
# Grade, immediately, into the one accumulating run id. Serialized across
# workers by a lock: `evaluate.sh` documents that concurrent evaluator workers
# race in the post-run image cleanup and lose the whole report, and two workers
# each running their own single-instance grading is the same race.
# ---------------------------------------------------------------------------
VERDICT=""
if [ "$PATCH_BYTES" = "0" ]; then
  # Not a grading. The official evaluator drops an empty prediction before it
  # starts a container, so there is no verdict to read; "the agent changed
  # nothing" is a fact about the patch and is recorded as one.
  VERDICT="empty patch"
  log "patch is empty — recorded as 'empty patch' without invoking the evaluator"
else
  # The rig's one evaluator lock, not a second one under fullbench/: a
  # `grade-matrix.sh` an operator starts beside this benchmark is another
  # evaluator process on the same docker daemon, and `evaluate.sh` documents
  # what two of those do to each other's image cleanup. It is held across the
  # verdict read as well, so `evaluate.sh` is told not to take it again.
  #
  # A stubbed evaluator starts no container and touches no image, so it takes a
  # lock under fullbench/ instead: the rig's lock is about real evaluator
  # processes on one docker daemon, and a dry run that queued behind a wave's
  # real grading would be measuring that wave's clock rather than its own.
  #
  # On plue each grading boots its own workspace and no image is local, so
  # there is no cleanup to race and no lock is taken.
  if [ -n "${SWB_GRADE_CMD:-}" ]; then GRADE_LOCK="$FB/.grade-lock"; else GRADE_LOCK="$S/.grade-lock"; fi
  if [ "$TRANSPORT" = "docker" ] && ! "$S/lib/lock.sh" acquire "$GRADE_LOCK" --owner $$ --label "fullbench $ID" \
    --timeout "${SWB_GRADE_LOCK_TIMEOUT:-7200}"; then
    fail "another evaluator held $GRADE_LOCK for too long"
  fi
  if [ "$KEEP_IMAGE" = "1" ]; then CACHE_LEVEL=instance; else CACHE_LEVEL=env; fi
  log "grading as $EVAL_RUN_ID (cache_level $CACHE_LEVEL)"
  if [ -n "${SWB_GRADE_CMD:-}" ]; then
    "$SWB_GRADE_CMD" "$EVAL_RUN_ID" "$ID" >> "$FB/logs/$ID.grade.log" 2>&1
  else
    # An absolute SWB_PATCHES, so an FB_DIR inside or outside the rig grades
    # from the archive this worker just wrote.
    ABS_PATCHES="$(cd "$FB/patches" && pwd)" || {
      "$S/lib/lock.sh" release "$GRADE_LOCK" --owner $$ --quiet || true
      fail "no patches directory under FB_DIR ($FB)"; }
    SWB_PATCHES="$ABS_PATCHES" SWB_MODEL_NAME="$MODEL" SWB_CACHE_LEVEL="$CACHE_LEVEL" \
      SWB_GRADE_LOCK_HELD=1 \
      "$S/evaluate.sh" "$EVAL_RUN_ID" "$ID" >> "$FB/logs/$ID.grade.log" 2>&1
  fi
  GRADE_STATUS=$?

  REPORT="$EVAL_LOG_ROOT/$EVAL_RUN_ID/$MODEL/$ID/report.json"
  if [ -f "$REPORT" ]; then
    cp "$REPORT" "$FB/reports/$ID.json"
    VERDICT="$(node -e '
      const report = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
      const row = report[process.argv[2]]
      if (row === undefined) { process.stdout.write("eval error"); }
      else { process.stdout.write(row.resolved === true ? "resolved" : "unresolved"); }
    ' "$REPORT" "$ID")"
  else
    VERDICT="eval error"
    log "the evaluator wrote no report for this instance (exit $GRADE_STATUS)"
  fi
  # Released here rather than in the trap: the verdict is read, and the next
  # worker's grading may start while this one deletes its image.
  "$S/lib/lock.sh" release "$GRADE_LOCK" --owner $$ --quiet || true
fi

append "$MANIFEST" "$(row --kind instance --id "$ID" --state graded --at "$(now_ms)" \
  --image "$IMAGE" --verdict "$VERDICT")"
log "verdict: $VERDICT"

# ---------------------------------------------------------------------------
# Delete. The testbed is already gone — `run-instance.sh` deletes an indexed
# run's workspace once the patch is captured — so what is left is the image.
# The five the 5x5 matrix pinned are never deleted, whatever this instance is,
# because that wave needs them warm and re-pulling one costs 3 GB.
# ---------------------------------------------------------------------------
REMOVED="$(discard_image)"
if [ "$KEEP_IMAGE" = "1" ] && [ "$TRANSPORT" = "docker" ]; then log "image kept: $ID is one of the pinned five"; fi

append "$MANIFEST" "$(row --kind instance --id "$ID" --state cleaned --at "$(now_ms)" \
  --image "$IMAGE" --image-state "$REMOVED" --freeMiB "$("$S/lib/disk-free.sh")")"
log "cleaned (image $REMOVED)"
exit 0
