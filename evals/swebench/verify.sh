#!/bin/bash
# Verifies the scorecard generator and instance guidance without model calls.
#
#   pnpm exec smthrs test //evals/swebench:offline
#   pnpm exec smthrs run //evals/swebench:prerequisites
#
# Builds the fixture journal twice — without and with the harness's exact
# `ModelSettled.durationMillis` field — scores both, and asserts every reported
# number against `fixtures/mirror-results.json` and the committed codex baseline.
# Then replays the rig's instance guidance and its patch capture over throwaway
# git repositories shaped like the official images, checks that the subject
# fingerprint still names the bytes the CLI actually loads, and replays the
# read-only liveness checker over synthesised journals.
#
# It also pins the two harnesses to one prompt: everything one side is taught and
# the other is not is a variable the comparison does not control.
#
# The best-of-n half is checked the same way: the per-run naming rule, the matrix
# scheduler over a stub harness command, the journal-only selector over two real
# waves, and the report generator over recorded evaluator verdicts.
#
# So is the full benchmark's half that does not need processes: the manifest's
# fold, the resume boundary, and the scoreboard. The half that does —
# pull, extract, delete, kill, resume — is `./fullbench-dryrun.sh`, which needs
# docker and is not run here. The codex backfill splits the same way:
# `./codex-backfill-dryrun.sh` is its process half.
#
# The sealed testbed splits the same way again. The condition, the ledger field
# and the assertion the scoreboard makes out of them are checked here; whether a
# `--network none` container can be `docker exec`-ed into at all, and whether the
# preflight tells an egress-dependent suite from a pre-existing failure, is
# `./network-dryrun.sh`.
#
# The plue transport (`SWB_TRANSPORT=plue`) is checked here against a fake
# `smithers` CLI whose guest is a temporary directory: the workspace lifecycle
# and its ledger slot, the sealed-network readback, the in-guest patch capture,
# the evaluator's container, and `lib/grade.py`'s wiring of it.
#
# The codex arm's lanes are checked here too, because a lane is a claim about
# how a number may be quoted: each one reads its own ledger, no two share an
# archive, an index or an evaluator run id, and the table in the script is the
# table in the README. So is the report that reads the two lanes against each
# other — an `eval error` is never counted as a verdict the seal changed, and
# the seal's own evidence is counted off the transcripts rather than assumed.
#
# The analysis bundle is checked here in full, and the check that matters most is
# what it refuses to print: the gold patch, the graded test file, the
# FAIL_TO_PASS and PASS_TO_PASS identifiers and the maintainer hints are each a
# sentinel in the fixture's dataset row and none may appear in the output. An
# analyst who is handed the answer is not designing a trace a real run could
# follow.
#
# The lock every lane in the rig shares is checked here too — mutual exclusion,
# recovery from a holder killed with -9, and the ownership rule that stops one
# lane freeing another's lock — because a defect there is silent until two
# multi-gigabyte extractions are already running on one disk.
#
# The grader's two rewrites of the official evaluator are checked as well: what
# `SWB_EVAL_EXPORTS` puts inside `eval.sh` and where, and the scoped image
# cleanup that stops one grading deleting another grading's image — the defect
# that produced every r90 `eval error`. So is the re-run: the population it takes
# from the baseline ledger, its scheduler over a stub pipeline, the lane that
# names one whole measurement, and the baseline-vs-re-run comparison.
#
# A programme that has been measured twice needs a third column and a second
# evidence reader, and both are checked here for the same reason the first ones
# were: a miscount in either would be invisible in a report and would read as
# data. `check-three-way.mjs` pins the difference between recovering a verdict
# and gaining one; `check-surgery-evidence.mjs` pins the difference between
# using a stated fact and hunting for it; `check-round3-evidence.mjs` pins the
# difference between a run told its proof was vacuous and a run that then did
# something about it, and between a retry ladder that recovered and one that
# did not; `check-repl-evidence.mjs` pins the difference between a name a realm
# carried across frames and a name that merely appears in two cells, and between
# a call re-issued inside one frame and one re-issued across two;
# `check-prompt-bytes.mjs` pins that an unstated fact is never reported as a
# stated one.
#
# Spends no tokens, needs no docker, needs no dataset. Run it after touching
# scorecard.ts, prices.ts, the journal's event shapes, patch capture,
# flows.sh, run-instance.sh, lib/subject.mjs, lib/check-liveness.mjs, lib/write-flow.mjs,
# lib/write-prompt-codex.mjs, lib/run-paths.sh, lib/make-preds.mjs, evaluate.sh, lib/lock.sh,
# lib/journal-facts.mjs, select-candidate.mjs, run-matrix.sh, matrix-report.mjs,
# fullbench.sh, fullbench-report.mjs, lib/grade.py, lib/httpbin.sh, lib/plue.py,
# lib/transport.sh, ../harbor/plue_env.py, ../harbor/plue_docker.py,
# lib/rerun-queue.mjs, run-45.sh, compare-runs.mjs, three-way.mjs, regrade.sh,
# lib/program-evidence.mjs, lib/surgery-evidence.mjs, lib/round3-evidence.mjs,
# lib/repl-evidence.mjs, lib/excluded.mjs or
# anything under lib/fullbench-*. The subject and evaluator checks run separately
# through //evals/swebench:prerequisites after ./preflight.sh and ./bootstrap.sh.
set -eu
S="$(cd "$(dirname "$0")" && pwd)"

