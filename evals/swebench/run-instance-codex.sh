#!/bin/bash
# Runs the OpenAI Codex CLI harness on one SWE-bench Verified instance, under
# the same conditions run-instance.sh gives the flows harness: same
# image-derived checkout, same live container for tests, same repository test
# command, same prompt content, same wall-clock budget, and — since 2026-08-23 —
# the same reasoning effort, which defaults to `high` because that is what the
# flows arm has always run at. See SWB_CODEX_EFFORT below.
#
#   run-instance-codex.sh <instance_id> [timeout-seconds] [model] [run-index]
#
# Produces patches-codex/<instance_id>.patch, timings-codex/<instance_id>.json,
# and logs-codex/<instance_id>.*.
#
# With a run index — `run-instance-codex.sh <id> 1500 gpt-6-sol r3` — every one
# of those names carries `-r3`, from the same `lib/run-paths.sh` the flows script
# derives its names from, so a matrix run of five attempts per instance names its
# artifacts identically on both sides. A codex run deletes its workspace only
# after successfully capturing a non-empty patch; failed or empty captures keep it.
#
# This spends real API tokens and needs docker. See README.md.
set -euo pipefail
S="$(cd "$(dirname "$0")" && pwd)"
# The codex arm stays on local docker. It edits the bind-mounted host checkout
# with its own file tools, and a plue workspace has no host checkout; porting
# it means running codex inside the workspace, which is a different arm.
TRANSPORT="$("$S/lib/transport.sh")" || exit 2
if [ "$TRANSPORT" != "docker" ]; then
  echo "run-instance-codex.sh: the codex arm runs on SWB_TRANSPORT=docker only, got '$TRANSPORT'" >&2
  exit 2
fi
INSTANCE="$1"
BUDGET="${2:-1500}"
MODEL="${3:-gpt-6-sol}"
INDEX="${4:-}"
DATASET="${SWB_DATASET:-$S/swb-verified.json}"

if [ ! -f "$DATASET" ]; then
  echo "[$INSTANCE] no dataset at $DATASET — run ./bootstrap.sh first"; exit 1
fi
if [ ! -x "$S/.venv-swb/bin/python" ]; then
  echo "[$INSTANCE] no evaluator venv at $S/.venv-swb — run ./bootstrap.sh first"; exit 1
fi

IMAGE_ID="$(echo "$INSTANCE" | sed 's/__/_1776_/')"
IMAGE="swebench/sweb.eval.x86_64.${IMAGE_ID}:latest"

# Every artifact name this run writes, from the one place that knows the rule.
# `run-paths.sh` re-validates the instance id and the index before either reaches
# a path, a container name or an image name.
RUN_PATHS="$("$S/lib/run-paths.sh" codex "$INSTANCE" ${INDEX:+"$INDEX"})" || exit $?
eval "$RUN_PATHS"
mkdir -p "$WORK_ROOT" "$PATCH_ROOT" "$LOG_ROOT" "$TIMINGS_ROOT"

# Keep cleanup armed through capture. The workspace is also the bind-mounted
# container checkout, so removing containers must never remove the retry source.
LOCK="$S/.extract-lock"
TMPC=""
cleanup() {
  if [ -n "$TMPC" ]; then docker rm -f "$TMPC" >/dev/null 2>&1 || true; fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  "$S/lib/lock.sh" release "$LOCK" --owner $$ --quiet || true
}
on_signal() {
  trap '' INT TERM
  cleanup
  trap - EXIT INT TERM
  kill -s "$1" "$$"
}
trap cleanup EXIT
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

source "$S/lib/codex-auth.sh"
swb_codex_auth || exit $?
CODEX_AUTH="${SWB_CODEX_AUTH:-api-key}"

echo "[$RUN_ID] image $IMAGE"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker pull --platform linux/amd64 "$IMAGE" >"$LOG_PREFIX.pull.log" 2>&1 || {
    echo "[$RUN_ID] PULL FAILED"; exit 1; }
fi

# Serialize the testbed extraction across concurrent lanes: docker cp of a
# multi-GB tree is the disk-bandwidth spike, and five at once can fill the
# drive before any lane's cleanup runs.
# `lib/lock.sh` owns the protocol, and the same lock the flows side takes: the
# lock records this process's pid, so a lane that is killed while extracting
# hands the lock straight to the next waiter instead of wedging every later
# extraction in the rig.
"$S/lib/lock.sh" acquire "$LOCK" --owner $$ --label "$RUN_ID extraction" || {
  echo "[$RUN_ID] EXTRACTION LOCK TIMED OUT"; exit 1; }
