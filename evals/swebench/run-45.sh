#!/bin/bash
# The re-run: the r90 baseline's 45 instances, once each, on today's harness.
#
#   ./run-45.sh                 start (or continue) the re-run, detached
#   ./run-45.sh --foreground    run in this process (the rig's own tests)
#   ./run-45.sh --list          the instances it still owes, and stop
#   ./run-45.sh --status        counts, and stop
#   ./run-45.sh --stop          ask a running driver to stop after its
#                               in-flight instances finish
#   ./run-45.sh --limit N       schedule at most N instances this session
#   ./run-45.sh --lane NAME     name the lane: ledger, archive, artifact index
#                               and evaluator run id all derive from it
#
# ## The lane
#
# A lane is one measurement of the population on one subject. `--lane r92`
# writes `fullbench/rerun-r92/`, indexes artifacts `r92`, and grades into the
# evaluator run id `rerun-r92`. The default is `r91`, the first re-run, so an
# operator who names no lane resumes that one rather than starting a nameless
# sixth. Every subcommand takes it, because `--status` on the wrong lane reads
# the wrong ledger. `SWB_RERUN_LANE` sets it from the environment; `FB_DIR`,
# `SWB_RERUN_INDEX` and `SWB_RERUN_RUN_ID` still override the three values it
# derives, one at a time, for the rig's own tests.
#
# `analysis/PROGRAM.md` names eleven harness changes and, for each, a falsifiable
# prediction about what the same 45 instances would then cost. This is the
# measurement those predictions are settled against. It is the *only* thing that
# settles them: an argument that a change helps is not a number.
#
# ## What is held fixed
#
# Everything except the harness. The comparison is worthless otherwise, so the
# knobs are not knobs:
#
# | | r90 baseline | this re-run |
# | --- | --- | --- |
# | instances | 45, seeded draw order | **the same 45**, same order, read out of the baseline ledger |
# | attempts per instance | one | one |
# | per-instance budget | 1200 s | 1200 s |
# | seat | `openai:gpt-5.6-sol` | `openai:gpt-5.6-sol` |
# | journals | archived per instance | archived per instance |
# | testbeds and images | deleted after the verdict | deleted after the verdict |
# | grading | official evaluator, x86_64 images | the same, plus the rig fixes in `lib/grade.py` |
# | in flight | 2 | 3 |
# | authoring surface | the filing surface | the persistent realm, which is the only one there is |
#
# ## The surface
#
# There is no arm to select. Every run holds one persistent realm for its whole
# life — a cell's top-level names are still bound in the next cell,
# `console.log` is the channel to the next model turn, and the run ends at
# `ctx.done`/`ctx.park` rather than at a returned object
# (`docs/specs/Concepts/Repl Realm.md`). The filing surface this replaced was
# deleted on 2026-08-24 as a design error, so `FLOWS_CELL_MODE` selects nothing
# and no longer exists. Every lane runs the same 45 instances in the same order
# at the same seat and the same budgets, and the task prompt is byte-identical:
# `lib/write-flow.mjs` is not a knob.
#
# Two of those rows deserve their reason stated rather than assumed.
#
# **The instance list is derived, never typed.** `lib/rerun-queue.mjs` takes the
# ids the baseline ledger actually graded and orders them by the same seeded
# draw. There is no flag that adds or drops one, so a re-run cannot quietly
# become a re-run of an easier set.
#
# **Three in flight rather than two.** This changes wall-clock *scheduling*, not
# what any instance is measured at: `lib/fullbench-instance.sh` gives every
# instance its own container, its own testbed and its own 1200 s budget, and the
# numbers this benchmark compares — dollars, frames, and the agent's own span —
# are per-instance and never wall-clock-of-the-whole-run. What three does change
# is disk: three testbeds plus three images against the same 8 GiB gate, which is
# why the gate is still there and still blocks. Set `SWB_RERUN_JOBS=2` to hold
# even this fixed.
#
# **The grading rig is fixed, and that is on purpose.** `lib/grade.py` now scopes
# the evaluator's image cleanup so one grading cannot delete another's image
# (which is what produced every r90 `eval error`), and `evaluate.sh` serves the
# psf/requests family a local httpbin (which is what produced two false
# `unresolved`s). Compare against the *re-graded* baseline — `./regrade.sh` has
# already written those verdicts into `fullbench/manifest.jsonl` — so the
# denominator is the same rig on both sides.
#
# ## Where it writes
#
# Its own ledger and archive, under `fullbench/rerun-<lane>/`, so the baseline's
# `fullbench/manifest.jsonl` is never appended to and stays exactly what
# `compare-runs.mjs` compares against. Artifacts carry the lane as their index
# and grade into the evaluator run id `rerun-<lane>`. One lane never writes into
# another's ledger, which is what makes a second measurement of the same 45
# instances a second measurement rather than an append to the first.
#
# Resume is the ledger, as the full benchmark's is: an instance whose last row is
# `graded` or `cleaned` is skipped and everything else re-runs from the top.
#
# One stub exists for the rig's own tests, the same convention
# `lib/fullbench-instance.sh` already uses for `SWB_RUN_CMD` and `SWB_GRADE_CMD`:
#
#   SWB_RERUN_INSTANCE_CMD   replaces the per-instance pipeline: <cmd> <id>
#
# With it, `fixtures/check-run-45.mjs` drives the whole scheduler — concurrency,
# resume, the budget gate, `--stop`, `--limit` — with no docker and no tokens.
#
# This spends real API tokens — budget roughly the baseline's $37.84, less if the
# program's changes work. See README.md, "The re-run".
set -u
S="$(cd "$(dirname "$0")" && pwd)"
BASELINE="${SWB_RERUN_BASELINE:-$S/fullbench/manifest.jsonl}"

