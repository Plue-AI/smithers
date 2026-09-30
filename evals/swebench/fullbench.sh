#!/bin/bash
# The full SWE-bench Verified benchmark: all 500 instances, one flows attempt
# each, streaming, resumable, and detached.
#
#   ./fullbench.sh                 start a new benchmark
#   ./fullbench.sh --resume        continue the one already in fullbench/
#   ./fullbench.sh --foreground    run in this process (the rig's own tests)
#   ./fullbench.sh --stop          ask a running driver to stop after its
#                                  in-flight instances finish
#   ./fullbench.sh --clear-pause   remove a PAUSED marker so --resume can start
#   ./fullbench.sh --aggregate     write the evaluator's own report over every
#                                  instance graded so far (spends nothing)
#
# Detached launch, exactly. Copy this line:
#
#   cd evals/swebench && mkdir -p fullbench \
#     && nohup ./fullbench.sh --resume >> fullbench/launch.log 2>&1 < /dev/null &
#
# The `mkdir` is not optional on a rig that has never run one: the shell opens
# the redirect before it runs anything, so without the directory the line fails
# and no driver starts. `nohup` detaches it from the terminal, and this script
# then double-forks itself — `( worker & )` runs the worker in a subshell that
# exits immediately, so the worker is reparented to launchd — which is what
# makes it survive the session that launched it, not just the terminal. The launcher prints the
# worker's pid and exits; everything after that is in `fullbench/driver.log`.
#
# What it does, per instance, two at a time:
#
#   wait for 8 GiB free -> pull -> run one attempt -> grade THAT instance now,
#   while its image is still local -> archive journal, patch and report ->
#   delete the testbed and the image
#
# The image is the reason for the shape. 500 official images are about 1.5 TB
# and this machine has 16 GiB to spare, shared with the 5x5 best-of-n matrix, so
# nothing multi-gigabyte may outlive the instance that needed it. The five
# images that matrix pinned are never deleted.
#
# Resume is a ledger, not a checkpoint: `fullbench/manifest.jsonl` records every
# state every instance reaches, fsynced before the next one starts. A restart
# skips every instance whose last state is `graded` and re-runs everything else
# from the top, cleanly. A crash mid-instance therefore costs that instance and
# nothing else.
#
# `SWB_TRANSPORT=plue` runs the same pipeline on Smithers Cloud workspaces:
# each instance boots its official image as a `--network none` workspace for
# the agent and a second one for grading, so nothing is pulled here, there is no
# disk gate, and no image outlives anything. See README.md, "On Smithers Cloud".
#
# This spends real API tokens. See README.md, "The full benchmark".
set -u
S="$(cd "$(dirname "$0")" && pwd)"
FB="${FB_DIR:-$S/fullbench}"

JOBS="${SWB_FULLBENCH_JOBS:-2}"
BUDGET_USD="${SWB_FULLBENCH_BUDGET_USD:-600}"
CHECKPOINT_EVERY="${SWB_FULLBENCH_CHECKPOINT_EVERY:-25}"
MIN_FREE_MIB="${SWB_FULLBENCH_MIN_FREE_MIB:-8192}"
RUN_ID="${SWB_FULLBENCH_RUN_ID:-fullbench}"
INDEX="${SWB_FULLBENCH_INDEX:-r90}"
SEAT="${SWB_SEAT:-openai:gpt-6-sol}"
# `api-key` bills OPENAI_API_KEY credits; `chatgpt` runs the same seat on the
# operator's ChatGPT plan through the codex CLI's session. Ledger dollars under
# `chatgpt` are derived at API list prices, not billed; the header records the
# mode. See run-45.sh for the full note.
OPENAI_AUTH="${SWB_FLOWS_OPENAI_AUTH:-api-key}"
INSTANCE_BUDGET="${SWB_FULLBENCH_BUDGET:-1200}"
DATASET="${SWB_DATASET:-$S/swb-verified.json}"
MODEL_NAME="${SWB_MODEL_NAME:-flows-cell-harness}"
SAMPLE="${SWB_SAMPLE:-$S/sample.json}"
POLL_SECONDS="${SWB_FULLBENCH_POLL_SECONDS:-5}"
POLL_LIMIT="${SWB_FULLBENCH_POLL_LIMIT:-720}"
# How many instances this session may schedule. Empty is "everything left",
# which is the benchmark; a number is how an operator spends one night's worth
# and reads the checkpoint before committing the rest, and is how the dry run
# holds a queue still while it kills the driver.
SESSION_LIMIT="${SWB_FULLBENCH_LIMIT:-}"