rm -rf "$WORK"; mkdir -p "$WORK"
# Name it before acquisition so interruption during docker create is covered.
TMPC="${CONTAINER}-extract-$$"
docker create --platform linux/amd64 --name "$TMPC" "$IMAGE" >/dev/null
docker cp "$TMPC:/testbed/." "$WORK/" >/dev/null 2>&1
docker rm -f "$TMPC" >/dev/null 2>&1
TMPC=""
"$S/lib/lock.sh" release "$LOCK" --owner $$

# Same capture base as the flows side: the tree as the image ships it, so the
# image's own pre_install churn cannot enter the patch. Both harnesses are
# captured under one rule or the comparison is not a comparison.
CAPTURE_BASE="$("$S/lib/snapshot-base.sh" "$WORK")"
echo "[$RUN_ID] capture base $CAPTURE_BASE"

# The testbed container's network, from the same place the flows side reads it,
# and for the reason this arm made necessary: `SWB_CODEX_NETWORK=sealed` reaches
# the commands codex spawns on the host and not the processes a
# `docker exec <container> …` starts, so two of the 45 `r90s` runs fetched the
# merged upstream fix from inside the container the seal did not cover.
# `SWB_TESTBED_NETWORK=none` — the default since 2026-08-24 — removes the far
# side of that command from the network entirely. `lib/testbed-network.sh` owns
# the rule and records the docker-measured facts behind it.
TESTBED_NETWORK="$("$S/lib/testbed-network.sh" resolve)" || exit 2

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --platform linux/amd64 --name "$CONTAINER" --network "$TESTBED_NETWORK" \
  -v "$WORK:/testbed" -w /testbed "$IMAGE" sleep infinity >/dev/null 2>&1 || {
  echo "[$RUN_ID] CONTAINER START FAILED"; exit 1; }

# Read back off the live container, and fatal when it disagrees. A sealed lane's
# whole claim is this line, and a claim a run cannot check is the defect the
# `codex-sealed-websearch` lane already cost us once.
TESTBED_OBSERVED="$("$S/lib/testbed-network.sh" assert "$CONTAINER" "$TESTBED_NETWORK")" || {
  echo "[$RUN_ID] TESTBED NETWORK MISMATCH — asked for $TESTBED_NETWORK"; exit 1; }
echo "[$RUN_ID] testbed network $TESTBED_OBSERVED"

# The repository's own test runner, from the same place the flows side reads it.
# It is environment teaching, not an answer — `lib/test-command.py` refuses to
# print a command naming the graded identifiers — and withholding it from one
# side is not a baseline: `python -m pytest` cannot run Django's suite or
# Sphinx's, so a codex run told to verify that way could not verify anything on
# those instances while the harness under test could.
TEST_CMD="$("$S/.venv-swb/bin/python" "$S/lib/test-command.py" "$DATASET" "$INSTANCE")" || {
  echo "[$RUN_ID] NO TEST COMMAND — run ./bootstrap.sh first"; exit 1; }

# How this image runs the project's Python, from the same place the flows side
# reads it, and withheld from neither for the same reason as the test command.
INTERPRETER="$("$S/lib/interpreter.sh" "$CONTAINER" 2>/dev/null)" || INTERPRETER=""

node "$S/lib/write-prompt-codex.mjs" "$DATASET" "$INSTANCE" "$CONTAINER" "$TEST_CMD" "$INTERPRETER" \
  > "$LOG_PREFIX.prompt.md"