LANE="${SWB_RERUN_LANE:-r91}"
JOBS="${SWB_RERUN_JOBS:-3}"
SEAT="${SWB_SEAT:-openai:gpt-5.6-sol}"
# How the seat's provider authenticates. `api-key` bills OPENAI_API_KEY
# credits; `chatgpt` runs the same seat on the operator's ChatGPT plan through
# the codex CLI's session (CODEX_HOME names the store, `codex login` provisions
# it). The seat string, and so the committed price table, is identical either
# way — under `chatgpt` the ledger's dollars are DERIVED at API list prices,
# not billed, and the header row records the mode so the scoreboard can say so.
OPENAI_AUTH="${SWB_FLOWS_OPENAI_AUTH:-api-key}"
INSTANCE_BUDGET="${SWB_FULLBENCH_BUDGET:-1200}"
BUDGET_USD="${SWB_RERUN_BUDGET_USD:-60}"
MIN_FREE_MIB="${SWB_FULLBENCH_MIN_FREE_MIB:-8192}"
DATASET="${SWB_DATASET:-$S/swb-verified.json}"
MODEL_NAME="${SWB_MODEL_NAME:-flows-cell-harness}"
POLL_SECONDS="${SWB_RERUN_POLL_SECONDS:-5}"
SESSION_LIMIT=""
# The testbed container's network, validated here rather than at the first
# `docker run` so a typo costs no image pull. `none` is the default since
# 2026-08-24; a lane reproducing a measurement taken before that pins `bridge`,
# which is what those lanes ran under. `lib/testbed-network.sh` owns the rule.
TESTBED_NETWORK="$("$S/lib/testbed-network.sh" resolve)" || exit 2

for PAIR in "JOBS:$JOBS" "INSTANCE_BUDGET:$INSTANCE_BUDGET" "MIN_FREE_MIB:$MIN_FREE_MIB" \
  "POLL_SECONDS:$POLL_SECONDS"; do
  NAME="${PAIR%%:*}"; VALUE="${PAIR#*:}"
  case "$VALUE" in
    ''|*[!0-9]*|0) echo "run-45.sh: $NAME must be a positive integer, got '$VALUE'"; exit 2 ;;
  esac
done
case "$BUDGET_USD" in
  ''|*[!0-9.]*|*.*.*|.|*.) echo "run-45.sh: SWB_RERUN_BUDGET_USD must be a number, got '$BUDGET_USD'"; exit 2 ;;
esac
case "$OPENAI_AUTH" in
  api-key|chatgpt) ;;
  *) echo "run-45.sh: SWB_FLOWS_OPENAI_AUTH must be 'api-key' or 'chatgpt', got '$OPENAI_AUTH'"; exit 2 ;;
