#!/bin/bash
# Grades collected model patches with the official SWE-bench harness.
#
#   evaluate.sh <run-id> <instance_id> [<instance_id> ...]
#
# Reads patches/ by default; set HARNESS=codex to grade patches-codex/ instead.
# Both defaults sit under SWB_ARTIFACT_ROOT when it is set, derived by
# `lib/run-paths.sh --roots` — the same derivation the run scripts write
# through — so a wave run off the checkout is graded where it was written
# rather than as a set of missing (and so refused) predictions.
# Writes preds-<run-id>.json and the evaluator's own report,
# <model-name>.<run-id>.json, into this directory. Both are transient and
# gitignored; the scorecard reads the report.
#
# Two overrides serve the best-of-n matrix, where one instance has n patches and
# the evaluator's predictions can only be keyed by instance id:
#
#   SWB_PATCH_SUFFIX=-r3   grade <id>-r3.patch as <id>'s prediction
#   SWB_PATCHES=selected   grade a different directory: absolute, or relative
#                          to this one
#   SWB_MODEL_NAME=...     the model name the report is filed under
#
# So a 25-run flows matrix grades as five run ids, one per round, and the
# selected patches grade as a sixth. `grade-matrix.sh` drives all of it.
#
# SWB_EVAL_WORKERS sets the evaluator's concurrency. It defaults to 1, and
# raising it is not merely a speed/disk tradeoff: with this evaluator (swebench
# 4.0.4) and `--cache_level env`, concurrent workers race in the post-run image
# cleanup and the run dies with `docker.errors.ImageNotFound` on an image
# another worker already removed. Every instance still grades — the 2026-08-19
# attempt logged "2 ran successfully, 0 failed" — but the crash happens before
# the report is written, so the whole grading is lost. Measured on the same two
# instances: workers=3 crashed with no report, workers=1 wrote the report.
#
# The wave itself (run-sample.sh) is a different matter and does run its
# instances concurrently; only grading serializes.
#
# That serialization is rig-wide, not per-caller: the full benchmark grades an
# instance the moment its patch exists, so it and a `grade-matrix.sh` started by
# hand are two evaluator processes racing the same image cleanup on the same
# docker daemon. Every invocation therefore takes `.grade-lock` through
# `lib/lock.sh`, which releases it by owner and takes it back from a pid that is
# gone. A caller that already holds it says so with SWB_GRADE_LOCK_HELD=1 —
# `lib/fullbench-instance.sh` does, because it holds the lock across the verdict
# it reads afterwards — and this then grades without taking it a second time.
#
# ## The psf/requests family and httpbin
#
# `psf/requests`' graded tests are network tests: `test_requests.py` reads
# `HTTPBIN = os.environ.get('HTTPBIN_URL', 'http://httpbin.org/')`, and roughly a
# third of the dataset's graded identifiers for `psf__requests-1766` and
# `psf__requests-2317` route through it. The public httpbin.org answered 503
# during the r90 grading, so those tests failed for reasons no patch could
# change — 34 of 2317's `PASS_TO_PASS` tests among them, and a `PASS_TO_PASS`
# test failing indicts the environment by construction.
#
# So when a grading includes any `psf/requests` instance, `lib/httpbin.sh
# resolve` decides which httpbin it will meet and says so out loud: the public
# service when it answers over both http and https, the rig's own container when
# it does not, and a refusal when neither is available. The chosen URL reaches
# `lib/grade.py`, which exports `HTTPBIN_URL` inside that instance's `eval.sh` —
# the variable the suite already reads. It applies to `psf/requests` only, and to
# whichever harness produced the patch, so both arms are graded under one rig.
# Nothing else about the grading changes, and the export is visible in the
# archived `eval.sh` and in `test_output.txt`.
#
#   SWB_HTTPBIN_URL=…  grade against this endpoint, whatever the probe says
#   SWB_NO_HTTPBIN=1   skip the check entirely and let the suite use its own
#                      default, as r90 did — including when it is down
#
# SWB_TRANSPORT=plue grades on Smithers Cloud: `lib/grade.py` boots each
# instance's official image as a `--network none` workspace instead of a local
# container, and the evaluator's own code applies, runs and grades as ever.
# Nothing is pulled here, the grade lock is not taken, and psf/requests (whose
# graded tests need an httpbin) is refused unless SWB_NO_HTTPBIN=1.
#
# SWB_CACHE_LEVEL is the evaluator's `--cache_level`. It defaults to `env`,
# which deletes each official instance image once that instance is graded — a
# 3 GB re-pull for the next wave. Set it to `instance` for a supplementary
# grading that should leave the image cache as it found it. It changes what is
# kept on disk, never how a patch is graded.
set -u
S="$(cd "$(dirname "$0")" && pwd)"
RUN_ID="$1"; shift
HARNESS="${HARNESS:-flows}"
WORKERS="${SWB_EVAL_WORKERS:-1}"
CACHE_LEVEL="${SWB_CACHE_LEVEL:-env}"
# The evaluator's per-instance timeout. 1800 s is the official default and is
# ample for every repository here but one: `psf/requests`' `test_connection_error`
# is hardcoded to `http://httpbin.org:1`, whose SYN packets are dropped rather
# than refused, so the test sits in TCP retransmit against every A record the
# name resolves to before it raises the ConnectionError it is asserting. Measured
# on 2026-08-21: over 17 minutes for that one test, from a suite whose remaining
# 142 tests take seconds. It is an environment cost, identical for both arms and
# for any patch.
EVAL_TIMEOUT="${SWB_EVAL_TIMEOUT:-1800}"

