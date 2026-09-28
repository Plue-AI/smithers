#!/bin/bash
# Runs one harness n times over every instance in the seeded sample.
#
#   run-matrix.sh [flows|codex] [count-per-instance] [jobs] [timeout-seconds]
#
# A codex matrix reads SWB_CODEX_NETWORK (sealed by default; on also needs
# SWB_CODEX_UNCONFINED=allowed) and refuses a bad value before the first run.
#
# `count-per-instance` attempts of each of the sample's first `SWB_SAMPLE_COUNT`
# instances (5 by default), scheduled `jobs` at a time. `run-matrix.sh flows 5 3`
# is the best-of-5 wave: 25 runs, three of them in flight.
#
# Two rules the scheduler enforces, and one it does not:
#
# - **No two simultaneous runs of the same instance.** They would share one
#   docker image and one image cache, so the second would report a warm pull the
#   first paid for, and — the reason that matters — every live run of an instance
#   keeps an extracted testbed on disk. Interleaving instances bounds the
#   resident set at `jobs` testbeds instead of `count` of the largest one. The
#   schedule is therefore round-major: every instance's r1, then every
#   instance's r2, and a run waits for its own instance's previous attempt.
# - **`jobs` runs in flight, no more.** Same bound `run-sample.sh` applies, for
#   the same reason: the extraction itself is serialized by `run-instance.sh`'s
#   own lock, and what concurrency buys is overlapping the model-bound agent
#   runs.
# - It does **not** stop on a failing run. One instance that times out is a
#   result the matrix is measuring; the manifest records its exit status and the
#   wave continues.
#
# Writes `matrix-<harness>.json`, the manifest the report generator reads: one
# row per run with its id, instance, index, exit status, patch bytes and wall
# clock. `SWB_MATRIX_OUT` overrides the path.
#
# `SWB_RUN_CMD` replaces the per-run command, which is how `fixtures/check-
# matrix.mjs` exercises this scheduler with no docker, no model and no tokens.
# It is called exactly as the real script is: `<cmd> <instance> <a> <b> <index>`.
#
# This spends real API tokens and needs docker. See README.md, "Best-of-n".
set -u
S="$(cd "$(dirname "$0")" && pwd)"
HARNESS="${1:-flows}"
COUNT="${2:-5}"
JOBS="${3:-3}"
BUDGET="${4:-}"
SAMPLE_COUNT="${SWB_SAMPLE_COUNT:-5}"

case "$HARNESS" in
  flows|codex) ;;
  *) echo "harness must be flows or codex"; exit 2 ;;
esac
case "$COUNT" in
  ''|*[!0-9]*|0) echo "count-per-instance must be a positive integer"; exit 2 ;;
esac
case "$JOBS" in
  ''|*[!0-9]*|0) echo "jobs must be a positive integer"; exit 2 ;;
esac
case "$SAMPLE_COUNT" in
  ''|*[!0-9]*|0) echo "SWB_SAMPLE_COUNT must be a positive integer"; exit 2 ;;
esac
# The matrix does not stop on a failing run, so a bad codex network condition
# would record every run as a failure. Check it once, before the first run.
if [ "$HARNESS" = "codex" ]; then
  "$S/lib/codex-network.sh" run-matrix.sh >/dev/null || exit 2
fi

SAMPLE="${SWB_SAMPLE:-$S/sample.json}"
if [ ! -f "$SAMPLE" ]; then
  echo "no sample at $SAMPLE — run ./bootstrap.sh first"; exit 1
fi

# A flows wave measures the working tree, so it must pin what it measures before
# the first run and stop if that moves. See README, "The subject under test".
# A stubbed run command runs no harness and spends nothing, so it has no subject
# to pin and the refusal would only stop the scheduler's own tests.
if [ "$HARNESS" = "flows" ] && [ -z "${SWB_RUN_CMD:-}" ] && [ ! -f "$S/.subject.json" ]; then
  echo "no subject pinned — run ./preflight.sh first"; exit 1
fi

IDS="$(node -e '
const fs=require("fs");
const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
process.stdout.write(s.instances.slice(0,Number(process.argv[2])).join(" "));
' "$SAMPLE" "$SAMPLE_COUNT")"

# Validate every instance up front. A bad id should stop the matrix before it
# spends anything, not after three runs have already gone through.
for ID in $IDS; do
  node "$S/lib/validate-instance.mjs" "${SWB_DATASET:-$S/swb-verified.json}" "$ID" >/dev/null || exit $?
done

OUT="${SWB_MATRIX_OUT:-$S/matrix-$HARNESS.json}"
ROWS="$(mktemp -d "${TMPDIR:-/tmp}/swb-matrix-XXXXXX")"
mkdir -p "$S/logs-agent" "$S/logs-codex"
MATRIX_STARTED=$(date +%s)