# Every knob that reaches shell arithmetic or a `[ -ge ]`, checked before
# anything is spent. `[ 1200 -ge NaN ]` is not a comparison that fails safe: it
# is an error the shell reports and the `if` then treats as false, so a budget
# typed as `$600` would read as no budget at all for two days.
for PAIR in "JOBS:$JOBS" "CHECKPOINT_EVERY:$CHECKPOINT_EVERY" "MIN_FREE_MIB:$MIN_FREE_MIB" \
  "INSTANCE_BUDGET:$INSTANCE_BUDGET" "POLL_SECONDS:$POLL_SECONDS" "POLL_LIMIT:$POLL_LIMIT"; do
  NAME="${PAIR%%:*}"; VALUE="${PAIR#*:}"
  case "$VALUE" in
    ''|*[!0-9]*|0) echo "fullbench.sh: $NAME must be a positive integer, got '$VALUE'"; exit 2 ;;
  esac
done
case "$BUDGET_USD" in
  ''|*[!0-9.]*|*.*.*|.|*.) echo "fullbench.sh: SWB_FULLBENCH_BUDGET_USD must be a number, got '$BUDGET_USD'"; exit 2 ;;
esac
case "$OPENAI_AUTH" in
  api-key|chatgpt) ;;
  *) echo "fullbench.sh: SWB_FLOWS_OPENAI_AUTH must be 'api-key' or 'chatgpt', got '$OPENAI_AUTH'"; exit 2 ;;
esac
TRANSPORT="$("$S/lib/transport.sh")" || exit 2
if [ -n "$SESSION_LIMIT" ]; then
  case "$SESSION_LIMIT" in
    ''|*[!0-9]*) echo "fullbench.sh: SWB_FULLBENCH_LIMIT must be a non-negative integer, got '$SESSION_LIMIT'"; exit 2 ;;
  esac
fi

# Is the pid in driver.pid a live driver? The file is written once and never
# deleted, on purpose, so `kill -0` alone answers "is *something* alive with
# that number" — and over days on a machine that recycles pids, something
# unrelated eventually is. A benchmark that then refuses every resume for the
# rest of the week is the failure this avoids.
driver_alive() {
  if [ ! -f "$FB/driver.pid" ]; then return 1; fi
  DRIVER_PID="$(cat "$FB/driver.pid" 2>/dev/null || printf '')"
  case "$DRIVER_PID" in
    ''|*[!0-9]*) return 1 ;;
  esac
  if ! kill -0 "$DRIVER_PID" 2>/dev/null; then return 1; fi
  ps -p "$DRIVER_PID" -o command= 2>/dev/null | grep -q 'fullbench\.sh' || return 1
  return 0
}