esac
MODE=start
FOREGROUND=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --foreground) FOREGROUND=1; shift ;;
    --list) MODE=list; shift ;;
    --status) MODE=status; shift ;;
    --stop) MODE=stop; shift ;;
    --limit) SESSION_LIMIT="${2:-}"; shift 2 || shift ;;
    --lane) LANE="${2:-}"; shift 2 || shift ;;
    *) echo "run-45.sh: unknown argument '$1'"; exit 2 ;;
  esac
done
if [ -n "$SESSION_LIMIT" ]; then
  case "$SESSION_LIMIT" in
    ''|*[!0-9]*) echo "run-45.sh: --limit must be a non-negative integer, got '$SESSION_LIMIT'"; exit 2 ;;
  esac
fi
# The lane names a directory and an evaluator run id, so it is spelled the way
# both can hold: a path component that is only ever itself.
case "$LANE" in
  ''|*[!A-Za-z0-9._-]*|.|..|-*)
    echo "run-45.sh: --lane must be a name of letters, digits, '.', '_' or '-', got '$LANE'"; exit 2 ;;
esac

# The three values the lane derives. Each is still overridable on its own, which
# is what lets `fixtures/check-run-45.mjs` point a whole lane at a temporary
# directory without inventing a lane name for it.
FB="${FB_DIR:-$S/fullbench/rerun-$LANE}"
INDEX="${SWB_RERUN_INDEX:-$LANE}"
RUN_ID="${SWB_RERUN_RUN_ID:-rerun-$LANE}"

MANIFEST="$FB/manifest.jsonl"
mkdir -p "$FB/patches" "$FB/journals" "$FB/timings" "$FB/logs" "$FB/reports" "$FB/workers" "$FB/claims"

now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
append() { node "$S/lib/manifest-append.mjs" "$1" "$2"; }
row() { node "$S/lib/fullbench-row.mjs" "$@"; }
queue() { node "$S/lib/rerun-queue.mjs" "$DATASET" "$BASELINE" "$MANIFEST" "$@"; }

if [ ! -f "$BASELINE" ]; then
  echo "run-45.sh: no baseline ledger at $BASELINE — the re-run takes its instances from it" >&2
  exit 1
fi

case "$MODE" in
  list) queue --remaining; exit 0 ;;
  status)
    set -- $(queue --count)
    printf '%s of %s instances re-run, %s left\n' "$1" "$3" "$2"
    exit 0 ;;
  stop)
    printf 'stop requested at %s\n' "$(date -u +%FT%TZ)" > "$FB/STOP"
    echo "run-45.sh: the driver will stop after its in-flight instances finish"
    exit 0 ;;
esac

# ---------------------------------------------------------------------------
# Refusals, before anything is spent.
# ---------------------------------------------------------------------------
# The index every artifact carries goes through `lib/run-paths.sh`, which
# accepts only `r<digits>[<lowercase tag>]`. A lane is allowed any path-safe
# name, so a lane like `jev1` derives an index run-paths refuses, and every
# worker would pull its image and then fail. Name the index instead:
# `SWB_RERUN_INDEX=r99jev ./run-45.sh --lane jev1`.
if ! [[ "$INDEX" =~ ^r[0-9]+[a-z]*$ ]]; then
  echo "run-45.sh: run index must match r<digits>[<lowercase tag>], got '$INDEX'." >&2
  echo "  Lane '$LANE' derives it; set SWB_RERUN_INDEX to one run-paths.sh accepts." >&2
  exit 2
fi
# The fullbench worker pulls an image before it calls run-instance.sh. Reject
# a broken explicit helper path here; otherwise the CLI resolves its packaged
# or checkout helper itself.
if [ -z "${SWB_RERUN_INSTANCE_CMD:-}" ] \
  && [ -n "${SMITHERS_WORKSPACE_JJ_EXPORT_BINARY:-}" ]; then
  if [ ! -x "$SMITHERS_WORKSPACE_JJ_EXPORT_BINARY" ]; then
    echo "run-45.sh: no executable workspace helper at $SMITHERS_WORKSPACE_JJ_EXPORT_BINARY" >&2
    exit 1
  fi
fi
# A stubbed pipeline starts no harness, so there is no subject for a pin to name.
if [ -z "${SWB_RERUN_INSTANCE_CMD:-}" ] && [ ! -f "$S/.subject.json" ]; then
  echo "run-45.sh: no pinned subject at $S/.subject.json — run ./preflight.sh first." >&2
  echo "  A wave measures the working tree, and an unpinned wave cannot say which one." >&2
  exit 1