# One run, and the row it contributes to the manifest. The row is written by the
# child, into its own file, so concurrent runs never interleave a write.
run_one() {
  ID="$1"; INDEX="$2"
  RUN_PATHS="$("$S/lib/run-paths.sh" "$HARNESS" "$ID" "$INDEX")" || return $?
  eval "$RUN_PATHS"
  START=$(date +%s)
  if [ -n "${SWB_RUN_CMD:-}" ]; then
    "$SWB_RUN_CMD" "$ID" "${BUDGET:-}" "" "$INDEX"
  elif [ "$HARNESS" = "codex" ]; then
    "$S/run-instance-codex.sh" "$ID" "${BUDGET:-1500}" "${SWB_CODEX_MODEL:-gpt-6-sol}" "$INDEX"
  else
    "$S/run-instance.sh" "$ID" "${SWB_SEAT:-openai:gpt-6-sol}" "${BUDGET:-1200}" "$INDEX"
  fi
  CODE=$?
  END=$(date +%s)
  BYTES=0
  if [ -f "$PATCH" ]; then BYTES=$(wc -c < "$PATCH" | tr -d ' '); fi
  printf '{"runId":"%s","harness":"%s","instance":"%s","index":"%s","exit":%s,"patchBytes":%s,"startedAt":%s,"endedAt":%s,"wallClockSeconds":%s}\n' \
    "$RUN_ID" "$HARNESS" "$ID" "$RUN_INDEX" "$CODE" "$BYTES" "$((START*1000))" "$((END*1000))" "$((END-START))" \
    > "$ROWS/$RUN_ID.json"
  return $CODE
}

# Round-major schedule with two waits per launch: one on the instance's own
# previous attempt, one on the oldest still-running child once `jobs` are in
# flight. Waiting on a specific pid rather than on `wait -n` is what keeps each
# run's exit status attributable to its run id.
#
# Indexed arrays only, and one parallel array per instance ordinal rather than a
# map from instance to pid: the rig runs on the bash macOS ships, which is 3.2
# and has no associative arrays.
STATUS=0
RUNNING=0
PIDS=()
NAMES=()
IDLIST=()
PREVIOUS_PID=()
for ID in $IDS; do
  IDLIST[${#IDLIST[@]}]="$ID"
  PREVIOUS_PID[${#PREVIOUS_PID[@]}]=""
done

# Reaps the oldest still-tracked child, recording its exit under its run id.
reap_one() {
  for i in "${!PIDS[@]}"; do
    if [ -n "${PIDS[$i]}" ]; then
      wait "${PIDS[$i]}" || { STATUS=$?; echo "[${NAMES[$i]}] exit $STATUS"; }
      PIDS[$i]=""
      RUNNING=$((RUNNING - 1))
      return 0
    fi
  done
  return 1
}

# Reaps one specific child, if it is still tracked. Used for the same-instance
# wait, where the pid is chosen by which instance is being launched rather than
# by age.
reap_pid() {
  for i in "${!PIDS[@]}"; do
    if [ "${PIDS[$i]}" = "$1" ]; then
      wait "$1" || { STATUS=$?; echo "[${NAMES[$i]}] exit $STATUS"; }
      PIDS[$i]=""
      RUNNING=$((RUNNING - 1))
      return 0
    fi
  done
  return 1
}

for ROUND in $(seq 1 "$COUNT"); do
  for i in "${!IDLIST[@]}"; do
    ID="${IDLIST[$i]}"
    # The same instance never has two runs in flight: they would share an image
    # cache and, more importantly, two extracted testbeds.
    if [ -n "${PREVIOUS_PID[$i]}" ]; then reap_pid "${PREVIOUS_PID[$i]}" || true; fi
    while [ "$RUNNING" -ge "$JOBS" ]; do reap_one || break; done
    run_one "$ID" "r$ROUND" &
    PID=$!
    PIDS[${#PIDS[@]}]="$PID"
    NAMES[${#NAMES[@]}]="$ID-r$ROUND"
    PREVIOUS_PID[$i]="$PID"
    RUNNING=$((RUNNING + 1))
  done
done

while [ "$RUNNING" -gt 0 ]; do reap_one || break; done

MATRIX_ENDED=$(date +%s)
node -e '
const fs = require("fs")
const [, rowsDir, out, harness, count, jobs, ids, started, ended] = process.argv
const rows = fs.readdirSync(rowsDir).filter((name) => name.endsWith(".json")).sort()
  .map((name) => JSON.parse(fs.readFileSync(`${rowsDir}/${name}`, "utf8")))
// Sorted by instance then index so the manifest reads as the matrix it is,
// whatever order the scheduler finished the runs in.
rows.sort((a, b) =>
  a.instance === b.instance
    ? Number(a.index.slice(1)) - Number(b.index.slice(1))
    : a.instance < b.instance ? -1 : 1
)
fs.writeFileSync(out, `${JSON.stringify({
  harness,
  countPerInstance: Number(count),
  jobs: Number(jobs),
  instances: ids.split(" ").filter((id) => id !== ""),
  startedAt: Number(started) * 1000,
  endedAt: Number(ended) * 1000,
  runs: rows
}, null, 2)}\n`)
console.log(`run-matrix.sh: ${rows.length} runs recorded in ${out}`)
' "$ROWS" "$OUT" "$HARNESS" "$COUNT" "$JOBS" "$IDS" "$MATRIX_STARTED" "$MATRIX_ENDED" || {
  echo "run-matrix.sh: could not write the manifest"; rm -rf "$ROWS"; exit 1; }
rm -rf "$ROWS"

exit "$STATUS"
