#!/bin/bash
# Proves the codex backfill without spending a token.
#
#   ./codex-backfill-dryrun.sh
#
# `fixtures/check-codex-backfill.mjs` replays the queue and the ledger offline.
# What it cannot replay is the part that only exists when processes are real:
# the two-slot semaphore under three concurrent `--one` invocations, a real
# `docker pull` and `docker rmi`, and — the one that matters most — one of those
# invocations being killed with `-9` halfway through and the next one picking its
# instance back up.
#
# So this runs the real script, with the real ledger, the real disk gate and real
# docker, over five instances that are in no dataset. The agent is stubbed
# (`SWB_CODEX_RUN_CMD`), the evaluator is stubbed (`SWB_GRADE_CMD`) and the auth
# check is stubbed (`SWB_CODEX_AUTH_CMD`); everything between them is the code
# the backfill runs.
#
# Seven phases:
#
#   A  a logged-out rig: the auth check fails loudly and nothing is claimed,
#      pulled or written
#   B  three `--one` invocations at once: two run, the third waits for a slot,
#      and the ledger never shows three in flight
#   C  `kill -9` on one invocation mid-instance leaves a `started` row with no
#      verdict — the row that says how far it got and that it is still owed
#   D  the next invocation of that id runs it again from the top and reaches a
#      verdict; an id that already has one is a no-op that touches no docker
#   E  a disk gate that cannot be satisfied logs its wait and fails the instance
#      rather than pulling into a full disk
#   F  the failed instance is retried, and the report its dead attempt left
#      behind is deleted rather than read: the official evaluator skips an
#      instance that already has one, so inheriting it would file a verdict for
#      a patch that attempt never produced
#   G  an id the full benchmark never graded is refused; a bare backfill works
#      its way through what is left; and one with nothing left says so and
#      exits 0
#
# Real docker, three tiny images: `busybox` is pulled and deleted, `hello-world`
# is pulled and deleted, and `alpine` stands in for a pinned instance's image and
# is still here at the end.
#
# Spends no model tokens. Needs docker and about 10 MB of pulls.
set -eu
S="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/flows-codex-backfill-dryrun-XXXXXX")"
FB="$TMP/fullbench"
FBC="$FB/codex"
LEDGER="$TMP/ledger.txt"
ONE=stubcodex__one
TWO=stubcodex__two
THREE=stubcodex__three
FOUR=stubcodex__four
FIVE=stubcodex__five
ABSENT=stubcodex__absent
IDS="$ONE $TWO $THREE $FOUR $FIVE $ABSENT"
# The invocations this dry run put in the background. Cleanup kills these, the
# pids recorded under $TMP and their descendants — never a process another
# invocation started (lib/owned-processes.sh).
OWNED=""
. "$S/lib/owned-processes.sh"

