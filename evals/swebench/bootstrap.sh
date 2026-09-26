#!/bin/bash
# Provisions everything this benchmark needs that is not committed.
#
#   ./bootstrap.sh [sample-size]
#
# Four steps, each idempotent:
#   1. the official evaluator venv (.venv-swb, the `swebench` package)
#   2. the dataset (swb-verified.json, from princeton-nlp/SWE-bench_Verified)
#   3. the seeded sample (sample.json), asserted against the pinned instances
#   4. a docker check, and a report of which images the sample needs
#
# Nothing here spends model tokens. Step 4 pulls no images; the run scripts pull
# the one image they need, on demand.
set -u
S="$(cd "$(dirname "$0")" && pwd)"
SIZE="${1:-8}"
VENV="$S/.venv-swb"
DATASET="$S/swb-verified.json"
SAMPLE="$S/sample.json"
PY="${PYTHON:-python3}"
SWEBENCH_VERSION="4.0.4"

echo "== 1/4 evaluator venv"
if [ -x "$VENV/bin/python" ] && "$VENV/bin/python" -c \
  "from importlib.metadata import version; assert version('swebench') == '$SWEBENCH_VERSION'" \
  >/dev/null 2>&1; then
  echo "   $VENV already has swebench $SWEBENCH_VERSION"
else
  command -v "$PY" >/dev/null 2>&1 || { echo "   no $PY on PATH"; exit 1; }
  "$PY" -m venv "$VENV" || exit 1
  "$VENV/bin/python" -m pip install --quiet --upgrade pip || exit 1
  # 5.x rejects our `--cache_level env` invocation and the Verified dataset's
  # committed schema; 4.0.4 is the evaluator that graded the recorded wave.
  # `swebench` also brings `datasets`, which step 2 uses to fetch the dataset.
  "$VENV/bin/python" -m pip install --quiet "swebench==$SWEBENCH_VERSION" || exit 1
  echo "   installed swebench $SWEBENCH_VERSION into $VENV"
fi

echo "== 2/4 dataset"
if [ -s "$DATASET" ]; then
  echo "   $DATASET already present ($(wc -c < "$DATASET" | tr -d ' ') bytes)"
else
  "$VENV/bin/python" - "$DATASET" <<'PY' || exit 1
import json, sys
from datasets import load_dataset

rows = [dict(row) for row in load_dataset("princeton-nlp/SWE-bench_Verified", split="test")]
with open(sys.argv[1], "w") as handle:
    json.dump(rows, handle)
print(f"   downloaded {len(rows)} instances")
PY
fi
node -e '
const rows = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
if (rows.length !== 500) { console.error(`   expected 500 instances, got ${rows.length}`); process.exit(1) }
console.log(`   ${rows.length} instances, ${new Set(rows.map(r => r.repo)).size} repositories`);
' "$DATASET" || exit 1

echo "== 3/4 seeded sample"
node "$S/lib/sample.mjs" "$DATASET" "$SAMPLE" "$SIZE" || {
  echo "   The seeded sample did not reproduce the pinned instances. See README.md."
  exit 1
}

echo "== 4/4 docker"
if [ "${SWB_TRANSPORT:-docker}" = "plue" ]; then
  echo "   SWB_TRANSPORT=plue: testbeds and gradings are Smithers Cloud workspaces;"
  echo "   this host needs SMITHERS_CLI, PLUE_REPO and SMITHERS_TOKEN, not docker"
  echo
  echo "Bootstrap complete. Nothing above spent model tokens."
  exit 0
elif ! command -v docker >/dev/null 2>&1; then
  echo "   docker is not on PATH — the run scripts cannot work without it"
  exit 1
elif ! docker info >/dev/null 2>&1; then
  echo "   docker is installed but not running — start it before running instances"
  exit 1
else
  echo "   docker is running"
fi
echo "   Each instance uses one official image, pulled on demand by the run"
echo "   scripts (linux/amd64, several GB each):"
node -e '
const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const id of s.instances) console.log(`     swebench/sweb.eval.x86_64.${id.replace("__", "_1776_")}:latest`);
' "$SAMPLE"

echo
echo "Bootstrap complete. Nothing above spent model tokens."
echo "Next: ./run-instance.sh <instance_id>   (spends API tokens, needs docker)"