for PAIR in "SWB_EVAL_WORKERS:$WORKERS" "SWB_EVAL_TIMEOUT:$EVAL_TIMEOUT"; do
  case "${PAIR#*:}" in
    ''|*[!0-9]*|0) echo "${PAIR%%:*} must be a positive integer"; exit 2 ;;
  esac
done
case "$CACHE_LEVEL" in
  none|base|env|instance) ;;
  *) echo "SWB_CACHE_LEVEL must be none, base, env or instance"; exit 2 ;;
esac

TRANSPORT="$("$S/lib/transport.sh")" || exit 2
export SWB_TRANSPORT="$TRANSPORT"

case "$HARNESS" in
  codex) MODEL="codex-cli" ;;
  flows) MODEL="flows-cell-harness" ;;
  *) echo "HARNESS must be flows or codex"; exit 2 ;;
esac
ROOTS="$("$S/lib/run-paths.sh" "$HARNESS" --roots)" || exit 2
PATCH_ROOT=""
eval "$ROOTS"
PATCHES="$PATCH_ROOT"
case "${SWB_PATCHES:-}" in
  '') ;;
  /*) PATCHES="$SWB_PATCHES" ;;
  *) PATCHES="$S/$SWB_PATCHES" ;;
esac
if [ -n "${SWB_MODEL_NAME:-}" ]; then MODEL="${SWB_MODEL_NAME}"; fi
SUFFIX="${SWB_PATCH_SUFFIX:-}"
case "$SUFFIX" in
  ''|-r[0-9]*) ;;
  *) echo "SWB_PATCH_SUFFIX must be empty or -r<digits>"; exit 2 ;;
esac
if [ ! -d "$PATCHES" ]; then
  echo "no patches directory at $PATCHES"; exit 1
fi

# A requested instance with no patch file refuses the whole grading: it is a run
# that never finished or a directory that is not where the run wrote, and
# grading it as an empty prediction would report a rig fault as a zero.
if ! node "$S/lib/make-preds.mjs" "$PATCHES" "$MODEL" "$SUFFIX" "$@" > "$S/preds-$RUN_ID.json"; then
  rm -f "$S/preds-$RUN_ID.json"
  echo "evaluate.sh: refusing to grade; see the missing patch files above"
  exit 1
fi
# SWB_PREDS_ONLY=1 stops here, with preds-<run-id>.json written and nothing
# graded: a look at exactly what the evaluator would be handed, and the seam
# `fixtures/check-make-preds.mjs` resolves the patches directory through.
if [ "${SWB_PREDS_ONLY:-0}" = "1" ]; then
  echo "evaluate.sh: wrote $S/preds-$RUN_ID.json from $PATCHES; not grading (SWB_PREDS_ONLY=1)"
  exit 0
fi
if [ ! -x "$S/.venv-swb/bin/python" ]; then
  echo "no evaluator venv at $S/.venv-swb — run ./bootstrap.sh first"; exit 1
fi
cd "$S" || exit 1

# The httpbin the psf/requests family is graded against. Decided from the
# predictions file rather than from "$@", so a call that named no instances and
# grades every collected patch is covered by the same rule.
NEEDS_HTTPBIN="$(node -e '
  const preds = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  process.stdout.write(Object.keys(preds).some((id) => id.startsWith("psf__requests-")) ? "1" : "")
' "$S/preds-$RUN_ID.json")"
if [ -n "$NEEDS_HTTPBIN" ] && [ "${SWB_NO_HTTPBIN:-0}" != "1" ] && [ "$TRANSPORT" = "plue" ]; then
  # A plue grading workspace is sealed, so no httpbin is reachable from it.
  echo "evaluate.sh: psf/requests' graded tests need an httpbin, and a --network none grading"
  echo "  workspace has none. Grade them with SWB_TRANSPORT=docker, or pass SWB_NO_HTTPBIN=1."
  exit 1
fi
if [ -n "$NEEDS_HTTPBIN" ] && [ "${SWB_NO_HTTPBIN:-0}" != "1" ]; then
  HTTPBIN_ENDPOINT="$("$S/lib/httpbin.sh" resolve)" || {
    echo "evaluate.sh: no httpbin is answering, and psf/requests cannot be graded against"
    echo "  a dead service without repeating the r90 rig fault. Pass SWB_NO_HTTPBIN=1 to do it anyway."
    exit 1; }
  export SWB_EVAL_EXPORTS="$(node -e '
    process.stdout.write(JSON.stringify({ HTTPBIN_URL: process.argv[1] }))
  ' "$HTTPBIN_ENDPOINT")"
  export SWB_EVAL_EXPORTS_REPOS="psf/requests"
  echo "evaluate.sh: psf/requests instances grade against $HTTPBIN_ENDPOINT"
fi

# The lock serializes image cleanup on one docker daemon. Under plue no image is
# local and each grading has its own workspace, so there is nothing to race.
HELD=0
if [ "${SWB_GRADE_LOCK_HELD:-0}" != "1" ] && [ "$TRANSPORT" = "docker" ]; then
  "$S/lib/lock.sh" acquire "$S/.grade-lock" --owner $$ --label "evaluate.sh $RUN_ID" \
    --timeout "${SWB_GRADE_LOCK_TIMEOUT:-7200}" || {
    echo "evaluate.sh: another evaluator still holds $S/.grade-lock"; exit 1; }
  HELD=1
  trap '"$S/lib/lock.sh" release "$S/.grade-lock" --owner $$ --quiet' EXIT INT TERM
fi

# lib/grade.py is the evaluator, run with the rig's architecture. See its
# docstring: the evaluator picks arm64 from platform.machine() alone, while
# every instance here was produced against a --platform linux/amd64 checkout.
.venv-swb/bin/python "$S/lib/grade.py" \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --predictions_path "preds-$RUN_ID.json" \
  --run_id "$RUN_ID" \
  --instance_ids "$@" \
  --max_workers "$WORKERS" \
  --cache_level "$CACHE_LEVEL" \
  --timeout "$EVAL_TIMEOUT"
STATUS=$?

if [ "$HELD" = "1" ]; then
  trap - EXIT INT TERM
  "$S/lib/lock.sh" release "$S/.grade-lock" --owner $$ --quiet
fi
exit "$STATUS"