# Network access is a benchmark condition, not a detail. `SWB_CODEX_NETWORK`
# names the condition and it is recorded in the run's timings.
#
# It matters because on 2026-08-19 the pytest-dev__pytest-6197 trace showed
# codex resolving that instance by fetching the upstream fix and the upstream
# testing/test_collection.py at tag 5.2.4 from GitHub — the release that fixed
# the bug, and the file holding the graded tests. The r90c backfill did the same
# on matplotlib__matplotlib-24970, with four `curl https://api.github.com/...`
# calls that read the merged pull request. Our harness made no network call on
# either instance. A comparison where one side may read the answer and the other
# does not is not measuring the same thing.
#
# | value | what codex gets |
# | --- | --- |
# | `on` (default) | the approval/sandbox bypass: host shell, docker, network |
# | `sealed` | the same bypass, with every child command's HTTP proxy pointed at a dead port and the web-search tool off |
# | `off` | codex's own `workspace-write` sandbox, which denies all egress |
#
# **`off` denies more than the network, and that is why `sealed` exists.**
# Measured on codex-cli 0.149.0, 2026-08-22, under `--sandbox workspace-write`:
# a child command cannot reach the docker daemon over its unix socket
# (`permission denied ... unix:///…/docker.sock`), cannot reach a localhost TCP
# relay to it, cannot resolve a name, and cannot open a remote IP. The seatbelt
# policy denies AF_UNIX egress along with everything else, and neither
# `network.allow_unix_sockets` nor the experimental `network_proxy` feature
# changes it from `codex exec`, which has no `--permission-profile` flag. Since
# both arms are told to run the project's tests with
# `docker exec <container> …`, an `off` run cannot run a single test — so an
# `off` arm measures a harness with no web *and* no way to check its work, which
# is two variables at once and not the one this lane is about.
#
# `sealed` removes exactly the web. `shell_environment_policy.set` applies to the
# commands codex spawns and not to codex's own API calls, so the model still
# reaches the API while `curl`, `git`, `pip` and anything that honours the proxy
# environment reach a closed port. Measured the same day, same build:
# `docker exec` exit 0, `curl https://example.com` exit 7,
# `git ls-remote https://github.com/…` exit 128, `urllib.request.urlopen` raises.
# It is a seal on the tools an agent actually reaches for, not a kernel-level
# one: a raw socket, an explicit `--noproxy`, or a `curl` run *inside* the
# testbed container would still get out, and the container keeps the network the
# `on` arm gave it so that test behaviour does not change with the condition. A
# lane that claims a seal therefore has to read its own traces back and say what
# it found; `codex-backfill.sh --lane sealed` records the condition per run.
NETWORK="${SWB_CODEX_NETWORK:-on}"
SEALED_PROXY="${SWB_CODEX_SEALED_PROXY:-http://127.0.0.1:1}"
case "$NETWORK" in
  on)
    CODEX_ARGS=( --dangerously-bypass-approvals-and-sandbox ) ;;
  sealed)
    CODEX_ARGS=( --dangerously-bypass-approvals-and-sandbox )
    for PROXY_VAR in HTTP_PROXY HTTPS_PROXY ALL_PROXY FTP_PROXY \
      http_proxy https_proxy all_proxy ftp_proxy; do
      CODEX_ARGS+=( -c "shell_environment_policy.set.${PROXY_VAR}=${SEALED_PROXY}" )
    done
    # An inherited NO_PROXY would carve a hole in the seal, so it is emptied
    # rather than left to whatever the host's profile happens to say.
    CODEX_ARGS+=( -c "shell_environment_policy.set.NO_PROXY=" )
    CODEX_ARGS+=( -c "shell_environment_policy.set.no_proxy=" )
    # The web-search tool is codex's own network rather than a child command's,
    # so no amount of child-process proxying reaches it. It is **on** by default
    # in `codex exec` on codex-cli 0.149.0 and the model uses it: the first r90s
    # attempt, which set `tools.web_search=false` — a key this build ignores —
    # logged 126 `web search:` lines across 15 of its 45 runs, several of them
    # opening the instance's own upstream issue. `web_search=disabled` is the key
    # that works. Measured 2026-08-22 on one prompt asking the model to look up a
    # page: with the key, `NO_TOOL` and no search lines; without it, two search
    # lines and the right answer.
    CODEX_ARGS+=( -c "web_search=disabled" ) ;;
  off)
    CODEX_ARGS=( --sandbox workspace-write )
    echo "[$RUN_ID] NOTE: network=off also denies the docker socket, so this run cannot run the project's tests" ;;
  *)
    echo "[$RUN_ID] SWB_CODEX_NETWORK must be on, sealed or off, got '$NETWORK'"; exit 2 ;;
esac