RESUME=0
FOREGROUND=0
for ARG in "$@"; do
  case "$ARG" in
    --resume) RESUME=1 ;;
    --foreground) FOREGROUND=1 ;;
    --stop)
      if driver_alive; then
        kill -TERM "$DRIVER_PID"
        echo "fullbench.sh: asked pid $DRIVER_PID to stop"
        exit 0
      fi
      echo "fullbench.sh: no driver is running"; exit 1 ;;
    --clear-pause) rm -f "$FB/PAUSED"; echo "fullbench.sh: pause cleared"; exit 0 ;;
    # The official evaluator's own aggregate report for the whole run.
    #
    # Grading one instance at a time accumulates the per-instance reports under
    # one run id, which is what the driver reads — but it rewrites
    # `preds-<run id>.json` and the evaluator's `<model>.<run id>.json` each
    # time, so the file the rig documents as "the evaluator's own report" ends
    # up describing the last instance alone. This grades every id the ledger
    # says is done in one invocation: each already has a report, so the
    # evaluator skips all of them, starts no container and spends nothing, and
    # writes the summary over all of them.
    --aggregate)
      AGGREGATE_IDS="$(node "$S/lib/fullbench-queue.mjs" "$DATASET" "$FB/manifest.jsonl" --done \
        | tr '\n' ' ')"
      if [ -z "$AGGREGATE_IDS" ]; then
        echo "fullbench.sh: nothing has been graded yet"; exit 1
      fi
      # Absolute, so an FB_DIR outside the rig grades from where it was written.
      ABS_PATCHES="$(cd "$FB/patches" && pwd)" || {
        echo "fullbench.sh: no patches directory under FB_DIR ($FB)"; exit 1; }
      echo "fullbench.sh: aggregating $(printf '%s' "$AGGREGATE_IDS" | wc -w | tr -d ' ') graded instances into $MODEL_NAME.$RUN_ID.json"
      SWB_PATCHES="$ABS_PATCHES" SWB_MODEL_NAME="$MODEL_NAME" SWB_CACHE_LEVEL=instance \
        exec "$S/evaluate.sh" "$RUN_ID" $AGGREGATE_IDS ;;
    --help|-h) sed -n '2,44p' "$0"; exit 0 ;;
    *) echo "fullbench.sh: unknown argument '$ARG'"; exit 2 ;;
  esac
done

MANIFEST="$FB/manifest.jsonl"
PROGRESS="$FB/progress.md"

# ---------------------------------------------------------------------------
# The launcher half. Everything above runs in whatever shell called this; from
# here the work happens in a process that outlives it.
# ---------------------------------------------------------------------------
if [ -z "${SWB_FULLBENCH_EXEC:-}" ]; then
  mkdir -p "$FB"
  if driver_alive; then
    echo "fullbench.sh: a driver is already running (pid $DRIVER_PID). Use --stop first."
    exit 1
  fi
  if [ -f "$FB/PAUSED" ]; then
    echo "fullbench.sh: the benchmark is PAUSED:"
    sed 's/^/  /' "$FB/PAUSED"
    echo "  Raise SWB_FULLBENCH_BUDGET_USD or free disk, then ./fullbench.sh --clear-pause"
    exit 1
  fi
  if [ -f "$MANIFEST" ] && [ "$RESUME" = "0" ]; then
    echo "fullbench.sh: $MANIFEST already exists. Pass --resume to continue it,"
    echo "  or move fullbench/ aside to start a new benchmark."
    exit 1
  fi
  if [ "$FOREGROUND" = "0" ]; then
    rm -f "$FB/driver.pid"
    ( SWB_FULLBENCH_EXEC=1 nohup "$0" "$@" >> "$FB/driver.log" 2>&1 < /dev/null & )
    WAITED=0
    while [ ! -f "$FB/driver.pid" ] && [ "$WAITED" -lt 30 ]; do sleep 1; WAITED=$((WAITED + 1)); done
    if [ -f "$FB/driver.pid" ]; then
      echo "fullbench.sh: driver detached as pid $(cat "$FB/driver.pid")"
      echo "  log      $FB/driver.log"
      echo "  status   ./fullbench-status.sh"
      echo "  stop     ./fullbench.sh --stop"
      exit 0
    fi
    echo "fullbench.sh: the detached driver did not start. The end of $FB/driver.log:"
    tail -20 "$FB/driver.log" 2>/dev/null | sed 's/^/  /'
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# The driver.
# ---------------------------------------------------------------------------
mkdir -p "$FB" "$FB/workers" "$FB/claims" "$FB/patches" "$FB/journals" "$FB/timings" \
  "$FB/logs" "$FB/reports"
# The pid file is written once and never deleted. Liveness is `kill -0` on what
# it holds — which is what every reader already does — and a file that outlives
# the process it names is what makes the launcher's wait race-free: a driver
# that started and finished before the launcher's first poll would otherwise be
# indistinguishable from one that never started.
echo $$ > "$FB/driver.pid"