cleanup() {
  # shellcheck disable=SC2086 # OWNED is a list of pids
  kill_owned "$TMP" $OWNED
  for ID in $IDS; do
    rm -rf "$S/work-codex/${ID}-r90c"
    rm -f "$S/patches-codex/${ID}-r90c.patch" "$S/patches-codex/${ID}-r90c.patch.untracked" \
      "$S/timings-codex/${ID}-r90c.json" "$S/logs-codex/${ID}-r90c".*
  done
  docker rmi -f busybox:latest hello-world:latest >/dev/null 2>&1 || true
  if [ "${SWB_DRYRUN_KEEP:-0}" = "1" ]; then
    echo "dryrun: artifacts kept in $TMP"
  else
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT

# alpine is the disk probe's image and this dry run's stand-in for a pinned
# benchmark image. Without it the "kept" assertion would be vacuous.
if ! docker image inspect alpine:latest >/dev/null 2>&1; then
  docker pull alpine:latest >/dev/null 2>&1 || { echo "dryrun: could not pull alpine"; exit 1; }
fi
docker rmi -f busybox:latest hello-world:latest >/dev/null 2>&1 || true

mkdir -p "$FB" "$TMP/eval-logs"

# The full benchmark's ledger, as the backfill reads it: four instances graded,
# one of them on a grading our own evaluator could not complete. That last one is
# in the population and carries a flag, because dropping it would leave the two
# harnesses measured over different sets of instances.
node -e '
  const { writeFileSync } = require("fs")
  const [, out, one, two, three, four, five] = process.argv
  const at = Date.now()
  const rows = [
    { kind: "header", at, runId: "fullbench", index: "r90" },
    { kind: "instance", id: one, state: "cleaned", at, verdict: "resolved" },
    { kind: "instance", id: two, state: "cleaned", at, verdict: "unresolved" },
    { kind: "instance", id: three, state: "graded", at, verdict: "resolved" },
    { kind: "instance", id: four, state: "cleaned", at, verdict: "eval error" },
    // Never named by a `--one`: it is what the bare `./codex-backfill.sh` loop
    // has left to do, so that loop is exercised over a real instance rather than
    // over an empty queue.
    { kind: "instance", id: five, state: "cleaned", at, verdict: "resolved" },
    // Not graded, so not in the population at all: the backfill compares one
    // codex attempt against one flows attempt, and there is no flows attempt here.
    { kind: "instance", id: "stubcodex__pulledonly", state: "pulled", at }
  ]
  writeFileSync(out, rows.map((row) => JSON.stringify(row)).join("\n") + "\n")
' "$FB/manifest.jsonl" "$ONE" "$TWO" "$THREE" "$FOUR" "$FIVE"

# The pinned instance, read the way the script reads it: the sample's head.
printf '{"seed":0,"size":1,"instances":["%s"]}\n' "$THREE" > "$TMP/sample.json"

node -e '
  const { writeFileSync } = require("fs")
  const [, out, one, two, three, four, five] = process.argv
  writeFileSync(out, JSON.stringify({
    [one]: "busybox:latest",
    [two]: "hello-world:latest",
    [three]: "alpine:latest",
    [four]: "busybox:latest",
    [five]: "busybox:latest"
  }, null, 2))
' "$TMP/images.json" "$ONE" "$TWO" "$THREE" "$FOUR" "$FIVE"

# ---------------------------------------------------------------------------
# The stubs
# ---------------------------------------------------------------------------
cat > "$TMP/codex-dryrun-run.sh" <<EOF
#!/bin/bash
# The stub agent: everything run-instance-codex.sh leaves behind, and none of
# the model calls. The transcript carries the CLI's own token footer, so the
# ledger's token column is read the way it is read from a real run.
set -u
ID="\$1"
INDEX="\$4"
eval "\$("$S/lib/run-paths.sh" codex "\$ID" "\$INDEX")"
printf 'S %s\n' "\$ID" >> "$LEDGER"
mkdir -p "\$WORK" "\$PATCH_ROOT" "\$TIMINGS_ROOT" "\$LOG_ROOT"
# A rendezvous between the first two instances, so "two at once" is proved by
# construction rather than by two stubs happening to overlap. A one-slot
# semaphore would leave the first one waiting here until it timed out, and the
# timeout is a line in the ledger the assertions fail on.
if [ "\$ID" = "$ONE" ] || [ "\$ID" = "$TWO" ]; then
  mkdir -p "$TMP/rendezvous"
  : > "$TMP/rendezvous/\$ID"
  WAITED=0
  until [ -f "$TMP/rendezvous/$ONE" ] && [ -f "$TMP/rendezvous/$TWO" ]; do
    sleep 1
    WAITED=\$((WAITED + 1))
    if [ "\$WAITED" -ge 60 ]; then printf 'T %s\n' "\$ID" >> "$LEDGER"; break; fi
  done
fi
if [ "\$ID" = "$TWO" ]; then
  : > "\$PATCH"
elif [ -f "$TMP/no-patch-\$ID" ]; then
  rm -f "\$PATCH"
else
  printf 'diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@\n-old\n+new\n' > "\$PATCH"
fi
: > "\$PATCH.untracked"
{
  printf 'OpenAI Codex v0.149.0\n--------\nworkdir: %s\nmodel: %s\n--------\n' "\$WORK" "\$3"
  printf 'codex\nI will reproduce the problem, then fix it.\n'
  printf 'exec\n/bin/zsh -lc %s in %s\n succeeded in 52ms:\nstub output\n\n' "'ls'" "\$WORK"
  printf 'tokens used\n12,345\n'
} > "\$LOG_PREFIX.run.log"
printf 'stub last message\n' > "\$LOG_PREFIX.last-message.txt"
printf '{"instance_id":"%s","run_id":"%s","wallClockSeconds":7}\n' "\$ID" "\$RUN_ID" > "\$TIMINGS"
SLEEP=0
if [ -f "$TMP/sleep-\$ID" ]; then SLEEP="\$(cat "$TMP/sleep-\$ID")"; fi
sleep "\$SLEEP"
printf 'E %s\n' "\$ID" >> "$LEDGER"
exit 0
EOF
chmod +x "$TMP/codex-dryrun-run.sh"

cat > "$TMP/codex-dryrun-grade.sh" <<EOF
#!/bin/bash
# The stub evaluator: writes the report where the real one writes it, so the
# script's verdict reading is the real code path.
set -u
RUN_ID="\$1"
ID="\$2"
DIR="$TMP/eval-logs/\$RUN_ID/codex-cli/\$ID"
printf 'G %s\n' "\$ID" >> "$LEDGER"
# The official evaluator skips an instance that already has a report under this
# run id and writes nothing for it. \`$TMP/skip-grade-<id>\` makes this stub do
# the same, which is how the rig proves that a retry deletes the dead attempt's
# report instead of reading its verdict back.
if [ -f "$TMP/skip-grade-\$ID" ]; then exit 0; fi
mkdir -p "\$DIR"
RESOLVED=false
if [ "\$ID" = "$ONE" ] || [ "\$ID" = "$THREE" ]; then RESOLVED=true; fi
printf '{"%s": {"patch_exists": true, "patch_successfully_applied": true, "resolved": %s}}\n' \
  "\$ID" "\$RESOLVED" > "\$DIR/report.json"
EOF
chmod +x "$TMP/codex-dryrun-grade.sh"

printf '#!/bin/bash\nexit 0\n' > "$TMP/auth-ok.sh"
printf '#!/bin/bash\nexit 1\n' > "$TMP/auth-fail.sh"
chmod +x "$TMP/auth-ok.sh" "$TMP/auth-fail.sh"

export FB_DIR="$FB"
export SWB_SAMPLE="$TMP/sample.json"
export SWB_IMAGE_MAP="$TMP/images.json"
export SWB_CODEX_RUN_CMD="$TMP/codex-dryrun-run.sh"
export SWB_GRADE_CMD="$TMP/codex-dryrun-grade.sh"
export SWB_CODEX_AUTH_CMD="$TMP/auth-ok.sh"
export SWB_EVAL_LOG_ROOT="$TMP/eval-logs"
export SWB_CODEX_BACKFILL_SLOT_POLL=1
export SWB_CODEX_BACKFILL_DISK_INTERVAL=1

wait_for_ledger() {
  WAITED=0
  until grep -qx "$1" "$LEDGER" 2>/dev/null; do
    WAITED=$((WAITED + 1))
    if [ "$WAITED" -ge 180 ]; then
      echo "dryrun: timed out waiting for ledger line: $1"
      cat "$TMP"/*.log 2>/dev/null || true
      exit 1
    fi
    sleep 1
  done
}

echo "== phase A: a logged-out rig"
set +e
SWB_CODEX_AUTH_CMD="$TMP/auth-fail.sh" "$S/codex-backfill.sh" --one "$ONE" \
  > "$TMP/phase-a.log" 2>&1
echo $? > "$TMP/phase-a.exit"
set -e
cp "$FB/codex-manifest.jsonl" "$TMP/manifest-after-auth-failure.jsonl" 2>/dev/null \
  || : > "$TMP/manifest-after-auth-failure.jsonl"

echo "== phase B: three at once, two slots"
printf '3\n' > "$TMP/sleep-$ONE"
printf '60\n' > "$TMP/sleep-$TWO"
printf '30\n' > "$TMP/sleep-$THREE"
# The first two are launched together and meet at the rendezvous inside the stub,
# which is what proves the semaphore really runs two. The third is launched only
# once both are known to be inside their instances, so "the third waits" is a
# fact about the semaphore rather than about which invocation won a race.
"$S/codex-backfill.sh" --one "$ONE" > "$TMP/phase-b-one.log" 2>&1 &
OWNED="$OWNED $!"
"$S/codex-backfill.sh" --one "$TWO" > "$TMP/phase-b-two.log" 2>&1 &
OWNED="$OWNED $!"
wait_for_ledger "S $ONE"
wait_for_ledger "S $TWO"
"$S/codex-backfill.sh" --one "$THREE" > "$TMP/phase-b-three.log" 2>&1 &
THREE_PID=$!
OWNED="$OWNED $THREE_PID"

echo "== phase C: kill -9 the third, mid-instance"
# Its start cannot happen until the first instance releases a slot, so the
# ledger's order is the proof — and the kill has to land while it is *running*,
# not while it waits.
wait_for_ledger "S $THREE"
# While the second instance is still in flight, a second invocation naming it
# must refuse rather than queue behind it: two paid agents writing one patch path
# is the thing the claim exists to stop, and it is checked before any slot is
# taken so a refusal costs nothing.
set +e
"$S/codex-backfill.sh" --one "$TWO" > "$TMP/phase-c-double.log" 2>&1
echo $? > "$TMP/phase-c-double.exit"
set -e
# That invocation and everything under it, collected before the signal; nothing
# another invocation started.
# shellcheck disable=SC2046 # one pid per word
kill -9 $(tree_pids "$THREE_PID") 2>/dev/null || true
sleep 2
cp "$FB/codex-manifest.jsonl" "$TMP/manifest-after-kill.jsonl"
"$S/codex-backfill.sh" --list > "$TMP/remaining-after-kill.txt"
wait_for_ledger "E $TWO"
wait || true

echo "== phase D: the killed instance runs again; a paid one does not"
printf '0\n' > "$TMP/sleep-$THREE"
"$S/codex-backfill.sh" --one "$THREE" > "$TMP/phase-d-three.log" 2>&1
set +e
"$S/codex-backfill.sh" --one "$ONE" > "$TMP/phase-d-one.log" 2>&1
echo $? > "$TMP/phase-d-one.exit"
set -e

echo "== phase E: the disk gate, made to fail"
set +e
SWB_DISK_FREE_MIB=1000 SWB_CODEX_BACKFILL_MIN_FREE_MIB=8192 \
  SWB_CODEX_BACKFILL_DISK_WAIT_MAX=1 \
  "$S/codex-backfill.sh" --one "$FOUR" > "$TMP/phase-e.log" 2>&1
echo $? > "$TMP/phase-e.exit"
set -e
{
  docker image inspect busybox:latest >/dev/null 2>&1 \
    && echo "busybox present" || echo "busybox absent"
} > "$TMP/images-after-disk-gate.txt"

echo "== phase F: the failed instance is retried, and a stale report is not inherited"
mkdir -p "$TMP/eval-logs/fullbench-codex/codex-cli/$FOUR"
printf '{"%s": {"patch_exists": true, "patch_successfully_applied": true, "resolved": true}}\n' \
  "$FOUR" > "$TMP/eval-logs/fullbench-codex/codex-cli/$FOUR/report.json"
: > "$TMP/skip-grade-$FOUR"
printf '0\n' > "$TMP/sleep-$FOUR"
"$S/codex-backfill.sh" --one "$FOUR" > "$TMP/phase-f.log" 2>&1

echo "== phase G: refusals, the bare loop, and an empty queue"
set +e
"$S/codex-backfill.sh" --one "$ABSENT" > "$TMP/phase-g-absent.log" 2>&1
echo $? > "$TMP/phase-g-absent.exit"
"$S/codex-backfill.sh" --one stubcodex__pulledonly > "$TMP/phase-g-pulled.log" 2>&1
echo $? > "$TMP/phase-g-pulled.exit"
# The bare loop, over the one instance no `--one` ever named.
"$S/codex-backfill.sh" > "$TMP/phase-g-loop.log" 2>&1
echo $? > "$TMP/phase-g-loop.exit"
"$S/codex-backfill.sh" > "$TMP/phase-g-all.log" 2>&1
echo $? > "$TMP/phase-g-all.exit"
set -e
"$S/codex-backfill.sh" --status > "$TMP/status.txt" 2>&1
"$S/codex-backfill.sh" --table > "$TMP/table.txt" 2>&1

echo "== assertions"
{
  docker image inspect busybox:latest >/dev/null 2>&1 && echo "busybox present" || echo "busybox absent"
  docker image inspect hello-world:latest >/dev/null 2>&1 && echo "hello-world present" || echo "hello-world absent"
  docker image inspect alpine:latest >/dev/null 2>&1 && echo "alpine present" || echo "alpine absent"
} > "$TMP/images-final.txt"

node "$S/fixtures/check-codex-backfill.mjs" "$TMP"
