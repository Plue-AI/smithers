#!/bin/bash
# Runs one harness over every instance in the seeded sample, in draw order.
#
#   run-sample.sh [flows|codex] [count] [timeout-seconds] [jobs]
#
# A codex wave reads SWB_CODEX_NETWORK (sealed by default; on also needs
# SWB_CODEX_UNCONFINED=allowed) and refuses a bad value before any instance.
#
# Instances run concurrently, `jobs` at a time (default 3). What bounds that
# number is disk, not CPU: every instance keeps a multi-GB extracted testbed for
# the whole wave, and the machine this rig was written on had 27 GB free. The
# extraction itself stays serialized by run-instance.sh's own lock — that is the
# disk-bandwidth spike, and five copies at once can fill the drive before any
# instance's cleanup runs. Overlapping the *agent* runs is what this buys: they
# are network- and model-bound, and wave 2 spent 43 minutes of instance time
# waiting for one instance at a time.
#
# Pass jobs=1 to restore the old strictly-sequential behaviour, which is worth
# doing when a wave is being timed for per-instance wall clock: concurrent runs
# share the host's CPU and docker's 16 GB VM, so an instance's own seconds are
# comparable across a wave but not directly against a sequential baseline.
set -u
S="$(cd "$(dirname "$0")" && pwd)"
HARNESS="${1:-flows}"
COUNT="${2:-5}"
BUDGET="${3:-}"
JOBS="${4:-3}"

case "$JOBS" in
  ''|*[!0-9]*|0) echo "jobs must be a positive integer"; exit 2 ;;
esac
# A codex wave checks its network condition once, before any instance runs.
# See lib/codex-network.sh.
if [ "$HARNESS" = "codex" ]; then
  "$S/lib/codex-network.sh" run-sample.sh >/dev/null || exit 2
fi

if [ ! -f "$S/sample.json" ]; then
  echo "no sample at $S/sample.json — run ./bootstrap.sh first"; exit 1
fi

# A flows wave measures the working tree — the CLI's dependencies are loaded
# from `packages/*/src`, not from a build — so it must pin what it measures
# before the first instance and stop if that moves. See README, "The subject
# under test".
if [ "$HARNESS" = "flows" ] && [ ! -f "$S/.subject.json" ]; then
  echo "no subject pinned — run ./preflight.sh first"; exit 1
fi

IDS="$(node -e '
const fs=require("fs");
const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
process.stdout.write(s.instances.slice(0,Number(process.argv[2])).join(" "));
' "$S/sample.json" "$COUNT")"

# Validate every instance up front. A bad id should stop the wave before it
# spends anything, not after three instances have already run.
for ID in $IDS; do
  node "$S/lib/validate-instance.mjs" "${SWB_DATASET:-$S/swb-verified.json}" "$ID" >/dev/null || exit $?
done

mkdir -p "$S/logs-agent" "$S/logs-codex"

run_one() {
  ID="$1"
  if [ "$HARNESS" = "codex" ]; then
    "$S/run-instance-codex.sh" "$ID" ${BUDGET:+"$BUDGET"}
  else
    "$S/run-instance.sh" "$ID" "${SWB_SEAT:-openai:gpt-6-sol}" ${BUDGET:+"$BUDGET"}
  fi
}

STATUS=0
RUNNING=0
declare -a PIDS=()
declare -a NAMES=()

for ID in $IDS; do
  run_one "$ID" &
  PIDS+=("$!")
  NAMES+=("$ID")
  RUNNING=$((RUNNING + 1))
  if [ "$RUNNING" -ge "$JOBS" ]; then
    # Reap the oldest still-tracked child before admitting another. Waiting on
    # the specific pid keeps each instance's exit status attributable, which
    # `wait -n` alone does not.
    for i in "${!PIDS[@]}"; do
      if [ -n "${PIDS[$i]}" ]; then
        wait "${PIDS[$i]}" || { STATUS=$?; echo "[${NAMES[$i]}] exit $STATUS"; }
        PIDS[$i]=""
        RUNNING=$((RUNNING - 1))
        break
      fi
    done
  fi
done

for i in "${!PIDS[@]}"; do
  if [ -n "${PIDS[$i]}" ]; then
    wait "${PIDS[$i]}" || { STATUS=$?; echo "[${NAMES[$i]}] exit $STATUS"; }
  fi
done

exit "$STATUS"