now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
log() { printf '%s [driver] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
append() { node "$S/lib/manifest-append.mjs" "$1" "$2"; }
row() { node "$S/lib/fullbench-row.mjs" "$@"; }

# Locks and claims a crashed predecessor may have left. Every one of them is
# taken back by owner rather than by assumption: this driver is a singleton, but
# the rig it runs in is not. `.extract-lock` and `.grade-lock` are shared with
# the 5x5 matrix wave, and clearing one of those while that wave holds it would
# put two multi-gigabyte extractions — or two evaluators — on one disk, which is
# the thing they exist to prevent. `lib/lock.sh` clears a lock only when the pid
# that owns it is gone.
for LOCK in "$S/.extract-lock" "$S/.grade-lock" "$FB/.grade-lock"; do
  log "$("$S/lib/lock.sh" reconcile "$LOCK" 2>&1)"
done
# A claim whose worker is still alive is a worker *this* driver did not start:
# killing the driver alone leaves its workers running (`pkill -f fullbench.sh`
# matches the driver and not `fullbench-instance.sh`), and scheduling a second
# attempt beside one of those is two agents spending on one instance, into one
# patch path. The claim outlives the driver on purpose; only the dead ones go.
for CLAIM in "$FB"/claims/*; do
  if [ ! -d "$CLAIM" ]; then continue; fi
  CLAIM_OWNER="$("$S/lib/lock.sh" owner "$CLAIM")"
  if [ -n "$CLAIM_OWNER" ] && kill -0 "$CLAIM_OWNER" 2>/dev/null; then
    log "an orphaned worker is still running $(basename "$CLAIM") (pid $CLAIM_OWNER) — it keeps the instance"
  else
    log "$("$S/lib/lock.sh" reconcile "$CLAIM" 2>&1)"
  fi
done
rm -f "$FB"/workers/*.done "$FB"/workers/*.pid 2>/dev/null || true

if [ ! -f "$DATASET" ]; then log "no dataset at $DATASET — run ./bootstrap.sh first"; exit 1; fi
if [ ! -f "$SAMPLE" ]; then log "no sample at $SAMPLE — run ./bootstrap.sh first"; exit 1; fi

# The five the best-of-5 matrix pinned, whose images this benchmark must never
# delete. Same rule the matrix uses: the seeded sample's first SWB_SAMPLE_COUNT.
PINNED="$(node -e '
  const sample = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  process.stdout.write(sample.instances.slice(0, Number(process.argv[2])).join(" "))
' "$SAMPLE" "${SWB_SAMPLE_COUNT:-5}")"
if [ -n "${SWB_FULLBENCH_PINNED:-}" ]; then PINNED="$SWB_FULLBENCH_PINNED"; fi

# ---------------------------------------------------------------------------
# One subject, for the whole benchmark.
#
# The rig's rule is one wave one subject, and 500 instances over several days is
# the longest wave there has ever been, so the pin matters more here, not less.
# But the 5x5 matrix in this same rig shares `.subject.json`, and re-pinning
# under it would silently re-arm a wave that ought to have stopped. So:
#
#   no pin        -> ./preflight.sh, and this benchmark owns the pin
#   live pin      -> adopt it; the subject is already the one on disk
#   stale pin     -> refuse. Re-pinning is an operator decision, never a side
#                    effect of starting a benchmark next to another wave.
#
# After this the pin is never touched again. `flows.sh` re-derives the
# fingerprint on every call and stops an instance whose subject moved, and that
# refusal is recorded per instance rather than papered over.
# ---------------------------------------------------------------------------
if [ -n "${SWB_RUN_CMD:-}" ]; then
  # A stubbed run command runs no harness and spends nothing, so it has no
  # subject to pin; the refusal would only stop the driver's own dry run. Same
  # exemption, for the same reason, that `run-matrix.sh` makes.
  log "SWB_RUN_CMD is set — no harness runs, so no subject is pinned"
  SUBJECT_SOURCE=stubbed
elif [ ! -f "$S/.subject.json" ]; then
  log "no subject pinned — running ./preflight.sh"
  "$S/preflight.sh" || { log "preflight failed; a benchmark cannot start"; exit 1; }
  SUBJECT_SOURCE=preflight
elif node "$S/lib/subject.mjs" --expect "$S/.subject.json" --quiet >/dev/null 2>&1; then
  log "adopted the live pin in .subject.json (not re-running preflight: a sibling wave shares it)"
  SUBJECT_SOURCE=adopted
else
  log "the pinned subject in .subject.json is not what is on disk."
  log "  Re-pin deliberately with ./preflight.sh — doing it here would re-arm a sibling wave."
  exit 1
fi

SUBJECT="stubbed"
if [ "$SUBJECT_SOURCE" != "stubbed" ]; then
  SUBJECT="$(node -e '
    process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).stamp)
  ' "$S/.subject.json")"
fi
HEAD_AT_START="$(cd "$S" && git rev-parse HEAD 2>/dev/null || printf 'unknown')"

append "$MANIFEST" "$(row --kind header --at "$(now_ms)" --runId "$RUN_ID" --index "$INDEX" \
  --subject "$SUBJECT" --subjectSource "$SUBJECT_SOURCE" --head "$HEAD_AT_START" \
  --seat "$SEAT" --openaiAuth "$OPENAI_AUTH" --transport "$TRANSPORT" --jobs "$JOBS" --instanceBudgetSeconds "$INSTANCE_BUDGET" \
  --budgetUsd "$BUDGET_USD" --minFreeMiB "$MIN_FREE_MIB" --checkpointEvery "$CHECKPOINT_EVERY" \
  --pinnedImages "$PINNED" --dataset "$DATASET")"

log "subject $SUBJECT ($SUBJECT_SOURCE), HEAD $HEAD_AT_START"
log "transport $TRANSPORT"
if [ "$TRANSPORT" = "plue" ]; then
  log "jobs $JOBS, budget \$$BUDGET_USD, no disk gate (plue), checkpoint every $CHECKPOINT_EVERY"
else
  log "jobs $JOBS, budget \$$BUDGET_USD, disk gate ${MIN_FREE_MIB} MiB, checkpoint every $CHECKPOINT_EVERY"
  log "images never deleted: $PINNED"
fi

# ---------------------------------------------------------------------------
# Images an interrupted instance left behind.
#
# `graded` is the resume boundary, so an instance killed between its verdict and
# its cleanup — a window that includes the whole `docker rmi` — is skipped for
# ever after, and its 2–3 GB image would sit on this disk for the rest of the
# benchmark. Nothing else ever looks at it again, so this is the sweep that
# closes it, and it runs before the first instance is scheduled because the disk
# it frees is the disk the first pull needs.
#
# The image ref comes out of the ledger rather than being re-derived, so a run
# that mapped its images (the dry run does) reconciles the ones it really used.
# ---------------------------------------------------------------------------
#
# On plue there is no local image; what a killed worker leaves is a running
# workspace, and `lib/plue.py reap` deletes every one this host made whose
# owning process is gone.
UNCLEAN=""
if [ "$TRANSPORT" = "plue" ]; then
  for REAPED in $("$S/lib/plue.py" reap 2>>"$FB/driver.log"); do
    log "reaped orphaned workspace $REAPED"
  done
else
  UNCLEAN="$(node "$S/lib/fullbench-queue.mjs" "$DATASET" "$MANIFEST" --unclean 2>/dev/null || printf '')"
fi
if [ -n "$UNCLEAN" ]; then
  printf '%s\n' "$UNCLEAN" | while read -r STALE_ID STALE_IMAGE; do
    if [ -z "$STALE_ID" ] || [ -z "$STALE_IMAGE" ]; then continue; fi
    STALE_KEEP=0
    for PIN in $PINNED; do
      if [ "$PIN" = "$STALE_ID" ]; then STALE_KEEP=1; fi
    done
    if STALE_PATHS="$("$S/lib/run-paths.sh" flows "$STALE_ID" "$INDEX" 2>/dev/null)"; then
      eval "$STALE_PATHS"
      docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
      rm -rf -- "$WORK"
    fi
    if [ "$STALE_KEEP" = "1" ]; then
      STALE_STATE=kept
    else
      docker rmi -f "$STALE_IMAGE" >/dev/null 2>&1 || true
      if docker image inspect "$STALE_IMAGE" >/dev/null 2>&1; then
        STALE_STATE=present
      else
        STALE_STATE=deleted
      fi
    fi
    append "$MANIFEST" "$(row --kind instance --id "$STALE_ID" --state cleaned --at "$(now_ms)" \
      --image "$STALE_IMAGE" --image-state "$STALE_STATE" --reconciled 1)"
    log "reconciled $STALE_ID: graded but never cleaned (image $STALE_STATE)"
  done
fi

export FB_DIR="$FB"
export SWB_FULLBENCH_INDEX="$INDEX"
export SWB_FULLBENCH_RUN_ID="$RUN_ID"
export SWB_FULLBENCH_MIN_FREE_MIB="$MIN_FREE_MIB"
export SWB_FULLBENCH_PINNED="$PINNED"
export SWB_FULLBENCH_BUDGET="$INSTANCE_BUDGET"
export SWB_SEAT="$SEAT"
export SWB_FLOWS_OPENAI_AUTH="$OPENAI_AUTH"
export SWB_TRANSPORT="$TRANSPORT"

QUEUE="$(node "$S/lib/fullbench-queue.mjs" "$DATASET" "$MANIFEST" --remaining)" || {
  log "could not build the queue"; exit 1; }
COUNTS="$(node "$S/lib/fullbench-queue.mjs" "$DATASET" "$MANIFEST" --count)"
DONE_AT_START="$(printf '%s' "$COUNTS" | awk '{print $1}')"
TOTAL="$(printf '%s' "$COUNTS" | awk '{print $3}')"
LAST_CHECKPOINT=$((DONE_AT_START - DONE_AT_START % CHECKPOINT_EVERY))
log "$DONE_AT_START of $TOTAL already graded; $((TOTAL - DONE_AT_START)) to run"

STOPPING=0
PAUSE_REASON=""
RUNNING=0
PIDS=()
NAMES=()

on_term() {
  STOPPING=1
  log "stop requested — no new instances will be scheduled; in-flight ones finish"
}
trap on_term TERM INT

# Reaps every worker that has finished, without blocking. A finished worker is
# one that wrote its `.done` marker: `kill -0` cannot tell a finished child from
# a zombie one, and a zombie is exactly what an unreaped child is.
reap_finished() {
  REAPED=0
  if [ "${#PIDS[@]}" -eq 0 ]; then return 1; fi
  for i in "${!PIDS[@]}"; do
    if [ -z "${PIDS[$i]}" ]; then continue; fi
    if [ -f "$FB/workers/${NAMES[$i]}.done" ]; then
      wait "${PIDS[$i]}" 2>/dev/null
      CODE="$(cat "$FB/workers/${NAMES[$i]}.done" 2>/dev/null || printf 'unknown')"
      rm -f "$FB/workers/${NAMES[$i]}.done" "$FB/workers/${NAMES[$i]}.pid"
      if [ "$CODE" = "3" ]; then
        log "${NAMES[$i]} is claimed by a worker this driver did not start — left to it"
      else
        log "${NAMES[$i]} finished (exit $CODE)"
      fi
      PIDS[$i]=""
      RUNNING=$((RUNNING - 1))
      REAPED=1
    fi
  done
  return $((1 - REAPED))
}

# Reaps the oldest tracked worker that is **already dead**. Reached when polling
# has gone a full hour without a `.done` marker, which is either a worker that
# died without running its own exit path — `wait` on a zombie returns at once —
# or one that is simply slow.
#
# It must never block on a worker that is still alive. `wait` on a live pid is a
# driver that stops logging, stops scheduling and stops checkpointing until that
# worker returns, which is indistinguishable from the crash it is meant to
# survive. So a live worker is reported instead, together with the one thing
# that can wedge one for ever: a lock whose holder is gone.
reap_oldest() {
  if [ "${#PIDS[@]}" -eq 0 ]; then return 1; fi
  for i in "${!PIDS[@]}"; do
    if [ -n "${PIDS[$i]}" ]; then
      if kill -0 "${PIDS[$i]}" 2>/dev/null; then
        log "${NAMES[$i]} has run for over $((POLL_LIMIT * POLL_SECONDS / 60)) minutes without finishing"
        for LOCK in "$S/.extract-lock" "$S/.grade-lock"; do
          log "  $("$S/lib/lock.sh" reconcile "$LOCK" 2>&1)"
        done
        return 1
      fi
      log "${NAMES[$i]} left no completion marker — reaping it"
      wait "${PIDS[$i]}" 2>/dev/null
      # A lost marker is not a lost instance. A wrapper killed after its last
      # ledger row was written, or one whose marker write failed on a full disk,
      # finished the work; recording that instance as failed would send one the
      # evaluator has already graded back through the whole pipeline on the next
      # resume. Everything else did lose the instance, and a reap that left no
      # row would leave it looking in-flight for ever.
      LAST_STATE="$(node "$S/lib/fullbench-state.mjs" "$MANIFEST" "${NAMES[$i]}")"
      case "$?" in
        0) log "  the ledger already records it as $LAST_STATE — only the marker was lost" ;;
        1) append "$MANIFEST" "$(row --kind instance --id "${NAMES[$i]}" --state failed \
             --at "$(now_ms)" --reason "the worker died without writing a completion marker")" ;;
        *) log "  the ledger could not be read, so this worker's fate is not recorded" ;;
      esac
      rm -f "$FB/workers/${NAMES[$i]}.done" "$FB/workers/${NAMES[$i]}.pid"
      PIDS[$i]=""
      RUNNING=$((RUNNING - 1))
      return 0
    fi
  done
  return 1
}

# One poll of every tracked worker: reaps the ones that wrote a `.done` marker,
# and once `POLLS` has reached `POLL_LIMIT` falls back to `reap_oldest`, which
# reaps a worker that is already dead and reports one that is merely slow.
# Returns 0 as soon as a worker has been accounted for.
#
# Both waits poll through this, because both fail the same way. The final drain
# used to reap markers alone, so a wrapper that was killed — or one whose marker
# write failed — left `RUNNING` above zero for ever: the driver never
# checkpointed, never reported and never exited, which is exactly the crash the
# markers exist to survive.
#
# The caller owns `POLLS` and the sleep between polls, because what it does
# while it waits differs: the scheduler stops waiting when a stop is requested,
# the drain never does.
poll_workers() {
  if reap_finished; then POLLS=0; return 0; fi
  POLLS=$((POLLS + 1))
  if [ "$POLLS" -lt "$POLL_LIMIT" ]; then return 1; fi
  POLLS=0
  reap_oldest
}

# Waits for a slot, and returns only when there is one. Returning without one —
# which is what "give up after an hour" used to do — schedules a third instance
# beside two that are still running, and three testbeds is the disk this whole
# shape exists to bound.
wait_for_slot() {
  POLLS=0
  while [ "$RUNNING" -ge "$JOBS" ]; do
    if poll_workers; then return 0; fi
    if [ "$STOPPING" = "1" ]; then return 0; fi
    sleep "$POLL_SECONDS"
  done
  return 0
}

checkpoint() {
  node "$S/fullbench-report.mjs" --checkpoint --manifest "$MANIFEST" --dataset "$DATASET" \
    --sample "$SAMPLE" --out "$FB" || log "the report generator failed"
}

# Whole cents spent so far, or the empty string when the ledger could not be
# read. Never a number the caller did not get from the manifest.
spend_cents() {
  CENTS="$(node "$S/fullbench-report.mjs" --spend-cents --manifest "$MANIFEST" 2>/dev/null)"
  case "$CENTS" in
    ''|*[!0-9]*) printf '' ;;
    *) printf '%s' "$CENTS" ;;
  esac
}
BUDGET_CENTS="$(node -e 'process.stdout.write(String(Math.round(Number(process.argv[1]) * 100)))' "$BUDGET_USD")"
# The cap the gate compares against, in the same units it reads. If this is not
# a number the gate is not a gate, and a driver with no budget must not run.
case "$BUDGET_CENTS" in
  ''|*[!0-9]*) log "could not read \$$BUDGET_USD as a budget"; exit 2 ;;
esac

pause_now() {
  PAUSE_REASON="$1"
  STOPPING=1
  printf '%s\n' "$PAUSE_REASON" > "$FB/PAUSED"
  append "$MANIFEST" "$(row --kind note --at "$(now_ms)" --note paused --reason "$PAUSE_REASON")"
  log "PAUSED: $PAUSE_REASON"
}

# ---------------------------------------------------------------------------
# The schedule. One pass over what is left, in seeded draw order, two in flight.
# ---------------------------------------------------------------------------
SCHEDULED=0
for ID in $QUEUE; do
  if [ "$STOPPING" = "1" ]; then break; fi
  if [ -n "$SESSION_LIMIT" ] && [ "$SCHEDULED" -ge "$SESSION_LIMIT" ]; then
    log "session limit of $SESSION_LIMIT instances reached; the rest stay queued"
    break
  fi

  # Wait for a slot first: a worker reaped here may have just recorded the
  # spend that crosses the budget, so the gate below must read the ledger after
  # the wait, immediately before admission.
  wait_for_slot
  if [ "$STOPPING" = "1" ]; then break; fi

  # The budget, checked before every launch rather than at a checkpoint: 25
  # instances of overshoot at a few dollars each is real money.
  #
  # A read that fails is not zero. `|| printf 0` here would turn one bad node
  # invocation into a benchmark with no budget at all, so an unreadable ledger
  # is retried once and then pauses: stopping early is recoverable with
  # `--clear-pause`, and spending blind for two days is not.
  SPENT_CENTS="$(spend_cents)"
  if [ -z "$SPENT_CENTS" ]; then sleep 2; SPENT_CENTS="$(spend_cents)"; fi
  if [ -z "$SPENT_CENTS" ]; then
    pause_now "the ledger's cumulative cost could not be read, so the budget cannot be enforced"
    break
  fi
  if [ "$SPENT_CENTS" -ge "$BUDGET_CENTS" ]; then
    pause_now "cumulative API cost \$$(node -e 'process.stdout.write((Number(process.argv[1])/100).toFixed(2))' "$SPENT_CENTS") reached the \$$BUDGET_USD budget"
    break
  fi

  # The subject was pinned once and is never re-pinned, but a moving HEAD under
  # it is worth a line in the ledger: it is how a later reader learns that the
  # tree changed during the benchmark even though the bytes the CLI loads did
  # not (or that `flows.sh` is about to start refusing instances).
  HEAD_NOW="$(cd "$S" && git rev-parse HEAD 2>/dev/null || printf 'unknown')"
  if [ "$HEAD_NOW" != "$HEAD_AT_START" ]; then
    append "$MANIFEST" "$(row --kind note --at "$(now_ms)" --note head-moved \
      --from "$HEAD_AT_START" --to "$HEAD_NOW" --beforeInstance "$ID")"
    log "HEAD moved $HEAD_AT_START -> $HEAD_NOW; the subject pin is unchanged and is not re-pinned"
    HEAD_AT_START="$HEAD_NOW"
  fi

  log "scheduling $ID"
  ( "$S/lib/fullbench-instance.sh" "$ID"; echo $? > "$FB/workers/$ID.done" ) &
  PID=$!
  echo "$PID" > "$FB/workers/$ID.pid"
  PIDS[${#PIDS[@]}]="$PID"
  NAMES[${#NAMES[@]}]="$ID"
  RUNNING=$((RUNNING + 1))
  SCHEDULED=$((SCHEDULED + 1))

  DONE_NOW="$(node "$S/lib/fullbench-queue.mjs" "$DATASET" "$MANIFEST" --count | awk '{print $1}')"
  if [ "$DONE_NOW" -ge "$((LAST_CHECKPOINT + CHECKPOINT_EVERY))" ]; then
    LAST_CHECKPOINT=$((DONE_NOW - DONE_NOW % CHECKPOINT_EVERY))
    log "checkpoint at $DONE_NOW instances"
    checkpoint
  fi
done

log "draining $RUNNING in-flight instances"
POLLS=0
while [ "$RUNNING" -gt 0 ]; do
  if ! poll_workers; then sleep "$POLL_SECONDS"; fi
done

log "final checkpoint"
checkpoint
FINAL="$(node "$S/lib/fullbench-queue.mjs" "$DATASET" "$MANIFEST" --count)"
log "$(printf '%s' "$FINAL" | awk '{print $1 " of " $3 " graded, " $2 " left"}')"

if [ -n "$PAUSE_REASON" ]; then exit 7; fi
exit 0