fi
# Not in the detached child: the launcher below writes its pid into driver.pid
# before the child reaches this line, so the child would find itself running and
# refuse to be itself.
if [ "${SWB_RERUN_CHILD:-0}" != "1" ] \
  && [ -f "$FB/driver.pid" ] && kill -0 "$(cat "$FB/driver.pid")" 2>/dev/null; then
  echo "run-45.sh: a driver is already running as pid $(cat "$FB/driver.pid")." >&2
  echo "  ./run-45.sh --status to read it, ./run-45.sh --stop to end it." >&2
  exit 1
fi
rm -f "$FB/STOP"
if ! queue --count >/dev/null; then
  echo "run-45.sh: could not build the queue from $BASELINE" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Detach, unless asked not to. The subshell exits at once and the worker is
# reparented, so the re-run survives the session that started it — the same
# double fork `fullbench.sh` uses and for the same reason.
# ---------------------------------------------------------------------------
if [ "$FOREGROUND" != "1" ] && [ "${SWB_RERUN_CHILD:-0}" != "1" ]; then
  ( SWB_RERUN_CHILD=1 nohup "$0" --foreground --lane "$LANE" \
      ${SESSION_LIMIT:+--limit "$SESSION_LIMIT"} \
      >> "$FB/driver.log" 2>&1 < /dev/null & echo $! > "$FB/driver.pid" ) &
  sleep 1
  echo "run-45.sh: driver detached as pid $(cat "$FB/driver.pid" 2>/dev/null || printf '?')"
  echo "  log      $FB/driver.log"
  echo "  status   ./run-45.sh --lane $LANE --status"
  echo "  stop     ./run-45.sh --lane $LANE --stop"
  exit 0
fi
echo $$ > "$FB/driver.pid"

HEAD_AT_START="$(cd "$S" && git rev-parse HEAD 2>/dev/null || printf 'unknown')"
# `preflight.sh` writes the fingerprint under `stamp`; the other two spellings
# are read as well so a pin written by an older preflight still names itself.
SUBJECT="$(node -e '
  const pin = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  process.stdout.write(pin.stamp ?? pin.fingerprint ?? pin.subject ?? "unknown")
' "$S/.subject.json" 2>/dev/null || printf 'unknown')"

append "$MANIFEST" "$(row --kind header --at "$(now_ms)" --run-id "$RUN_ID" --index "$INDEX" \
  --lane "$LANE" --testbedNetwork "$TESTBED_NETWORK" \
  --subject "$SUBJECT" --head "$HEAD_AT_START" --seat "$SEAT" --openai-auth "$OPENAI_AUTH" --jobs "$JOBS" \
  --instance-budget-seconds "$INSTANCE_BUDGET" --budget-usd "$BUDGET_USD" \
  --min-free-mib "$MIN_FREE_MIB" --baseline "$BASELINE" --dataset "$DATASET")"

export FB_DIR="$FB"
export SWB_FULLBENCH_INDEX="$INDEX"
export SWB_FULLBENCH_RUN_ID="$RUN_ID"
export SWB_FULLBENCH_MIN_FREE_MIB="$MIN_FREE_MIB"
export SWB_FULLBENCH_BUDGET="$INSTANCE_BUDGET"
export SWB_MODEL_NAME="$MODEL_NAME"
export SWB_SEAT="$SEAT"
export SWB_FLOWS_OPENAI_AUTH="$OPENAI_AUTH"
# Handed down rather than left to default, for the same reason effort is: a
# condition a child derives is a condition that moves when the default moves.
export SWB_TESTBED_NETWORK="$TESTBED_NETWORK"
# Nothing is pinned: the baseline's five pinned images belong to the best-of-n
# matrix, and a re-run that kept 15 GB of images warm would sit in the disk gate
# instead of running.
export SWB_FULLBENCH_PINNED=""

QUEUE="$(queue --remaining)"
set -- $(queue --count)
log "run-45: $1 of $3 already re-run, $2 to go, $JOBS in flight, ${INSTANCE_BUDGET}s each, $TESTBED_NETWORK testbed, $OPENAI_AUTH auth"