# Reasoning effort is a benchmark condition, like the network, and it is pinned
# here rather than inherited. Subscription lanes can select a signed-in Codex
# home, whose user config must not decide this benchmark condition.
#
# It was pinned to the literal `medium` from 2026-08-19 to 2026-08-23, under a
# comment saying medium "matches what our harness got as the API default". That
# premise was false. The flows arm has never taken an API default: `effortFor`
# in `packages/smithers/agent/src/AgentSession.ts` returns `high` whenever a flow
# declares no `effort:` frontmatter, `lib/write-flow.mjs` declares none, and
# both have been that way since before wave 1. So every flows wave ran at high
# while every codex lane ran at medium — 45 of 45 transcripts in both
# `fullbench/codex/logs/` and `fullbench/codex-sealed/logs/` carry
# `reasoning effort: medium` — and effort was a variable neither arm's number
# controlled for. Will ruled on 2026-08-23 that the prior results are
# effort-confounded and that the codex arm re-runs at the effort the arm it is
# compared against uses, so the default here is `high`.
#
# A lane that reproduces an older measurement pins its own value instead;
# `codex-backfill.sh` pins one per lane for exactly that reason. The value is
# recorded in the run's timings, and codex echoes it in its own run-log header
# (`reasoning effort: <value>`), so a transcript proves what it ran at.
EFFORT="${SWB_CODEX_EFFORT:-high}"
case "$EFFORT" in
  minimal|low|medium|high|xhigh) ;;
  *)
    echo "[$RUN_ID] SWB_CODEX_EFFORT must be minimal, low, medium, high or xhigh, got '$EFFORT'"; exit 2 ;;
esac

echo "[$RUN_ID] codex start ($MODEL, effort $EFFORT, ${BUDGET}s)"
START=$(date +%s)
CODE=0
timeout "$BUDGET" codex exec \
  -C "$WORK" \
  -m "$MODEL" \
  -c model_reasoning_effort="$EFFORT" \
  "${CODEX_ARGS[@]}" \
  --skip-git-repo-check \
  --ephemeral \
  --color never \
  -o "$LOG_PREFIX.last-message.txt" \
  - < "$LOG_PREFIX.prompt.md" \
  > "$LOG_PREFIX.run.log" 2>&1 || CODE=$?
END=$(date +%s)
echo "[$RUN_ID] codex done in $((END-START))s (exit $CODE)"

# `network` is the seal on codex's own tools and `testbedNetwork` is the seal on
# the container those tools can reach through `docker exec`. They are separate
# conditions with separate holes, so a run records both — and records what
# `docker inspect` observed as well as what the lane asked for, because the
# scoreboard asserts on the observation.
printf '{\n  "instance_id": "%s",\n  "run_id": "%s",\n  "runIndex": "%s",\n  "model": "%s",\n  "codexAuth": "%s",\n  "budgetSeconds": %s,\n  "network": "%s",\n  "effort": "%s",\n  "testbedNetwork": "%s",\n  "testbedNetworkObserved": "%s",\n  "exitCode": %s,\n  "startedAt": %s,\n  "endedAt": %s,\n  "wallClockSeconds": %s\n}\n' \
  "$INSTANCE" "$RUN_ID" "$RUN_INDEX" "$MODEL" "$CODEX_AUTH" "$BUDGET" "$NETWORK" "$EFFORT" \
  "$TESTBED_NETWORK" "$TESTBED_OBSERVED" "$CODE" "$((START*1000))" "$((END*1000))" "$((END-START))" \
  > "$TIMINGS"

CAPTURE_STATUS=0
"$S/lib/capture-patch.sh" "$WORK" "$PATCH" \
  ':(exclude)AGENTS.md' >/dev/null || CAPTURE_STATUS=$?
if [ "$CAPTURE_STATUS" -eq 0 ] && [ ! -f "$PATCH" ]; then CAPTURE_STATUS=1; fi
if [ "$CAPTURE_STATUS" -ne 0 ]; then
  echo "[$RUN_ID] CAPTURE FAILED (exit $CAPTURE_STATUS); checkout retained at $WORK; patch $PATCH" >&2
  printf 'captureExitStatus=%s\nworkspace=%s\npatch=%s\n' \
    "$CAPTURE_STATUS" "$WORK" "$PATCH" > "$LOG_PREFIX.capture-failed" || true
  exit "$CAPTURE_STATUS"
fi
rm -f "$LOG_PREFIX.capture-failed"

# An empty patch is a valid no-edit result, but keep its checkout for inspection.
if [ -s "$PATCH" ]; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
else
  echo "[$RUN_ID] empty patch; checkout retained at $WORK"
fi
echo "[$RUN_ID] patch bytes: $(wc -c < "$PATCH" | tr -d ' ')"
echo "[$RUN_ID] untracked files left out of the patch: $(wc -l < "$PATCH.untracked" | tr -d ' ')"