# The CI tier is self-contained after the workspace install. Operator checks
# fail explicitly when their prerequisites are absent; they never silently skip.
case "${1:---offline}" in
  --offline) ;;
  --prerequisites)
    if [ ! -f "$S/../../packages/smithers/dist/esm/bin.js" ]; then
      echo "verify.sh: build the CLI with ./preflight.sh first" >&2
      exit 1
    fi
    if [ ! -x "$S/.venv-swb/bin/python" ]; then
      echo "verify.sh: run ./bootstrap.sh to provision the evaluator venv first" >&2
      exit 1
    fi
    node "$S/fixtures/check-subject.mjs"
    node "$S/fixtures/check-prompt-bytes.mjs"
    "$S/.venv-swb/bin/python" "$S/fixtures/check-eval-exports.py"
    exit 0
    ;;
  *) echo "usage: verify.sh [--offline|--prerequisites]" >&2; exit 2 ;;
esac

node "$S/fixtures/check-offline-target.mjs"

score() {
  node "$S/scorecard.ts" \
    --work "$S/fixtures/work" \
    --patches "$S/fixtures/patches" \
    --timings "$S/fixtures/timings" \
    --report "$S/fixtures/flows-cell-harness.mirror.json" \
    --subject "$S/fixtures/subject.json" \
    --out "$S/fixtures" \
    --instances "$(node -e '
      const rows=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
      process.stdout.write(rows.map(r=>r.id).join(","));
    ' "$S/fixtures/mirror-results.json")" >/dev/null
}

echo "== journal without a per-call duration"
node "$S/fixtures/make-fixture.mjs"
score
node "$S/fixtures/check.mjs" expect-no-latency

echo "== journal with a per-call duration"
node "$S/fixtures/make-fixture.mjs" --with-latency
score
node "$S/fixtures/check.mjs" expect-latency

echo "verify.sh: the scorecard generator agrees with the recorded wave."

echo "== repository-specific verification guidance"
python3 "$S/fixtures/test-test-command.py"
node "$S/fixtures/check-rig.mjs"

echo "== patch capture"
node "$S/fixtures/check-capture.mjs"

echo "== the subject under test"
node "$S/fixtures/check-agreement.mjs"

echo "== the CLI flows.sh execs"
node "$S/fixtures/check-cli-path.mjs"

echo "== the environment the lane hands that CLI"
node "$S/fixtures/check-env-names.mjs"
"$S/fixtures/check-codex-auth.sh"

echo "== the read-only liveness reading"
node "$S/fixtures/check-liveness-report.mjs"

echo "== one prompt, two harnesses"
node "$S/fixtures/check-prompts.mjs"

echo "== per-run artifact names"
node "$S/fixtures/check-run-paths.mjs"

echo "== the patches the evaluator is handed: missing refused, empty empty, artifact root honoured"
node "$S/fixtures/check-make-preds.mjs"

echo "== the harness's own snapshots stay out of the task repository"
"$S/fixtures/check-hidden-vcs.sh"

echo "== the matrix scheduler"
node "$S/fixtures/check-matrix.mjs"

echo "== the journal-only selector"
node "$S/fixtures/check-selector.mjs"

echo "== the matrix report"
node "$S/fixtures/check-matrix-report.mjs"

echo "== the lock every lane shares"
"$S/fixtures/check-lock.sh"

echo "== the full benchmark's ledger, queue and report"
node "$S/fixtures/check-fullbench.mjs"
node "$S/fixtures/check-fullbench-budget.mjs"
node "$S/fixtures/check-fullbench-status.mjs"

echo "== the driver's own wait for a worker that never finishes"
node "$S/fixtures/check-fullbench-drain.mjs"

echo "== the analysis bundle, and what it withholds"
node "$S/fixtures/check-trace-bundle.mjs"

echo "== the instances excluded from the scoreboard, and why"
node "$S/fixtures/check-excluded.mjs"

echo "== the baseline-vs-rerun comparison"
node "$S/fixtures/check-compare-runs.mjs"

echo "== the three-ledger scoreboard"
node "$S/fixtures/check-three-way.mjs"

echo "== the re-run's instance list and knobs"
node "$S/fixtures/check-run-45.mjs"

echo "== the two-arm scoreboard"
node "$S/fixtures/check-compare-arms.mjs"

echo "== the codex backfill's lanes"
node "$S/fixtures/check-codex-lanes.mjs"

echo "== the two-codex-lane scoreboard"
node "$S/fixtures/check-compare-codex-lanes.mjs"

echo "== the sealed testbed"
node "$S/fixtures/check-testbed-network.mjs"

echo "== the plue transport: Smithers Cloud workspaces as testbed and grader"
python3 "$S/fixtures/check-plue-transport.py"

echo "== one lane's seal, either arm"
node "$S/fixtures/check-breach-scan.mjs"

echo "== the program evidence a re-run report reads off its journals"
node "$S/fixtures/check-program-evidence.mjs"

echo "== the surgical evidence a second re-run reads off its journals"
node "$S/fixtures/check-surgery-evidence.mjs"

echo "== the round-3 evidence a third re-run reads off its journals"
node "$S/fixtures/check-round3-evidence.mjs"

echo "== the supervisor replay, rebuilt from a journal and scored offline"
node "$S/fixtures/check-jev-replay.mjs"

echo "== a run journaled into engine.db and control.db reads as one journal"
node "$S/fixtures/check-split-journal.mjs"

echo "== the realm evidence the REPL A/B reads off its journals"
node "$S/fixtures/check-repl-evidence.mjs"

echo "== every wave in one table"
node "$S/fixtures/check-n-way.mjs"