# ---------------------------------------------------------------------------
# The budget gate, read from this re-run's own ledger before every launch. A
# read that fails is not zero: an unreadable ledger stops the driver rather than
# letting it spend blind.
# ---------------------------------------------------------------------------
spend_cents() {
  node "$S/fullbench-report.mjs" --spend-cents --manifest "$MANIFEST" 2>/dev/null
}
BUDGET_CENTS="$(node -e 'process.stdout.write(String(Math.round(Number(process.argv[1]) * 100)))' "$BUDGET_USD")"
case "$BUDGET_CENTS" in
  ''|*[!0-9]*) log "could not read \$$BUDGET_USD as a budget"; exit 2 ;;
esac

RUNNING=0
STOPPING=0
SCHEDULED=0
PIDS=()
NAMES=()

reap_finished() {
  REAPED=0
  INDEX_I=0
  while [ "$INDEX_I" -lt "${#PIDS[@]}" ]; do
    PID="${PIDS[$INDEX_I]}"
    NAME="${NAMES[$INDEX_I]}"
    if [ -n "$PID" ] && ! kill -0 "$PID" 2>/dev/null; then
      STATUS="$(cat "$FB/workers/$NAME.done" 2>/dev/null || printf '?')"
      log "$NAME finished (exit $STATUS)"
      if [ "$STATUS" != 0 ]; then
        log "PAUSED: $NAME did not reach a valid graded attempt"
        STOPPING=1
      fi
      PIDS[$INDEX_I]=""
      RUNNING=$((RUNNING - 1))
      REAPED=1
    fi
    INDEX_I=$((INDEX_I + 1))
  done
  [ "$REAPED" = "1" ]
}

# A driver that stopped says so in its own log, exactly once, wherever it
# noticed. A silent break reads as a finished run in `driver.log`.
note_stop() {
  if [ "$STOPPING" != "1" ]; then log "stop requested"; fi
  STOPPING=1
}

wait_for_slot() {
  while [ "$RUNNING" -ge "$JOBS" ]; do
    if [ -f "$FB/STOP" ]; then note_stop; return; fi
    if ! reap_finished; then sleep "$POLL_SECONDS"; fi
  done
}

for ID in $QUEUE; do
  if [ -f "$FB/STOP" ]; then note_stop; fi
  if [ "$STOPPING" = "1" ]; then break; fi
  if [ -n "$SESSION_LIMIT" ] && [ "$SCHEDULED" -ge "$SESSION_LIMIT" ]; then
    log "session limit of $SESSION_LIMIT reached; the rest stay queued"
    break
  fi

  # Wait for a slot before reading spend: the worker reaped while waiting may
  # have recorded the cost that crosses the budget.
  wait_for_slot
  if [ "$STOPPING" = "1" ]; then break; fi

  SPENT_CENTS="$(spend_cents)"
  if [ -z "$SPENT_CENTS" ]; then sleep 2; SPENT_CENTS="$(spend_cents)"; fi
  case "${SPENT_CENTS:-x}" in
    ''|*[!0-9]*)
      append "$MANIFEST" "$(row --kind note --at "$(now_ms)" --note paused \
        --reason "the ledger's cumulative cost could not be read, so the budget cannot be enforced")"
      log "PAUSED: the ledger's cumulative cost could not be read"
      STOPPING=1
      break ;;
  esac
  if [ "$SPENT_CENTS" -ge "$BUDGET_CENTS" ]; then
    append "$MANIFEST" "$(row --kind note --at "$(now_ms)" --note paused \
      --reason "cumulative API cost reached the \$$BUDGET_USD budget")"
    log "PAUSED: cumulative API cost reached the \$$BUDGET_USD budget"
    STOPPING=1
    break
  fi

  log "scheduling $ID"
  ( ${SWB_RERUN_INSTANCE_CMD:-"$S/lib/fullbench-instance.sh"} "$ID"
    echo $? > "$FB/workers/$ID.done" ) &
  PID=$!
  PIDS[${#PIDS[@]}]="$PID"
  NAMES[${#NAMES[@]}]="$ID"
  RUNNING=$((RUNNING + 1))
  SCHEDULED=$((SCHEDULED + 1))
done

log "draining $RUNNING in-flight instances"
while [ "$RUNNING" -gt 0 ]; do
  if ! reap_finished; then sleep "$POLL_SECONDS"; fi
done

set -- $(queue --count)
log "run-45: $1 of $3 re-run, $2 left"
if [ "$2" = "0" ]; then
  log "compare with: node compare-runs.mjs --rerun $MANIFEST --out $FB"
fi
exit 0
