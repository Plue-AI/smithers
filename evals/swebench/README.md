# SWE-bench Verified benchmark rig

The benchmark that grades the flows built-in harness against the Codex CLI on
identical SWE-bench Verified instances, with the same model, on three
dimensions: **quality** (resolved rate), **speed** (wall clock), and **cost**
(tokens and USD).

This is an **operator-run** benchmark. It spends real API tokens, it needs
docker and multi-gigabyte official images, and one instance takes minutes to
tens of minutes. It is **not** part of any CI gate and must not become one: a
gate that needs a funded API key, a warm docker cache, and a nondeterministic
model cannot hold a tree, and a red it produces would say nothing about the
commit under test. Two things here are safe to run unattended: `./verify.sh`,
which checks the rig's own arithmetic offline, and `./fullbench-dryrun.sh`,
which proves the full-benchmark driver against real docker and a stubbed agent.

The rig lives in the repository so it cannot be lost again. It previously lived
in a session scratchpad, which was wiped, taking the dataset, the sample, the
CLI wrapper, and the evaluator environment with it.

## Layout

| Path                       | What it is                                                          |
| -------------------------- | ------------------------------------------------------------------- |
| `bootstrap.sh`             | Provisions everything transient: venv, dataset, sample, docker check |
| `preflight.sh`             | Builds the subject, fingerprints it, and pins it for the wave        |
| `flows.sh`                 | Runs this checkout's flows CLI in an arbitrary workspace             |
| `readonly-liveness.sh`     | Proves the read-only control fires through the real CLI (spends ~$0.30) |
| `run-instance.sh`          | One instance through the flows harness                               |
| `run-instance-codex.sh`    | One instance through the Codex CLI, same conditions                  |
| `preflight-network.sh`     | Proves a `--network none` testbed can still run the repos' suites    |
| `network-dryrun.sh`        | Proves the sealed testbed against real docker, with no model spend   |
| `run-sample.sh`            | The sample, in draw order, one harness                               |
| `run-matrix.sh`            | The sample n times over, one harness, at a bounded concurrency       |
| `select-candidate.mjs`     | Picks one instance's submission out of its n runs, from journals alone |
| `evaluate.sh`              | Grades collected patches with the official evaluator                 |
| `grade-matrix.sh`          | Grades a matrix in three groups: flows rounds, codex rounds, selected |
| `matrix-report.mjs`        | Reliability, best-of-n, selector quality, single-attempt continuity  |
| `fullbench.sh`             | All 500 instances, one attempt each, detached, resumable, streaming  |
| `fullbench-status.sh`      | One screen of a running (or stopped) full benchmark                  |
| `fullbench-report.mjs`     | The full benchmark's scoreboard and its checkpoint log               |
| `fullbench-dryrun.sh`      | Proves that driver against real docker, with no model spend          |
| `codex-backfill.sh`        | One codex attempt on every instance the full benchmark graded        |
| `codex-backfill-dryrun.sh` | Proves the backfill against real docker, with no model spend         |
| `compare-codex-lanes.mjs`  | The codex arm with the network against the same arm sealed           |
| `breach-scan.mjs`          | One lane's seal, either arm, asserted off its own ledger and traces  |
| `regrade.sh`               | Re-grades a collected patch when the rig, not the patch, was at fault |
| `lib/httpbin.sh`           | Decides and proves the httpbin the psf/requests family is graded against |
| `run-45.sh`                | The re-run: the baseline's 45 instances again, on today's harness    |
| `compare-runs.mjs`         | Baseline vs re-run — resolved, dollars, wall, per-instance deltas    |
| `lib/excluded.mjs`         | The instances excluded from the scoreboard by name, and the cause on record |
| `lib/program-evidence.mjs` | What a run's agent actually did, counted off its journals            |
| `lib/jev-replay.mjs`       | The supervisor's reading, replayed over archived journals and scored against verdicts |
| `fixtures/check-jev-replay.mjs` | Proves that replay over a synthetic journal, offline                  |
| `memory/`                  | Per-repository memory stores a `SWB_MEMORY=repo` wave writes (gitignored) |
| `lib/trace-bundle.mjs`     | One instance's two traces and two bills, as the brief for an analyst |
| `regen-patch.sh`           | Re-derives one patch from a surviving workspace                      |
| `scorecard.ts`             | Quality + speed + cost, per instance and in aggregate                |
| `prices.ts`                | The committed USD price table, with its sources                      |
| `verify.sh`                | Offline check that the rig still computes what it claims             |
| `baseline/`                | The committed codex numbers and patches to compare against           |
| `fixtures/`                | The recorded numbers `verify.sh` replays                             |
| `lib/testbed-network.sh`   | The testbed container's network condition, resolved, observed and asserted |
| `lib/transport.sh`         | `SWB_TRANSPORT`, validated: `docker` (default) or `plue`               |
| `lib/plue.py`              | The plue transport: testbed workspaces, in-guest capture, the evaluator's container |
| `lib/`                     | Sampler, prompt writers, prediction builder, patch capture, subject fingerprint, per-run naming, the lock every lane shares, journal reader, full-benchmark ledger and pipeline, codex-backfill queue and token footer, analysis bundle |

Everything else the rig writes — `swb-verified.json`, `sample.json`,
`.venv-swb/`, `.subject.json`, `work/`, `work-liveness/`, `patches/`,
`timings/`, `logs-*/`, `journals/`, `selected/`, `matrix-*.json`,
`fullbench/`, `preds-*.json`, the evaluator's reports, `scorecard.*` — is
transient and gitignored.

## The subject under test

**A wave measures the working tree, not a commit.** Every `@smthrs/*` package's
workspace `exports` map points at `./src/*.ts`, so
`packages/smithers/dist/esm/bin.js` resolves `@smthrs/harness/CellTurn` to
`packages/smithers/agent/harness/src/CellTurn.ts` and Node strips its types on load. The
harness under test is therefore whatever is on disk at the instant each CLI
process starts. `packages/smithers/agent/harness/dist` is not in the loaded graph at all and
its state means nothing. `packages/smithers` is the one package whose build is
loaded, through the `bin.js` entry point.

Two consequences, both of which have already cost a wave:

- A sibling lane editing `packages/smithers/agent/harness/src` while a wave is in flight
  changes the subject between instances, with nothing in the artifacts saying
  so.
- Building a filter closure — `pnpm --filter "@smthrs/cli..." build --no-bail` —
  builds packages nothing loads and, with `--no-bail`, reports success while a
  package in the middle failed.

So the wave pins its subject first:

```sh
./preflight.sh
```

It builds exactly one package (`@smthrs/cli`, no closure, no `--no-bail`, a
non-zero exit is fatal), derives a content fingerprint with `lib/subject.mjs`,
and writes `.subject.json`. The fingerprint records, for every package in the
CLI's `@smthrs/*` dependency closure, where its entry point resolves and a
content hash of the directory that answer selects — plus the hash of
`packages/smithers/agent/harness/src/CellTurn.ts` as the marker a report cites, the hashes of
`packages/smithers/dist/esm` and `packages/smithers/src`, the git HEAD, and the node
version.

`packages/smithers/src` is in the stamp even though no process loads it. It is the
only package where what is on disk and what runs are two different things, so
it is the only one whose build can go stale under a wave: an edit to any other
package changes bytes the CLI loads and stops the wave at the next `flows.sh`
call, while an edit to the CLI's own source used to change nothing the pin could
see. Hashing both means a pinned pair asserts that one `preflight.sh` run
produced them together, and a CLI source change stops the wave until another one
does. What no fingerprint can see is a complete `dist/esm` compiled from source
that is no longer on disk; `preflight.sh` deletes `dist` before it builds, so a
pinned pair only ever comes from a full rebuild.

`preflight.sh` refuses to pin a subject that cannot be reported honestly:

| Refusal | What it catches |
| --- | --- |
| `no-cli-build` | `packages/smithers/dist/esm/bin.js` does not exist |
| `partial-cli-build` | a `src/X.ts` has no `dist/esm/X.js` — a build that stopped early |
| `unresolvable` | a package cannot resolve a dependency the way the process will |
| `foreign-subject` | a package resolves outside this checkout |
| `unbuilt-dist` | a dependency resolves into a `dist/` this rig does not build |
| `dirty-subject` | a package's `src` differs from `git HEAD`, so no report may name a commit |

`SWB_ALLOW_DIRTY_SUBJECT=1` runs a wave on an uncommitted subject anyway. The
fingerprint still records every differing path, and the scorecard prints them,
so the report cannot claim a clean commit.

After the pin, **every `flows.sh` invocation re-derives the fingerprint and
refuses to run when it has moved** (exit 4). A wave that starts on one harness
and finishes on another stops instead of being averaged into one number.
`SWB_SUBJECT_UNPINNED=1` skips the check for one-off CLI calls by hand; never
use it for a wave.

`run-instance.sh` stamps the pinned fingerprint into `timings/<id>.json`, and
`scorecard.ts` prints the wave's preconditions from those stamps — including an
`agreement` line that says outright when two instances ran different subjects.

## Bootstrap

```sh
cd evals/swebench
./bootstrap.sh          # sample size 8 by default
```

It creates `.venv-swb` with the official `swebench` package, downloads
`princeton-nlp/SWE-bench_Verified` to `swb-verified.json` (500 instances),
regenerates `sample.json`, and reports whether docker is running and which
images the sample needs. It pulls no images; the run scripts pull the one image
they need, on demand. Nothing in bootstrap spends model tokens.

## Run one instance

```sh
export OPENAI_API_KEY=sk-...
./preflight.sh                                                   # once per wave
./run-instance.sh django__django-16612 openai:gpt-6-sol 1200
```

The script extracts the instance's testbed out of the official image, bind
mounts it back at `/testbed` so the container's interpreter sees the same tree
the agent edits, records the capture base (below), writes the fix flow with
`lib/write-flow.mjs`, drives the CLI through `plan` → `approve` → `run` under a
timeout, then captures the patch. It leaves `work/<id>/` (including the run's
journal in `work/<id>/.flows/`), `journals/<id>/` (that journal, copied out
so it survives the next wave), `patches/<id>.patch`,
`patches/<id>.patch.untracked`, `timings/<id>.json`, and
`logs-agent/<id>.run.log`.

The codex baseline runs the same shape with its own isolated `CODEX_HOME`, the
same prompt content — including the repository's own test runner, which
`lib/test-command.py` derives for both sides — and the same budget:

```sh
SWB_CODEX_NETWORK=sealed ./run-instance-codex.sh django__django-16612 1500
```

`SWB_CODEX_NETWORK` defaults to `sealed`. The problem statement comes from a
public issue tracker, so the prompt is untrusted. `on` runs codex with
`--dangerously-bypass-approvals-and-sandbox` and the network open: a
prompt-steered shell on this host with the docker socket, `CODEX_HOME` and the
web in reach. The runner refuses `on` unless `SWB_CODEX_UNCONFINED=allowed` is
also set, and prints a warning when it is. `sealed` keeps the same bypass so
codex can reach the docker socket, with child proxies dead and web search off.
`run-sample.sh codex` and `run-matrix.sh codex` apply the same check once,
before the first instance, through `lib/codex-network.sh`.
See [Lanes, and the sealed one](#lanes-and-the-sealed-one).

For a ChatGPT-subscription control, set `SWB_CODEX_AUTH=chatgpt` and
`SWB_CODEX_HOME=$HOME/.codex`. The runner checks that `codex login status`
actually reports a ChatGPT login before pulling an image; the default remains
the rig's isolated API-key home for historical lanes. Set
`SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` to an executable `smithers-jj-export`
for the flows arm when overriding the CLI's packaged/checkout resolver. Its
guarded filesystem needs the helper even for `plan`, and the rig rejects a
broken explicit override before pulling an image.
The current flows CLI also requires `AI_GATEWAY_API_KEY` for its Jev judge at
approval time; `SMITHERS_OPENAI_AUTH=chatgpt` changes the agent model route,
not that judge.

The whole sample, one harness at a time:

```sh
./run-sample.sh flows 5
./run-sample.sh codex 5
```

Both run scripts take an optional trailing **run index**, which is how one
instance carries five attempts at once. See [Best-of-n](#best-of-n).

One condition on the flows side is off unless a lane turns it on, and it is
stamped into `timings/<id>.json` so a report can separate it:

```sh
SWB_MEMORY=repo ./run-instance.sh django__django-16612   # "memory": "repo"
```

`SWB_MEMORY=repo` points the CLI's memory store (`SMITHERS_MEMORY_DB`) at
`memory/<repo>.db`, outside the workspace and shared by every instance of one
repository and by nothing else. A run may then remember how its repository
builds and tests, and a later run of the same repository may be shown it. That
is a different experiment from the independent-instance score the scoreboard
reports: the second django instance in a memory-on wave is not independent of
the first, so a report must not pool the two conditions. The default, `off`,
stamps `"memory": "off"`, and a run under it writes no memory at all: the
supervisor writes only when the host names a memory database of its own.
Every instance pointed at one `memory/<repo>.db` reads and writes one bank,
named after that file. A write or recall the store refused is journaled as
`control.agent.supervisor-memory-failed` and counted in the scorecard's
`supervisorMemoryFailures`.

The supervisor needs no switch. The CLI always runs with a judge, so every run
journals a verdict on every frame, and a verdict past its threshold nudges the
run at the next turn boundary and inserts recalled memory. The run's
`control.agent.discipline-armed` row records this as `judged`.

## The sealed testbed

**The testbed container has no route out of the machine, and that is enforced
by the kernel rather than by an environment variable.** `SWB_TESTBED_NETWORK`
names the condition, `none` is the default, and it reaches the one `docker run`
in the rig that starts a testbed:

```sh
SWB_TESTBED_NETWORK=none   ./run-instance.sh django__django-16612   # the default
SWB_TESTBED_NETWORK=bridge SWB_CODEX_NETWORK=on SWB_CODEX_UNCONFINED=allowed ./run-instance-codex.sh django__django-16612 1500
```

The knob exists because the seal the codex lanes claimed was a seal on the
*tools an agent reaches for*, and an agent found the way round it. The proxy
variables are set through `shell_environment_policy.set`, which reaches the
commands codex spawns on the host; `docker exec <container> curl …` starts its
process as the docker daemon's child, inside a container that had the network
on. Two of the 45 `r90s` runs used exactly that to fetch the merged upstream
fix, and the `r90sh` lane repeated it. Will's ruling on 2026-08-24: a proper
sandbox, so it cannot cheat. A container with no interfaces but `lo` cannot
fetch a patch whatever command is run inside it, whatever the agent knows about
proxies, and whatever a later harness invents.

| value | what the testbed gets |
| --- | --- |
| `none` (default) | `--network none`: loopback only. No route, no DNS, no bridge, no host port |
| `bridge` | docker's default bridge network — what every lane before 2026-08-24 was measured under |

`lib/testbed-network.sh` is the only place that knows the rule, and it does
three things rather than one:

```sh
lib/testbed-network.sh resolve                    # the requested mode, validated
lib/testbed-network.sh observe <container>        # the mode docker reports
lib/testbed-network.sh assert  <container> none   # both, and they must agree
```

`resolve` refuses anything but the two values, so a typo is a stopped run and
never a silently networked one. `observe` reads `docker inspect` back off the
live container — `HostConfig.NetworkMode` and the attached network set, both,
because a mode that says `none` with a network attached is not `none` — and
normalises the older daemons' `default` to `bridge`. Both run scripts call
`assert` immediately after `docker run` and **exit rather than run an agent in a
container whose network is not the one the lane claims**. Both then stamp the
requested and the observed mode into `timings/<id>.json`, which is the record
every ledger row and every report downstream is derived from.

**`docker exec` still works against a `--network none` container.** It has to:
both arms are told to run the project's tests with `docker exec <container> …`,
and an arm that cannot run a test is measuring two variables. `exec` attaches a
new process to an existing container's namespaces through the daemon's unix
socket, so it needs no network of its own on either side. Measured on docker
29.4.0, 2026-08-24, and re-measured by `./network-dryrun.sh` on every run:

| in a `--network none` container | result |
| --- | --- |
| `docker exec <c> sh -c 'echo ok'` | exit 0 |
| `docker exec <c> ip -o addr` | `lo` and nothing else |
| `docker exec <c> wget -T3 http://example.com/` | exit 1, no DNS |
| `docker exec <c> wget -T3 http://93.184.216.34/` | exit 1, no route — a raw IP does not help |
| `docker inspect -f '{{.HostConfig.NetworkMode}}'` | `none` |

That last row is the one the scanner reads. This is the difference between an
environment seal and a sandbox: the environment seal had to be believed, and
its report could only count how often it was pushed on. A `--network none`
testbed produces the same evidence by construction, and the evidence is a
kernel fact recorded off the live container rather than a claim about a
transcript.

**Every lane pins its own testbed network, the way it pins effort.** The three
codex lanes ran before this existed and pin `bridge`, because re-running them
under `none` would reproduce a number under conditions their recorded rows were
never measured under. Every new lane takes the default. See
[Lanes, and the sealed one](#lanes-and-the-sealed-one).

## The flows host shell

**The flows arm's host shell is not confined, so the lane must say so.** The
prompt tells the agent to name the testbed container on every `bash` call, but
`container` is optional on a `mode: "unhermetic"` call and the flows CLI binds
no policy that refuses one without it. Such a call runs model-authored shell on
this host, with the docker socket in reach, from input that is untrusted
repository text.

`run-instance.sh` refuses to start an agent unless the lane sets
`SWB_FLOWS_HOST_SHELL=allowed`, and stamps the value into `timings/<id>.json`
as `hostShell`. `lib/fullbench-instance.sh` carries it into the ledger row
beside `testbedNetwork`. `SWB_SKIP_AGENT=1` runs no agent and needs no value.

```sh
SWB_FLOWS_HOST_SHELL=allowed ./run-instance.sh django__django-16612
```

A testbed sealed with `--network none` does not seal the host shell. A report
that states a flows lane had no network cites both fields, and a lane whose
rows lack `hostShell` ran before the field existed: its host shell was
unrestricted.

### Preflight: does any test need the network

A `--network none` testbed changes what the *agent* can run, so it has to be
validated before a lane spends a token. The concern is narrow and specific: a
test or a `conftest.py` that reaches the network at agent-side run time, which
would fail under `none` for a reason that has nothing to do with the agent.
The evaluator's own grading containers are not touched by any of this — grading
was never the hole, and moving it would change what a verdict means.

```sh
./preflight-network.sh                    # three probes, no tokens, needs docker
./preflight-network.sh --report out.json  # the same, with the machine-readable row set
```

It boots three pinned, representative instances — one django, one sympy, one
astropy — twice each: once under `--network none` and once under `bridge`. Each
boot runs that repository's own test command, from the same
`lib/test-command.py` both prompts are written from, on an **untouched** tree at
the base commit. The tree is untouched on purpose: the bug is present, so the
suite is expected to fail, and an exit code on its own says nothing. What the
probe compares is the **pair**.

| what the pair shows | verdict | what it means |
| --- | --- | --- |
| either boot or network assertion fails, or either network is unverified | `inconclusive` | the pair cannot establish whether the suite needs the network |
| same outcome under both | `ok` | the network makes no difference to this repository's suite |
| `none` carries a name-resolution or connection error the `bridge` run does not | `flagged` | the suite reaches the network; the instance is not measurable under `none` |
| `none` fails, `bridge` passes | `flagged` | same finding, read off the exit status instead |
| `none` passes, `bridge` fails | `noisy` | reported and never counted as a network finding |
| both fail the same way | `ok` | a pre-existing failure on an untouched tree, which is the normal case |

A flagged probe names every scored instance in its repository family, because
one probe stands for all of them. **If every probe is flagged the script says
`SYSTEMIC` and exits 2**, in those words and at the top of its output: a
`--network none` testbed that no repository's suite can run is not a sandbox to
tighten, it is a condition to abandon, and finding that out is the whole reason
the probe runs before the lane. One flagged probe exits 1 and names what it
costs. All clear exits 0. Any inconclusive probe exits 2 and does not count as
a probed family. The JSON report counts completed comparisons in `probes` and
setup failures separately in `inconclusive`, retaining both in `rows`.
`./network-dryrun.sh --offline` checks these setup failures, unknown network
readbacks, and ordinary suite results without Docker.

**Three probes do not cover eight families, and the report says so before it
says anything else.** The scored 43 come from astropy, django, matplotlib, psf,
pydata, pytest-dev, sphinx-doc and sympy. Three is the sample Will asked for,
on the reasoning that a `conftest.py` reaching the network is a property of a
repository rather than of an instance — but an all-clear over three families is
an all-clear over three families, so the uncovered ones are printed with their
instance counts under `not probed:` ahead of the verdict line. That the class is
non-empty is already on record: `psf__requests-1766` and `psf__requests-2317`
are excluded by name for the grading-side version of exactly this.

The knobs are the rig's usual ones: `SWB_PREFLIGHT_INSTANCES` replaces the three
pinned ids, `SWB_PREFLIGHT_TIMEOUT` bounds each suite (default 900s, and a
timeout under both conditions is `ok` rather than a finding), and
`SWB_PREFLIGHT_TEST_CMD` / `SWB_PREFLIGHT_IMAGE_CMD` stub the two halves that
need a multi-gigabyte image so `./network-dryrun.sh` can drive the real script.

### By construction, not by inspection

`compare-codex-lanes.mjs` grew a third question. It already counted the egress
commands a sealed transcript issued, the proxy refusals they produced, the
in-container fetches that got out anyway, and the `web search:` lines the proxy
never reached. It now also reads the **testbed network each run was actually
measured under**, out of the ledger row, out of the `docker inspect` the run
recorded:

```sh
node compare-codex-lanes.mjs --sealed fullbench/codex-none-manifest.jsonl \
  --logs fullbench/codex-none/logs --out fullbench/codex-none \
  --label '`r90n` (sealed, network none)' --require none
```

The lane's claim is read off its own rows and has four states. `none` when
every row says so, `bridge` when every row says so, `unrecorded` for the three
lanes that ran before the field existed, and `mixed` — which is fatal on its
own, because a lane measured under two testbed conditions is not one
measurement.

**A lane whose claim is `none` is asserted, not described.** All obligations
must hold or the report exits non-zero:

- **every row observed `none`.** A row that observed `bridge`, or that carries
  no observation at all, is named under "The testbed was not sealed" and fails
  the lane. This is the `docker inspect` value the run recorded at the moment
  it started its container, so the failure is a fact about that container and
  not an inference from a transcript.
- **zero successful egress, in every transcript.** Under `none` this is a
  redundant check, which is the point: the breach column has to come out zero
  by construction, and a non-zero one means the constraint did not hold
  somewhere the ledger did not see. Either way the lane fails and the offenders
  are named.
- **every attempted run has a transcript.** A missing transcript fails even
  when the ledger recorded `none`. Unattempted population rows owe no trace.
- **zero web-search tool lines.** Host-side web searches bypass the container's
  network setting and fail the seal independently of in-container fetches.

`--require none` applies all assertions whatever the ledger claims, so an
operator can gate a lane before reading a number out of it. Without the flag a
`bridge` or `unrecorded` lane still renders exactly as it did before: those
lanes are read back off their traces, they are reported with the hole they have,
and nothing about them is retroactively re-graded.

### One lane's seal, either arm

`compare-codex-lanes.mjs` asserts the seal as one column of a two-lane codex
comparison. `breach-scan.mjs` asks the same question of a **single lane of
either arm**, which is what a sealed *pair* of arms needs: a claim made for the
codex lane is worth nothing unless the same evidence is produced for the flows
lane, off the same patterns, in the same words.

```sh
node breach-scan.mjs --ledger fullbench/codex-none-manifest.jsonl \
  --logs fullbench/codex-none/logs --require none --out fullbench/codex-none

node breach-scan.mjs --ledger fullbench/rerun-r98/manifest.jsonl \
  --logs fullbench/rerun-r98/logs --journals fullbench/rerun-r98/journals \
  --require none --out fullbench/rerun-r98
```

It imports `egress`, `inContainerEgress`, `provedUnnetworked` and
`countedBreaches` from `compare-codex-lanes.mjs` rather than restating them, so
the two reports cannot drift apart on what counts as an attempt or a breach. The
comparison also uses `traceFailures` from `breach-scan.mjs` for the shared
missing-trace and web-search obligations. A Sealed headline requires an empty
failure list after all obligations have been checked. The
one thing that differs per arm is **where the
trace lives**: a codex run writes one transcript at `logs/<id>.run.log`, and a
flows run writes a driver log of that name plus a journal at
`journals/<id>/engine.db`, whose `flows_journal_events.payload_json` holds every
call the agent made and every result it got back. A scan that read only the
driver's log would clear every flows lane by looking in the wrong file.
Supplying `--journals` requires a non-empty instance journal; driver logs remain
diagnostics. Without `--journals`, a non-empty codex transcript is required.
Surviving diagnostics cannot satisfy either contract. See
[seal evidence](docs/seal-evidence.md) for trace states and failure reporting.

Four rules, and each is a way a scan could clear a lane it should fail:

- **the assertion reads the observation, never the request.** A lane that asked
  for `none` and ran on `bridge` fails, and so does a row that carries no
  observation at all — an unmeasured container is not a sealed container.
- **an untraced instance fails.** Scanning a missing file as the empty string is
  how a lane clears itself by losing its evidence.
- **a lane that recorded no condition is reported, not graded.** The three lanes
  that predate the field print their counts under `Verdict: not asserted`, and
  the word the sealed lanes earn is one they can never print.
- **`mixed` fails a `--require none`.** A lane measured under two testbed
  conditions is not one measurement.

`fixtures/check-breach-scan.mjs` pins all four offline, and `./verify.sh` runs
it.

#### An attempt is not an outcome

Under `--network none` this distinction is the whole report, and getting it wrong
failed the first sealed lane that ran.

`breaches` deliberately does not read a command's result. On a `bridge` lane that
is right: a `docker exec … curl` would have worked, so the attempt is the
finding. Under `none` it cannot have worked — the container has `lo` and nothing
else, which is the fact `./network-dryrun.sh` establishes against a real daemon.
On 2026-08-25 the `r90n` lane's first scan therefore reported **6 successful
in-container fetches** and a `FAILED` verdict, while every one of those six died
in the transcript on `Could not resolve host` or `Temporary failure in name
resolution`. The gate was contradicting its own premise, in a message that said
so out loud: *"which a --network none container cannot do."*

So on a container **observed** `none`, an in-container fetch is read to its
outcome, and the reading fails closed:

- a fetch the trace shows failing is the seal working, not a breach;
- a fetch with no recorded outcome is still a breach — **unless** another fetch
  in the same container is shown dying on a name that does not resolve. The seal
  is a property of the container, not of each command: `curl --silent | grep`
  prints no diagnostic and exits with `grep`'s status, so a fetch that returned
  nothing can leave no evidence at all. `sphinx-doc__sphinx-7590` did exactly
  that one second before the identical URL in the identical container came back
  `curl: (6)`;
- only a name that does not resolve or a network with no route proves that. A
  refused or unconnectable port (`Connection refused`, `curl: (7)`) clears its
  own command and nothing else: it is compatible with a working network;
- positive evidence beats the inference: a fetch in that container that printed
  anything but a failing exit status withdraws the container-level reading, and
  so does **any** `docker network connect` in the trace, which is the only way a
  running container can acquire a network. It is never granted to a container
  shown refusing nothing. A quiet trace proves nothing and is given nothing.

Refusal evidence stays within its command's bounded output window and literal
container identity. A refusal in `swb` cannot excuse a fetch in `otherbox`.
When the parser cannot identify a literal container, only that command's own
refusal can excuse it; unresolved shell expressions never share evidence.

Anywhere the container was not observed `none`, the old rule stands untouched, so
no `bridge` or unrecorded lane's report moves.

## On Smithers Cloud

`SWB_TRANSPORT=plue` runs the same rig with every testbed on a Smithers Cloud
workspace instead of this machine's docker daemon. The agent's run and its
grading each boot a workspace from the official
`swebench/sweb.eval.x86_64.*` image with `--network none`, so this host pulls no
image, extracts no testbed, and has no disk gate to wait at. It is the seam
`evals/harbor` already runs TB4 and DeepSWE on (`plue_env.py`,
`plue_docker.py`), through the public `smithers` CLI; `lib/plue.py` adds only
what a SWE-bench testbed needs beyond a Harbor trial. `docker` stays the
default and remains the transport for a self-hoster without Smithers Cloud.

```sh
. ~/smithers-bench-env/env.sh   # SMITHERS_CLI, PLUE_REPO, SMITHERS_TOKEN, PLUE_SLOTS, …
export SWB_TRANSPORT=plue SWB_ARTIFACT_ROOT=/path/outside/the/repo
./preflight.sh
SWB_FLOWS_OPENAI_AUTH=chatgpt ./run-instance.sh django__django-16612 openai:gpt-6-luna 1200
SWB_MODEL_NAME=luna-plue ./evaluate.sh luna-plue django__django-16612
```

A full wave is the same launch line with the transport exported
(`FB_DIR` outside the repository, `SWB_FULLBENCH_JOBS` workspaces in flight):

```sh
export SWB_TRANSPORT=plue SWB_SEAT=openai:gpt-6-luna SWB_FLOWS_OPENAI_AUTH=chatgpt \
  SWB_FULLBENCH_RUN_ID=luna-plue SWB_MODEL_NAME=luna-plue FB_DIR=/path/outside/fb
mkdir -p "$FB_DIR" && nohup ./fullbench.sh --resume >> "$FB_DIR/launch.log" 2>&1 < /dev/null &
```

What changes, and what does not:

| | `docker` | `plue` |
| --- | --- | --- |
| testbed | image pulled, `/testbed` extracted to `work/<id>` and bind-mounted back | workspace booted from the image; `/testbed` exists only in the guest |
| seal | `--network none`, read back off `docker inspect` | `--network none`, read back off `workspace view` **and** a guest probe that must fail to connect to `1.1.1.1:80` and `example.com:80` |
| agent's `bash` | host shell unconfined (`SWB_FLOWS_HOST_SHELL=allowed`) | sealed to the workspace (`SMITHERS_BASH_CONTAINER`), no host file flows; `hostShell: sealed` |
| file edits | host `read`/`edit`/`write` on the bind mount | `bash` in the workspace; the prompt's environment section says so |
| `test` flow | bound (`SMITHERS_TEST_*`) | not bound: its baseline worktree needs a host checkout. The prompt still names the runner |
| capture base, patch | `snapshot-base.sh` / `capture-patch.sh` on the host tree | the same scripts, uploaded to the guest and run against its `/testbed`; `strip-modes.mjs` on the host |
| grading | the official evaluator, local containers, `.grade-lock` | the official evaluator's own `run_instance` with `lib/plue.py` as its container: a second `--network none` workspace per instance, no lock |
| disk, images | 8 GiB gate, pull, `docker rmi` | none; the ledger records the image as `remote` |
| slots | `SWB_FULLBENCH_JOBS` | the same, and every workspace also holds a slot in `PLUE_SLOT_LEDGER`, shared with every Harbor run on this host |

Everything else is unchanged: the subject pin, the manifest and its resume
boundary, the per-instance archive, the verdict the driver reads out of the
evaluator's `report.json`, the scorecard, and the journal, which the CLI still
writes on the host. `timings/<id>.json` and the ledger's `pulled` row carry
`transport`.

Four rules the transport keeps:

- **A slot is held in the run's name.** `plue.py up --holder $$` queues in the
  shared ledger and holds the slot under `run-instance.sh`'s pid, so a run
  killed with -9 frees its slot. Its workspace is named
  `swb-<host>-<pid>-<run>` (`swbg-…` for a grading), and `fullbench.sh`
  starts every plue wave with `plue.py reap`, which deletes the ones this host
  made whose owner is gone. Every delete passes `--yes`.
- **The seal is measured, not assumed.** A plue guest keeps an `eth0` for its
  SSH transport and resolves public names, so "only `lo`" is not the test; a
  refused connection is. Measured 2026-09-26 in a `none` workspace: `eth0`,
  `dummy0` and `lo` present, `example.com` resolves, every connect refused.
  A workspace whose record or probe says otherwise stops the run (and the
  grading) before a token is spent.
- **psf/requests is not graded on plue.** Its graded tests need an httpbin, and
  a sealed grading workspace has none; `evaluate.sh` refuses it unless
  `SWB_NO_HTTPBIN=1`. Both instances are already excluded by name.
- **The codex arm stays on docker.** It edits the bind-mounted host checkout
  with codex's own file tools, and a workspace has no host checkout; running
  codex inside the workspace would be a different arm. `run-instance-codex.sh`
  refuses `SWB_TRANSPORT=plue`, so a plue flows lane compared with a codex lane
  compares two transports as well as two harnesses, and says so.

First measured 2026-09-26 (issue #2088), with `openai:gpt-6-luna` on the
ChatGPT seat, two jobs, sharing the ledger with a live Harbor run:

| check | astropy__astropy-8707 | django__django-16612 |
| --- | --- | --- |
| gold patch graded on plue | resolved (tests 10 s) | resolved (tests 36 s) |
| Luna run on plue: patch, seal, host shell | 837 B, `none`, `sealed` | 643 B, `none`, `sealed` |
| graded on plue | resolved | resolved |
| driver wall, including the slot wait | 273 s | 578 s |

`regen-patch.sh` re-derives a patch from a surviving host workspace and has
none to read on plue: the workspace is deleted the moment its patch is
captured.

Knobs: `SWB_PLUE_CPUS` (default 2, one ledger slot), `SWB_PLUE_MEMORY_MB` and
`SWB_PLUE_DISK_MB` (plue's defaults, 4096 and 2048 on 2026-09-26, when unset).
`fixtures/check-plue-transport.py` pins all of the above against a fake CLI
whose guest is a temporary directory, and `./verify.sh` runs it.

## The prompts

`lib/write-flow.mjs` writes the flows prompt and `lib/write-prompt-codex.mjs`
writes the codex one. **They differ only where they name a harness's own tools.**
Anything else one side is told and the other is not is a variable the comparison
does not control, and it shows up in the score as if it were harness quality.

The flows-only lines are the frontmatter, the `write`/`read` flows, and the
Jujutsu colocation the flows CLI creates in its own workspace and the codex
workspace never has. `fixtures/check-prompts.mjs`, in `verify.sh`, lists them and
asserts that the set of lines one prompt has and the other does not is exactly
that list — so a sixth line, or a shared line dropped from one side, fails
offline instead of moving a baseline quietly. It also asserts that neither prompt
names `FAIL_TO_PASS`, `PASS_TO_PASS`, the graded test identifiers, or the gold
patch, with all of them present in the synthesised instance row both writers are
handed.

**The repository's test command goes to both sides.** It comes from the pinned
evaluator's `MAP_REPO_VERSION_TO_SPECS` through `lib/test-command.py`, which
refuses to print a command naming the graded identifiers, and it is environment
teaching of the same kind as "run it in the container": `./tests/runtests.py`
for Django, `tox` for Sphinx, `pytest -rA` elsewhere.

> **Disclosure — codex baselines before 2026-08-21.** From 2026-08-19 the flows
> prompt named that runner and the codex prompt still told its agent to verify
> with `python -m pytest`, which neither Django nor Sphinx can run. Waves 10 and
> 11 therefore compared a harness that could check its work against a baseline
> that could not, on two of the five sample instances, and the rig said nothing.
> Codex numbers for `django__django-16612` and `sphinx-doc__sphinx-11445` from
> those waves are not comparable and a write-up that quotes them owes this
> sentence. Both sides derive the command from `lib/test-command.py` now, and the
> next codex wave is the first one the head-to-head number holds for.

## Reasoning effort

**Reasoning effort is a benchmark condition and both arms state theirs.**
`SWB_CODEX_EFFORT` pins the codex side and defaults to **`high`**;
`run-instance-codex.sh` passes it as `-c model_reasoning_effort=<value>`, writes
it into `timings-codex/<id>.json`, and codex echoes it into the first lines of
its own transcript (`reasoning effort: <value>`), so a run's effort is readable
off the artifact and never inferred. The accepted values are `minimal`, `low`,
`medium`, `high` and `xhigh`; anything else is refused before the image is
pulled.

The flows arm has no equivalent knob in the rig because it has no equivalent
choice: `effortFor` in `packages/smithers/agent/src/AgentSession.ts` returns the flow's
`effort:` frontmatter, then the host's option, then `high`, and
`lib/write-flow.mjs` writes no `effort:` line. Every flows wave has therefore run
at high.

> **Disclosure — every codex number before 2026-08-23 is effort-confounded.**
> The codex side was pinned to the literal `medium` from 2026-08-19, under a
> comment claiming medium matched what our harness got as an API default. Our
> harness never took an API default; it defaulted to high, and it did so before
> wave 1. All 45 transcripts in `fullbench/codex/logs/` and all 45 in
> `fullbench/codex-sealed/logs/` carry `reasoning effort: medium`, so the `r90c`
> and `r90s` columns measure medium-effort codex against high-effort flows.
> Effort is not a harness property, so the difference lands in the score as if it
> were one, in an unknown direction and by an unknown amount. **No flows-vs-codex
> claim may be quoted off `r90c` or `r90s` without this paragraph.** Will ruled
> on 2026-08-23 that the codex arm re-runs at high; `codex-backfill.sh --lane
> sealed-high` is that re-run, and the two older lanes keep their pinned `medium`
> so they still reproduce.

## Patch capture

**The captured patch holds what the agent changed and nothing else.** Both run
scripts record a *capture base* right after extracting the testbed and before
anything of ours touches it (`lib/snapshot-base.sh`, kept in the workspace as
`refs/flows/capture-base`), and capture the patch against that
(`lib/capture-patch.sh`), never against the instance's base commit. Two
contaminants are excluded at the source rather than edited out afterwards:

- **What the official image already changed.** The images mutate tracked files
  in their `pre_install` step — `sphinx-doc__sphinx-11445` seds `-rA` into
  `tox.ini`. Diffed against the base commit that churn is reported as the
  agent's work, and it does not merely inflate the patch: the evaluator's
  container already carries it, so `git apply` fails on the whole patch and the
  `patch --fuzz=5` fallback reads the already-applied hunks as a reversal and
  **un-applies the real fix**. That defect decided the sphinx verdict in waves 2,
  3 and 4, on both harnesses. The capture base contains the churn, so it cancels.
- **Files that did not exist when the agent started.** The flows durability
  snapshot writes the whole working tree into git's index, so agent scratch is
  tracked by capture time; wave 3 shipped `.tmp_init_collect_repro/` with an
  `assert False` in it. Capture restores a private index to the capture base, which
  drops them — and that is the same set the codex path never had in its index,
  so both harnesses are captured under one rule. Whatever is dropped is listed
  in `patches/<id>.patch.untracked`; read it when a run was supposed to add a
  file.

Normalising the modes falls out of the same restore: the patch is expressed in
the image's own permission bits, so the executable-bit churn that `docker cp` to
the host and the colocated jj snapshot introduce never appears.

**The testbed's Git configuration is untrusted.** The image supplies `.git`,
and the container can rewrite it. Both scripts use `lib/capture-git.sh` to run
host Git with an empty environment apart from the host executable path and
explicit capture settings. A temporary Git directory outside the bind mount
shares only the task's objects and refs, copies `HEAD`, packed refs and ignore
patterns, and uses a private index. Snapshot copies the image's index into it;
capture rebuilds it from the capture base. The task's index is left unchanged.
The capture-base commit and ref still live in the task repository for callers
and later patch regeneration.

No repository, global or system configuration is loaded, including config
includes and custom filter definitions. Hooks, fsmonitor and global attributes
are disabled. Diff also passes `--no-ext-diff --no-textconv` and ignores
submodules to avoid entering their repositories. Repository attributes cannot
enable configured helpers in this environment. This boundary prevents Git
configuration from executing host commands; it does not authenticate the
container-writable objects, refs or file contents.

Two ways to check it, neither of which spends a token:

```sh
./verify.sh                                              # offline, no docker
SWB_SKIP_AGENT=1 ./run-instance.sh sphinx-doc__sphinx-11445   # docker, no agent
```

`verify.sh` replays both contaminants over throwaway git repositories shaped
like the official images (`fixtures/check-capture.mjs`). The same fixture installs
hostile diff, textconv, filter, fsmonitor and hook settings before snapshot and
capture, checks config includes and environment overrides, and asserts that no
host helper runs and the patch still contains exactly the agent's edit.
`SWB_SKIP_AGENT=1`
builds the real workspace, runs no agent, and captures: **the patch must be
empty.** It rebuilds `work/<id>/`, so do not point it at a workspace whose
journal is still wanted, and it writes no timings stamp because no run happened.

`regen-patch.sh <id>` re-captures from a surviving workspace. It refuses a
workspace with no capture base instead of falling back to the base commit.

The Codex runner returns the capture helper's failing status, retains
`work-codex/<id>[-<index>]/`, and writes
`logs-codex/<id>[-<index>].capture-failed` with the status, workspace and patch
paths. A successful capture that publishes no patch file fails with status 1.
Retry `lib/capture-patch.sh <workspace> <patch> ':(exclude)AGENTS.md'` against
the retained checkout; restarting the runner replaces that checkout. Successful
empty patches remain valid results and keep their workspaces for inspection.
Only a successful non-empty capture permits workspace deletion.

Both runners remove their extraction and testbed containers and release their
owned extraction lock on exit, SIGINT or SIGTERM. Signal handlers terminate the
runner after cleanup. The testbed checkout is bind-mounted from the workspace,
so container removal preserves retained edits. `fixtures/check-codex-lanes.mjs`
checks capture failures and interrupted acquisition with command doubles.

**Deliberately not changed: what the agent is told.** `lib/write-flow.mjs` still
tells the agent to review its own work with `git diff <base commit>`, so on an
image with `pre_install` churn the agent sees a file it did not touch. Pointing
it at `refs/flows/capture-base` would be more honest and would remove any
incentive to "clean up" that file — but it is prompt text, and changing prompt
text mid-drive confounds the wave-to-wave comparison the drive exists to make.
Decide it as a wave change, not as a side effect of a capture fix.

## Wave arming gate

The gate has two halves: the subject the wave loads, and the discipline that
subject arms. Pin the subject with `./preflight.sh` (above) before anything
else; a wave that cannot say which harness it ran cannot report an arming
either.

Before spending tokens on the rest of a wave, run and grade its first flows
instance, then inspect that workspace's journal for exactly one
`control.agent.discipline-armed` event per run. Its payload is the positive
record of the discipline configured at run start: `readOnlyCap` must be nonzero,
and `maxFrames`, `modelCallMs`, `repeatCap`, `narrowingCap`, `unmovedCap`,
`unresolvedCap`, plus every armed
sandbox limit (`calls`, `memoryBytes`, `steps`, `timeMs`, `callMs`, and
`totalMs`) must match the wave's intended budgets. Stop the wave if the event is
absent or the values are wrong.

Gate on this event rather than on `control.agent.read-only-demanded`. The demand
event proves an armed cap was reached, not merely armed; a run that writes early
and often correctly has no such event.

`modelCallMs` is the one armed budget a report can grade without any further
instrumentation, because `control.agent.model-settled` already carries
`durationMillis` for every call. Read the two together: no settled call may
exceed the armed ceiling, and a call that reached it appears as a
`control.agent.model-retried` event coded `call_timeout` followed by a second
attempt. Wave 7 is the reason the budget exists — one 667,067 ms call on
`pytest-dev__pytest-6197` spent 55% of that run's wall clock and produced a cell
that raised on its first property access — so a wave whose longest
`durationMillis` sits near the ceiling is reporting a real finding, not noise.
One overrun costs at most one re-issue, so the most model time a single sealed
step can spend is twice `modelCallMs`; a report that adds up more than that on
one step is reading a bug, not a budget.

`repeatCap` is armed the same way and read from
`control.agent.repeat-demanded`, which is journaled when the demand is *issued*
rather than when it is answered. Zero demand events with a nonzero `repeatCap`
is a wave whose runs never spent four consecutive frames re-asking questions
they had already answered, which is the intended reading; zero with `repeatCap:
0` says the control was never armed at all.

`narrowingCap` is armed the same way and read from
`control.agent.narrowed-demanded`, also journaled when the demand is issued. It
is the one control that acts on a completion rather than on a stall, so it fires
at most once per run and usually not at all: a wave with zero demand events and
a nonzero `narrowingCap` is a wave whose runs each re-ran their broad check over
the tree they submitted, and zero with `narrowingCap: 0` says nothing was ever
asked. Each event carries both inputs and both workspace digests, so a report
can second-guess the demand from the journal without replaying the run.

`unmovedCap` and `unresolvedCap` are the other two controls that act on a
completion, armed the same way and read from `control.agent.unmoved-demanded`
and `control.agent.unresolved-demanded`. Both are journaled when the demand is
issued and both fire at most once per run.

`unmoved-demanded` carries the digest the run opened on and the digest its
completing frame closed on, which are equal by construction; reconcile them
against the run's own `control.agent.mutation-observed` events, which say the
same thing frame by frame. Wave 9's `django__django-16612` is the recorded case:
seven frames, eleven calls, no editing call of any kind, one digest throughout,
a zero-byte patch, and a completion describing an edit.

`unresolved-demanded` carries the failing check and the reading the run took in
its place, both over the digest the frame closed on. It is not a rule about
failing checks: wave 9's `astropy__astropy-8707` **resolved** after a post-edit
broad check reported two failures, because it never went back to what that check
covered. The demand fires only where the run itself returned to the same
subject with a different command, which is wave 9's `pytest-dev__pytest-6197` —
`pytest -rA testing/python/collect.py` at seq 394 reporting "2 failed, 72
passed", then four named cases out of that file at seq 429 reporting "4 passed",
then `complete`.

When one completing frame trips more than one of the three, only the first is
issued, in the order `unmoved`, `unresolved`, `narrowed`: descending order of
how fundamental the missing thing is. A journal therefore never carries two
completion demands at one `transition-applied`, and never carries one at the
frame a demand was handed to: every demand ends by promising that what comes
back next is the answer that stands, so the frame written to answer one is not
judged again. A run bounced once and then bounced again for a different reason
would spend two frames and two model calls arguing about one decision, and the
second demand is dropped rather than issued.

A demand is also not issued when the read-only cap holds the frame it would
reserve. The two controls meet on the same runs — a run whose tree never moved
has a read-only streak as long as its life — and a completion one frame short of
twice `readOnlyCap` would be bounced, spend that frame reading, and end as a
`read_only_cap` failure carrying nothing. So a wave that arms a low
`readOnlyCap` will see fewer `unmoved-demanded` events than its runs' digests
suggest, and none of them are missing: the demand is a frame the run has to
have.

For the wave report, read `control.agent.read-only-demanded` directly. Each
event records the streak and configured cap that triggered the intervention,
the following frame number, and whether that frame wrote, justified continued
diagnosis, stayed read-only, or parked. Count these events rather than
reconstructing the intervention from transitions and call ordering.

**Zero demand events is not evidence that the cap is dead.** Read them together
with `control.agent.transition-applied`. A transition that carries a
`justification` on the frame where the streak reaches the cap satisfies the
demand before it is issued: `CellTurn` suppresses the pending demand, grants
`readOnlyCap` quiet frames, and journals nothing. Wave 6's
`pytest-dev__pytest-6197` is the recorded case — an earned twelve-frame streak,
`readOnlyCap: 12` armed, no demand event, and frame 11's transition carrying an
unsolicited justification. The cell contract asks for a justification only when
the harness has asked for one; the model volunteers them anyway, on roughly a
third of frames. So a wave report that finds no demand events must state which
of the two it observed:

- no run reached the cap (read the longest no-mutation streak from
  `control.agent.mutation-observed`), or
- a run reached it and a justification pre-empted the demand.

To tell a live control apart from a dead one without waiting for a wave:

```sh
./readonly-liveness.sh                 # ~$0.30 in tokens, no docker, no dataset
```

It builds a throwaway workspace whose flow reads one file per frame, forbids
`justification`, and stops on the demand text, then asserts the journal contains
`control.agent.read-only-demanded` and prints the streak, the cap, the
justification count and the run's own cost. Run it after any change to
`CellTurn`, to the CLI composition, or to the seat resolver. Recorded result on
`aefd3b39d`, `CellTurn.ts sha256:a834c2fd…`: **one demand event**, `streak=12
cap=12 nextFrame=12 nextAction=read-only`, 13 frames, 0 justifications, 57,067
input and 1,319 output tokens, $0.3249.

The probe spends tokens, so its verdict cannot be re-run to settle an argument;
the reading that turns a journal into that verdict can be.
`fixtures/check-liveness-report.mjs`, in `verify.sh`, replays
`lib/check-liveness.mjs` over synthesised journals and pins all four answers —
fired, INCONCLUSIVE below the cap, FAILED naming a justification, and FAILED
with nothing to blame — plus the streak arithmetic that a write clears.

## Evaluate

Grading is the unmodified official harness, never our own judgement of a patch:

```sh
./evaluate.sh r1 astropy__astropy-8707 django__django-16612 pydata__xarray-7393
HARNESS=codex ./evaluate.sh r1-codex astropy__astropy-8707
```

It writes `preds-<run-id>.json` and the evaluator's own
`<model-name>.<run-id>.json` report into this directory.

It reads `patches/` (or `patches-codex/` with `HARNESS=codex`) under
`SWB_ARTIFACT_ROOT` when that is set, derived by `lib/run-paths.sh --roots`, so
a wave run off the checkout is graded where it was written. A requested
instance with no patch file refuses the whole grading and names each missing
path: a missing file is a run that never finished or a directory the run did
not write to, never an empty prediction. A 0-byte patch file is an empty
prediction, graded `empty patch` — the agent changed nothing. Every writer
(`run-instance.sh`, `run-instance-codex.sh`, the full-benchmark archives,
`select-candidate.mjs`) writes the file, empty or not, once a run finishes.
`SWB_PREDS_ONLY=1` writes the predictions file and stops before grading.
`fixtures/check-make-preds.mjs`, in `verify.sh`, pins all of it.

`SWB_EVAL_WORKERS` sets the evaluator's concurrency (default 1; raising it loses
the report — see the script). `SWB_CACHE_LEVEL` sets `--cache_level` (default
`env`, which deletes each official instance image once it is graded); use
`instance` for a supplementary grading that should leave the image cache as it
found it. `SWB_EVAL_TIMEOUT` sets the evaluator's per-instance timeout (default
1800 s, the official one). One repository needs more: `psf/requests`'
`test_connection_error` is hardcoded to `http://httpbin.org:1`, whose SYN packets
are dropped rather than refused, so it sits in TCP retransmit against every A
record the name resolves to before raising the `ConnectionError` it asserts —
over 17 minutes on 2026-08-21, from a suite whose other 142 tests take seconds.
It is an environment cost, identical for both arms and for any patch.

Three overrides exist for the best-of-n matrix, where one instance has n patches
and the evaluator's predictions can only ever be keyed by instance id:
`SWB_PATCH_SUFFIX=-r3` grades `<id>-r3.patch` as `<id>`'s prediction,
`SWB_PATCHES=selected` grades a different directory (absolute, or relative to
this one; the full benchmark passes its archive's absolute path, so `FB_DIR`
may sit outside the rig), and `SWB_MODEL_NAME`
changes the name the report is filed under. `grade-matrix.sh` drives all three.

### Supervisor replay

```sh
node lib/jev-replay.mjs fullbench/rerun-r97/journals --manifest fullbench/rerun-r97/manifest.jsonl --suffix -r97
node lib/jev-replay.mjs <journals-dir> --manifest <manifest.jsonl> --dry-run     # snapshots only, no spend
```

The harness asks Jev about a run's shape once per frame, off the cell loop's
hot path: whether it is thrashing, still on the task, standing on suspect
evidence, carrying outdated or irrelevant context, five scored operational
states (`frustrated`, `anxious`, `scared`, `confused`, `confident`, each
`none`, `mild` or `strong`) and `needs_help`. Before any of that is allowed to
nudge a model, this replay rebuilds the same snapshot from each archived
journal (through `lib/journal-facts.mjs`, so the counts are the counts the run
had), for exactly the frames the live supervisor is offered, asks the same
classifier, and scores against the manifest's verdicts. Positive predicts
`unresolved`. `crossed` is the live nudge rule, `Supervisor.crosses`, imported
rather than copied, and each of its five triggers (`thrashing`, `off_target`,
`suspect`, `outdated_context`, `irrelevant_context`) is scored on its own. Each
signal is scored twice, on the last frame's reading and on any frame's, with
precision, recall and F1; a per-instance table follows with the last reading
and the extremes across frames. Readings Jev could not give are counted by
reason and never scored as calm. It needs `AI_GATEWAY_API_KEY`; `--dry-run`
builds the snapshots and asks nothing, and `--limit N` bounds the journals
read. `fixtures/check-jev-replay.mjs` runs the dry run over a synthetic
journal inside `./verify.sh`.

The same run also replays the journal's gates, which needs no Jev call and
happens even under `--dry-run`. For relevance, each `relevance/unnecessary`
decision is re-thresholded, and the withheld rate is shown per item kind at
0.8, 0.9 (the live `withholdAt`) and 0.95. For each monitor, it shows the
crossing rate, the delivered rate (deliveries per crossing), the suppression
reasons and the delivered-then-resolved rate. A delivery counts as resolved
when, within 3 frames, a check newly passes or `on_target` rises. Every
supervisor reading is also checked to confirm that `Monitor.lint` scores it
exactly as `Supervisor.crosses` does. `fixtures/jev-gates-journal.json` is the
synthetic journal that pins these numbers. `scorecard.ts` records the same rows
as counts only.

### Two rig faults the r90 benchmark found, and what closes them

A verdict is a statement about a patch **and** about the rig that graded it. The
r90 full benchmark produced six verdicts that were statements about the rig
alone, and both causes are now closed in `lib/grade.py`. The evaluator's own
code, dataset and grading logic still run untouched; what changed is what the
rig does around it.

**One grading deleted another grading's image.** The evaluator's post-run
`clean_images` removes, at `--cache_level env`, every `sweb.eval.*` image that
was not on the daemon when *that* process started — not only the instance it
graded. This rig runs the benchmark as concurrent per-instance workers; grading
is serialized by `.grade-lock` but pulling is not, so worker B's `docker pull`
routinely lands inside worker A's evaluator process, and A deletes it on the way
out. B then grades against nothing and the ledger records `eval error`:

```
docker.errors.ImageNotFound: 404 ... No such image: sweb.eval.x86_64.django_1776_django-12741
```

That is verbatim what `django__django-12741`, `django__django-13406`,
`django__django-15380` and `matplotlib__matplotlib-22865` recorded, and it
reproduced live on `astropy__astropy-7166` during the 2026-08-21 codex backfill.
`lib/grade.py` now scopes the cleanup to the instances the invocation was asked
to grade, by adding every other instance's eval image to the evaluator's
"existed before" set. It removes no image the evaluator would have kept, and
keeps none it would have removed, for the instances it graded.

**The psf/requests family was graded against a dead httpbin.** Those tests are
network tests: `test_requests.py` reads
`HTTPBIN = os.environ.get('HTTPBIN_URL', 'http://httpbin.org/')`, and roughly a
third of the dataset's graded identifiers for `psf__requests-1766` and
`psf__requests-2317` route through it. On 2026-08-21 the public service answered
**503** — `assert 503 == 200` in the logs, not a connection error — failing 8 of
8 and 6 of 6 `FAIL_TO_PASS` tests and 34 and 22 `PASS_TO_PASS` tests. A
`PASS_TO_PASS` test failing indicts the environment by construction: it passed on
the unmodified checkout when the dataset was built.

So a grading that includes any `psf/requests` instance now begins with
`lib/httpbin.sh resolve`, which states which service it will use:

| in order | what it means |
| --- | --- |
| `SWB_HTTPBIN_URL` | an endpoint the operator named; their rig, their call |
| the public `httpbin.org`, when it answers 200 over **both** http and https | the service the dataset's tests name and the official evaluation uses |
| the rig's own `kennethreitz/httpbin` container, on the same docker bridge the evaluator uses | the deterministic fallback, **degraded** and loudly labelled |

The chosen URL is exported as `HTTPBIN_URL` inside that instance's `eval.sh`,
after `set -uxo pipefail` and before the evaluator's first command, so it is
visible in the archived `eval.sh` and in `test_output.txt`. It applies to
`psf/requests` only and to whichever harness produced the patch, so both arms
are graded under one rig.

The fallback is labelled degraded for a measured reason. The suite asserts both
schemes against the same host:

```python
def test_mixed_case_scheme_acceptable(self):
    parts = urlparse(httpbin('get'))
    for scheme in ['http://', 'HTTP://', ..., 'https://', 'HTTPS://', ...]:
        assert s.send(requests.Request('GET', scheme + parts.netloc + parts.path).prepare()).status_code == 200
```

and `requests` verifies certificates. A container on a private bridge address
cannot present a certificate this checkout's `requests` trusts, and making the
graded container trust one would be a change to the grading environment far
larger than the outage it works around. Measured on `psf__requests-1766`: against
the 503 outage, 0 of 6 `FAIL_TO_PASS` and 57 of 79 `PASS_TO_PASS`; against the
local fallback, **6 of 6 and 78 of 79**, the one failure being
`test_mixed_case_scheme_acceptable`. So the fallback recovers everything that
speaks `http://` and cannot recover the rest — which is why the public service is
preferred whenever it is whole, and why an `unresolved` produced under the
fallback is reported as a rig result rather than a patch result.

`SWB_NO_HTTPBIN=1` skips the check entirely and lets the suite use its own
default, which is what r90 did.

### What re-grading r90 recovered, 2026-08-22

Every one of the six was the rig. The agent side is untouched — same patches,
same journals, no second attempt — and the flows baseline the re-run is measured
against is **35/45 resolved, not 29/45**, at the same $37.84 and 17,106 s.

| instance | r90 verdict | why | re-graded |
| --- | --- | --- | --- |
| `django__django-12741` | eval error | image deleted mid-flight | **resolved** |
| `django__django-13406` | eval error | image deleted mid-flight | **resolved** |
| `django__django-15380` | eval error | image deleted mid-flight | **resolved** |
| `matplotlib__matplotlib-22865` | eval error | image deleted mid-flight | **resolved** |
| `psf__requests-1766` | unresolved | httpbin 503 | **resolved** |
| `psf__requests-2317` | unresolved | httpbin 503 | **resolved** |

`sphinx-doc__sphinx-7590` stays `empty patch`: the agent produced no diff, which
is a fact about the agent and is not re-gradeable.

The codex arm was completed in the same session — 16 instances back filled to
45/45 — and its own seven `eval error` verdicts, from the same image-cleanup
race, re-graded to `resolved`. `matplotlib__matplotlib-22865` is worth naming:
`analysis/PROGRAM.md` predicted it would stay failed because "the run never
completed", and the patch its 36-frame run left on disk in fact grades resolved.
The prediction was wrong in our favour, and both arms resolve it.

### Re-grading a verdict the rig got wrong

```sh
./regrade.sh --reason "<why the first verdict was the rig's fault>" <instance_id> ...
HARNESS=codex ./regrade.sh --reason "..." <instance_id> ...
```

`regrade.sh` re-grades an **already-collected** patch and cannot become a second
attempt: it runs no agent, spends no tokens, reads only the patch archived under
`fullbench/patches/`, refuses an instance with no patch on disk, and refuses an
empty one ("the agent changed nothing" is a fact about the agent, not the rig).
`--reason` is required — a verdict that changed with no recorded reason is not
evidence.

Per instance it claims the id, gates on disk, pulls the image if it is not
already local, moves the superseded evaluator log directory aside to
`<id>.superseded-<epoch>` (the evaluator skips any instance that already has a
`report.json` under the run id, and the old `test_output.txt` is the evidence for
the re-grade, so it has to move and must not be deleted), grades under the shared
`.grade-lock`, appends a fresh `graded` row carrying `regrade` and `supersedes`,
and deletes the image only if this call pulled it. The ledger stays append-only:
the fold takes the last row, so the scoreboard reads the new verdict while the
row it replaced is still in the file.

Two instances of one image are one image, so a re-grade refuses an instance the
*other* arm is running right now — on 2026-08-21 a re-grade and a codex backfill
overlapped on `django__django-13406` and `django__django-15380` and each deleted
the image the other was about to grade against.

## Best-of-n

A single-attempt number says what a harness did once. It does not say whether it
would do it again, and waves 3 through 11 have shown the same instance resolving
in one wave and shipping an empty patch in the next. This is the protocol for
measuring the other thing: **n attempts per instance on both harnesses, and one
submission per instance chosen from the runs' own records.**

```sh
./preflight.sh                       # pin the subject, once
./run-matrix.sh flows 5 3            # 5 attempts of each instance, 3 at a time
./run-matrix.sh codex 5 3            # the same on the other side
./grade-matrix.sh w12 all 5          # select, then grade all three groups
node matrix-report.mjs --prefix w12  # the report
```

### Per-run artifacts

Every artifact name comes from `lib/run-paths.sh`, which both run scripts and the
matrix driver derive their names from, so the two harnesses cannot drift apart:

| | no run index | run index `r3` |
| --- | --- | --- |
| flows workspace | `work/<id>` | `work/<id>-r3` |
| flows patch | `patches/<id>.patch` | `patches/<id>-r3.patch` |
| flows timings | `timings/<id>.json` | `timings/<id>-r3.json` |
| flows logs | `logs-agent/<id>.*` | `logs-agent/<id>-r3.*` |
| flows container | `flowsbench-<id>` | `flowsbench-<id>-r3` |
| journal archive | `journals/<id>/` | `journals/<id>-r3/` |
| codex workspace | `work-codex/<id>` | `work-codex/<id>-r3` |
| codex patch | `patches-codex/<id>.patch` | `patches-codex/<id>-r3.patch` |
| codex timings | `timings-codex/<id>.json` | `timings-codex/<id>-r3.json` |
| codex logs | `logs-codex/<id>.*` | `logs-codex/<id>-r3.*` |
| codex container | `codexbench-<id>` | `codexbench-<id>-r3` |

**No index is today's names**, so `regen-patch.sh`, `scorecard.ts --work work`
and every wave report that quotes a path keep working. A run still *has* an
index — `r1` when none was given — because the matrix manifest and every log
line are keyed by `<id>-<index>` and a nameless run could be recorded in
neither.

An index is `r<digits>` with an optional lowercase tag. Digits alone are a matrix
round; a tag names a **lane** over the same instances, which is what the full
benchmark's `r90` and the codex backfill's `r90c` are. Everything that reads a
round — `select-candidate.mjs`, `fixtures/rehydrate-journals.mjs` — keeps its own
stricter `r<digits>` rule, so a tagged lane's artifacts are never mistaken for an
attempt in a best-of-n draw.

The helper validates each whole instance and index argument and rejects CR or LF
before emitting output. Instance ids match `<repo>__<issue>` with ASCII letters,
digits, `.`, `_` and `-`, starting each part with a letter or digit. Every output
assignment uses Bash shell escaping (`printf %q`) for the runners' `eval`.

Every root in the table hangs off this directory unless `SWB_ARTIFACT_ROOT`
names another one, in which case the whole set moves there and the names inside
it are unchanged. It is honoured only when set, so a wave that does not set it
derives what it always did, and it must be an existing absolute directory: a
relative root would resolve against whichever directory a run script was started
from, and a misspelled one would scatter a wave instead of stopping it. Container
names are docker names rather than paths and do not move. It exists so a test can
drive this derivation without writing into the artifacts of the checkout it runs
in — `fixtures/check-matrix.mjs` replays the scheduler over fixed stub instance
ids, and two of those replays at once would otherwise write, measure and delete
one another's `patches/stub__*.patch`.

The readers follow it too: `evaluate.sh` and `grade-matrix.sh` take their roots
from `lib/run-paths.sh <harness> --roots`, which prints only the root keys, so a
wave run under `SWB_ARTIFACT_ROOT` is selected and graded where it was written.

The journal archive carries the **patch's** suffix rather than the run index, so
the journal and the patch a selection is made from always come from one run. Key
the archive by the index instead and a hand run, whose patch is `<id>.patch`,
overwrites the archive belonging to `<id>-r1.patch` — after which the selector
ranks a journal against a patch another run wrote and nothing says they came
apart.

`fixtures/check-run-paths.mjs`, in `verify.sh`, pins the whole table, proves five
rounds name five distinct sets on both sides, proves an artifact root elsewhere
moves every path and no identifier, and proves the run scripts derive their names
from that one file rather than spelling them again.

### Disk

Two things bound a matrix, and they are bounded by different numbers.

**The host disk holds workspaces, and `jobs` bounds it.** A flows run now
archives its journal to `journals/<id>-<index>/` right after the patch is
captured — `engine.db` and its write-ahead log — and then, if it was given a run
index, deletes the extracted testbed. Everything downstream reads the archive:
the selector, and any later forensics. A run *without* an index keeps its
workspace, because `regen-patch.sh` re-derives a patch from it and the
scorecard's default `--work work` reads its journal in place;
`SWB_KEEP_WORKSPACE=1` keeps a matrix run's workspace for debugging and
`SWB_DELETE_WORKSPACE=1` deletes an unindexed one. A codex run deletes its
workspace after a successful non-empty capture and retains it otherwise.

Measured on the current five-instance sample, post-run, on this machine:

| instance | workspace | of which `.git` | journal |
| --- | --- | --- | --- |
| `astropy__astropy-8707` | 127 MB | 40 MB | 6.4 MB |
| `django__django-16612` | 162 MB | 96 MB | 1.2 MB |
| `pydata__xarray-7393` | 33 MB | 14 MB | 7.4 MB |
| `pytest-dev__pytest-6197` | 25 MB | 15 MB | 3.4 MB |
| `sphinx-doc__sphinx-11445` | 72 MB | 44 MB | 2.4 MB |

So a 25-run flows matrix at `jobs=3` peaks at three live workspaces — **at most
3 × 162 MB ≈ 0.5 GB** — plus 25 archived journals at up to 7.4 MB each, about
0.2 GB, plus patches in kilobytes. Under 1 GB, and flat in the number of rounds.
Keeping all 25 workspaces instead would be 5 × 419 MB ≈ 2.1 GB and would grow
linearly with the round count and with the sample.

**The docker VM holds images, and the sample size bounds it — not `jobs`.** The
matrix is round-major, so every instance's image is used in every round and all
of them stay warm for the whole matrix whatever the concurrency is. Measured
with `docker system df -v`: the five official images report 2.68–4.67 GB each
and share a 1.4 GB base, for **12.0 GB resident** (10.5 GB unique + 1.5 GB
shared). Adding the workspace and journal peak above, a 25-run flows matrix on
this sample is about **12.7 GB resident, inside a 16 GiB budget** — and the term
that would have broken it is the one the deletion removes, because it is the only
term that grows with the round count. A container's own writable layer is
negligible: the testbed is bind-mounted from the host, not copied into the image.

The extraction itself stays serialized by `run-instance.sh`'s existing lock, so
the disk-bandwidth spike is one `docker cp` at a time however many runs are in
flight.

### The driver

```sh
./run-matrix.sh <flows|codex> <count-per-instance> <jobs> [timeout-seconds]
```

It schedules `count × instances` runs — the sample's first `SWB_SAMPLE_COUNT`
draws, 5 by default — and enforces two rules:

- **`jobs` runs in flight, no more**, the same bound `run-sample.sh` applies and
  for the same reason: concurrency buys overlap on the model-bound agent runs,
  not on the extraction.
- **Never two simultaneous runs of one instance.** They would share an image and
  an image cache, so the second would report a warm pull the first paid for; and
  each live run of an instance holds a testbed, so running an instance's five
  attempts back to back would put five of one repository's workspaces on disk at
  once. The schedule is round-major — every instance's r1, then every
  instance's r2 — and a run waits on its own instance's previous attempt.

It does not stop on a failing run: a timeout is a result the matrix is
measuring. Every run's exit status, patch size and wall clock lands in
`matrix-<harness>.json`, sorted by instance and round rather than by finishing
order.

`fixtures/check-matrix.mjs`, in `verify.sh`, replays the scheduler with
`SWB_RUN_CMD` pointing at a stub that records its own start and end. It asserts
from that ledger that the two rules held, that the driver did overlap runs at
all, and that the manifest it wrote agrees with what the runs actually did — no
docker, no model, no tokens. Its stub instance ids are fixed, so it runs under an
`SWB_ARTIFACT_ROOT` of its own and asserts the checkout's artifact roots are the
same before and after: two verification runs at once, or one beside a live wave,
never share a patch.

It runs the scheduler twice, because one pass cannot check both rules. With three
instances and two jobs the concurrency bound already serializes an instance's
rounds, so deleting the same-instance wait leaves that schedule unchanged and the
pass green. The second pass is one instance and three jobs, where the only thing
that can keep two rounds apart is the rule itself, and the ledger has to read
`S r1 E r1 S r2 E r2 S r3 E r3`.

### The selector

```sh
node select-candidate.mjs <instance_id> [--journals dir] [--patches dir] [--out dir]
```

**The selector must never read evaluator output**, and its header says so. A
best-of-n number is only a number about the harness if the choice among the n
runs is made from what the harness itself recorded; a selector that peeked at the
official report — or at the dataset's `FAIL_TO_PASS` list — would be reporting an
oracle, and an oracle says nothing about whether a run can tell its own work is
finished.

The rule is enforced by what the program can name. It takes an instance id and
three **directories**, and every file it opens is derived from the id and a run
index: `journals/<id>-<rN>/engine.db` and `patches/<id>-<rN>.patch`. The
evaluator's reports are `<model-name>.<run-id>.json` at the rig root, and no
argument, flag or code path here can name one. An unrecognised flag is refused
rather than ignored.

It ranks candidates on four predicates, each read back off the journal through
the harness's own modules rather than re-implemented — `lib/journal-facts.mjs`
rebuilds the controller's per-frame state from the event stream and asks
`NarrowedCheck`, `Sufficiency`, `UnresolvedFailure` and `UnmovedTree` the same
questions `CellTurn` asks them:

1. **a check failed over the pre-edit tree** — a call reported a failing exit
   status in a frame at epoch 0, before the run had changed anything, in a frame
   that itself changed nothing (`NarrowedCheck.Check` `stable`, so the digest
   stamped on it is a tree the check really ran over);
2. **the tree moved after it** — a later frame's `mutation-observed` says the
   workspace changed;
3. **the same check, or a broader one, went green over the final tree** —
   `Sufficiency.find`'s own relation, restricted to frames whose closing digest
   is the digest the run finished on. "Broader" is `NarrowedCheck` `narrows`:
   every term of the passing check carried by the failing one;
4. **the completion holds** — the run applied a `complete` transition, and at
   that frame neither `UnmovedTree.find` nor `UnresolvedFailure.find` names a
   condition.

More predicates held wins. Ties break on the predicates in that order, then on a
**broader final check** (fewer terms), then a **non-empty patch**, then **lower
cost**, then the **lower run index** — the last key making the order total, so
the same journals always choose the same run.

It writes `selected/<id>.patch`, byte for byte the chosen run's patch, and
`selected/<id>.rationale.json`, which names the journal sequence number behind
every predicate of every candidate and the reason each unheld predicate did not
hold. The choice can be second-guessed from the journals without re-running
anything.

Three readings the journal cannot give, all stated in `lib/journal-facts.mjs`
rather than guessed silently: whether a call declared a write is per frame and
not per call, so a call is read as mutating when its flow is an editing flow;
the call signature is the canonical form of `[flow, input]` rather than the
controller's digest of it, which is the same equivalence relation; and
`sufficiency-observed` and `narrow-only-demanded` reach the journal through
`AgentSession`'s default branch, which writes the event's name and an empty
payload, so the selector counts them and recomputes anything it needs from the
frames instead of reading their fields.

`fixtures/check-selector.mjs` pins that too, because every case it runs is a
rehydrated distillation and a distillation proves the ranking, not the shape:
rename an event or a payload field in `packages/smithers/agent/src/AgentSession.ts` and
the fixture would stay green while every predicate silently read `false` on a
real run. It asserts that every event `lib/journal-facts.mjs` reads is one
`AgentEvent` declares, that the six it reads *fields* off are mapped by hand
rather than through the empty-payload default, and that those fields are still
the names `AgentSession` writes.

`fixtures/check-selector.mjs`, in `verify.sh`, replays the selector over two real
waves. Wave 10 and wave 11 ran the same five instances and both distillations
survive (`packages/smithers/agent/harness/test/fixtures/wave10Journals.json` and
`fixtures/wave11-journals.json`), so `fixtures/rehydrate-journals.mjs` turns them
back into the databases the selector reads and the two-candidate case is two real
runs of one instance. It pins wave 11's four predicates per instance, the choice
each pair produces and the key that decides it — score for three of them,
the broader final check for the other two, the run index where everything ties —
and that the same journals twice produce byte-identical output.

### Grading and reporting

The evaluator keys its predictions by instance id, so one instance can carry
exactly one patch per grading. A matrix of n runs per instance is therefore n
gradings a side, one per round, plus one for the selected patches:

```sh
./grade-matrix.sh w12 all 5
```

| group | run ids | patches |
| --- | --- | --- |
| flows rounds | `w12-flows-r1` … `w12-flows-r5` | `patches/<id>-r<n>.patch` |
| codex rounds | `w12-codex-r1` … `w12-codex-r5` | `patches-codex/<id>-r<n>.patch` |
| selected | `w12-selected` | `selected/<id>.patch` |

`all` selects first and grades second. Running the selector after a grading
changes nothing about what it reads — it cannot name a report — but grading first
is the order that invites the mistake, so the driver does not offer it.

```sh
node matrix-report.mjs --prefix w12 --count 5
```

writes `matrix-report.json` and `matrix-report.md`: the per-instance reliability
matrix (n verdicts each side), best-of-n on both sides, selector quality, and the
single-attempt r1 columns that waves 3 through 11 reported, so the matrix can be
read against them.

**Disclosure obligations.** The two best-of-n columns are *not* the same
measurement, and the report says so on every line that carries them:

- **flows best-of-n is the verdict of the patch the selector chose**, from
  journals and patches alone, before anything was graded. It is a number the
  harness could produce in production.
- **codex best-of-n is an oracle**: the best verdict any of the n codex runs
  earned, so resolved when *any* of them resolved. The grader makes that choice
  after grading all n, and no codex run could make it. It is an upper bound on
  what a codex best-of-n would score, not a measured one. The cell takes the
  best of the n rather than r1's, so a side that shipped a real patch in four
  rounds is never printed as `empty` because its first round was.
- A comparison between them therefore favours codex by exactly the selector's
  miss rate, and the report prints the flows side's oracle too, so the gap
  between "the selector chose" and "an oracle would have chosen" is a number
  rather than an argument.
- **Selector quality** is that gap per instance: of the instances where at least
  one flows run resolved, `hit` where the selector took a resolving run and
  `miss` where it took another. An instance where nothing resolved is `n/a`,
  because there was nothing to hit.

The report also cross-checks the chosen patch against itself: the same bytes are
graded once in their own round and once in the selected set, and a disagreement
is a rig fault the report names rather than a result.

`fixtures/check-matrix-report.mjs`, in `verify.sh`, replays the generator over
`fixtures/matrix-reports.json` — the verdicts waves 7 through 11 and the drive's
four codex gradings actually recorded, arranged as five rounds. It pins the
reliability matrix, keeps `not graded` distinct from `empty patch`, and asserts
the oracle label and the rig-fault warning appear in the markdown.

## The full benchmark

The best-of-n matrix measures five instances five times. This measures all 500
once: **one flows attempt per instance, over the whole of SWE-bench Verified.**

```sh
cd evals/swebench
mkdir -p fullbench
nohup ./fullbench.sh --resume >> fullbench/launch.log 2>&1 < /dev/null &
```

That is the launch line; copy it as it stands. `nohup` takes the driver off the
terminal, and `fullbench.sh` then double-forks itself — the worker runs inside a
subshell that exits immediately, so launchd adopts it — which is what makes it
survive the *session* that started it and not merely the terminal. The launcher
prints the worker's pid and returns. Everything after that is in
`fullbench/driver.log`.

`--resume` is effectively mandatory: without it the driver refuses to start once
`fullbench/manifest.jsonl` exists, so a mistyped restart cannot re-spend a
benchmark that is already half done. A first start, with no manifest, accepts
either spelling.

```sh
./fullbench-status.sh          # one screen; safe to run against a live driver
./fullbench.sh --stop          # stop scheduling, let in-flight instances finish
./fullbench.sh --clear-pause   # after raising a budget or freeing disk
./fullbench.sh --aggregate     # the evaluator's own report over everything graded
```

### Streaming, because the disk is the constraint

The 500 official images are about 1.5 TB. This machine has roughly 16 GiB to
spare and shares it with the 5x5 matrix. So the benchmark cannot be "run 500,
then grade 500": the second pass would pull every image a second time. It is one
pipeline per instance instead, and **nothing multi-gigabyte outlives the instance
that needed it**:

```
wait for 8 GiB free -> pull (skipped if cached) -> run one attempt ->
grade THAT instance now, while its image is still local ->
archive journal, patch, timings and the evaluator's report ->
delete the testbed, delete the image
```

Two instances in flight, no more; the 5x5 matrix holds the other three slots.
Both drivers share one serialization point rather than each inventing one: the
extraction takes `run-instance.sh`'s existing `.extract-lock`, so however many
runs either driver has in flight, only one multi-gigabyte `docker cp` is ever
copying.

Grading is serialized the same way, by `.grade-lock`, and rig-wide rather than
per-driver: `evaluate.sh` takes it itself, so a `grade-matrix.sh` an operator
starts beside the benchmark waits instead of racing it. `evaluate.sh` records
why the evaluator runs one at a time — concurrent evaluators race in the
post-run image cleanup and the crash loses the whole report — and two
single-instance gradings are that same race.

### The lock every lane shares

Both locks go through `lib/lock.sh`, which is a directory holding the **owner's
pid**. That is not decoration; a bare `mkdir` lock has two defects that a
benchmark running unattended for days finds:

- a `kill -9` while the lock is held leaves the directory behind and every later
  extraction spins on `mkdir` for ever, so one crash wedges the whole rig;
- release was not ownership-checked. `run-instance.sh` installed a cleanup trap
  that `rmdir`ed the shared lock *before* it had taken it, so any run exiting for
  any reason released whoever was extracting at that moment and a second
  multi-gigabyte copy started — the thing the lock exists to prevent.

So: a waiter takes a lock back the moment its owner pid is gone; a lock with no
pid file (one an older copy of a run script is holding) is taken only once it is
older than `SWB_LOCK_STALE`; `release` is a no-op unless the caller owns it; and
every wait is bounded — `SWB_LOCK_TIMEOUT`, an hour, or `SWB_GRADE_LOCK_TIMEOUT`,
two — so a wedged lane fails one run instead of hanging the benchmark.
Creation, stale removal and release are serialized by an OS lock on the
persistent sibling `<dir>.guard` file. Each new owner records a generation
(pid plus a nonce). A stale remover compares the generation it inspected with
the current one under the guard before deleting anything. Legacy locks use
their device and inode as the generation. The guard uses Python 3's `fcntl`
on macOS and Linux; its file must stay in place while the rig is in use.
`fixtures/check-lock.sh`, inside `verify.sh`, also pauses a stale reclaimer
until a replacement owner has acquired, then verifies that only one holds it.

The driver reconciles both locks on the way in and again whenever a worker has
gone an hour without finishing, and it only ever clears one whose owner is gone:
the wave running beside it holds the same locks.

**The five images the matrix pinned are never deleted.** They are the seeded
sample's first `SWB_SAMPLE_COUNT` instances, read from `sample.json`, which is
the same rule `run-matrix.sh` and `grade-matrix.sh` use. When the full benchmark
reaches one of them it grades at `--cache_level instance` so the evaluator does
not delete it either, and records `imageState: kept`. Everything else is graded
at `--cache_level env` and then `docker rmi`d.

**The disk gate is a hard wait, and every wait is logged.** Before each pull, and
again before each extraction, the driver reads `lib/disk-free.sh` and blocks
until at least `SWB_FULLBENCH_MIN_FREE_MIB` (8192 by default) is free. Each poll
appends a row to `fullbench/waits.jsonl` and a line to the driver log, because a
benchmark that sat still for two hours and a benchmark that hung look identical
otherwise. After `SWB_FULLBENCH_DISK_WAIT_MAX` seconds (an hour by default) the
instance stops as `failed` rather than blocking the queue for ever; it re-runs on
the next resume.

`lib/disk-free.sh` answers with **the smaller of two numbers**, because an
instance spends two different disks: the extracted testbed lands on the host
filesystem and the image lands inside the docker VM. The docker side is read by
running `df` in a container built from an image that is *already local* — the
probe never pulls, because a disk check that needs the network to answer "is
there room to pull" is the wrong shape. With no local probe image the answer is
the host figure alone and `--explain` says so.

### Resume is a ledger, not a checkpoint

`fullbench/manifest.jsonl` is append-only and every row is `fsync`ed before the
next step starts. Each instance passes through `pulled`, `ran`, `graded`,
`cleaned`, and the **last row for an instance is that instance's state**.

`graded` is the resume boundary. A restart skips every instance whose last state
is `graded` or `cleaned` and re-runs everything else **from the top**, purging
that instance's workspace, patch, journal and archive first. A crash mid-instance
therefore costs that instance and nothing else, and never leaves half a run to be
mistaken for a whole one. A `pulled` row *replaces* an instance's earlier columns
rather than merging into them, so a patch size or a verdict from the attempt that
died cannot survive into the attempt that replaced it.

**A worker that dies without its completion marker is reaped, not waited on.**
The driver tracks each worker by a `.done` file the wrapper writes, and both of
its waits — for a free slot, and for the last instances to drain at the end —
poll for those markers through the same function. After
`SWB_FULLBENCH_POLL_LIMIT` polls without one they ask whether the oldest worker
is still alive: a live one is reported, with the shared locks reconciled beside
it, and a dead one is reaped. Reaping records `failed` with reason `the worker
died without writing a completion marker`, unless the ledger already has that
instance at `graded` or `cleaned` — a marker lost after the work finished is a
lost marker, not a lost instance, and a `failed` row over it would re-run
something the evaluator already graded. Without this the final drain waited on a
killed wrapper for ever and the run never reached its last checkpoint.

The worker copies patch, journal (including hidden files and subdirectories),
timings and run log into a temporary sibling directory. It checks each copy
and compares its contents against the source before one rename publishes
`fullbench/archives/<id>/`. The existing patch, journal, timing and run-log paths
are relative links into that directory. Only then are the sources deleted.
Copy, comparison or publication failure records `failed` with reason
`archive-failed` and exits nonzero before grading. Sources stay in place.
Before a retry purges leftover sources, it publishes a checked copy under
`fullbench/archives/<id>.recovered-<timestamp>-<pid>/`. Recovery archives are kept
for inspection and are not graded; a failed recovery stops the retry.

A line torn in half by a `kill -9` is read as no line at all; every complete row
before it keeps its meaning, and the instance that line belonged to re-runs. The
next append closes that fragment with a newline before it writes, so the resumed
driver's own row is a whole line rather than the second half of a broken one, and
the fragment is then reported as an unparseable line in `report.md` and on the
status screen rather than dropped in silence.

A re-run also deletes the evaluator's own log directory for that instance. The
official evaluator skips any instance that already has a `report.json` under the
run id — which is exactly the layout 500 instances accumulating into one run id
produce — so an attempt that was graded but killed before its `graded` row could
be written would otherwise hand the dead attempt's verdict to the patch that
replaced it.

The instance's whole life is one process (`lib/fullbench-instance.sh`), which
also takes a claim under `fullbench/claims/`, so two drivers started by accident
cannot both run one instance. The claim holds the **worker's** pid and outlives
the driver on purpose: killing the driver alone leaves its workers running
(`pkill -f fullbench.sh` matches the driver and not `fullbench-instance.sh`), and
the next driver must leave those instances to the workers that own them rather
than start a second paid attempt beside one. A claim whose worker is gone is
taken back on the spot; a claim whose worker is alive refuses the new attempt and
is named in the driver log.

Two things the ledger's boundary would otherwise leak, and what closes each:

- **an instance that fails** — a pull that did not answer, a run that captured no
  patch — deletes its image and workspace on the way out. Keeping them costs 2–3
  GB each for the rest of the benchmark, and a handful of failures is a disk gate
  that never opens again.
- **an instance killed between `graded` and `docker rmi`** is past the resume
  boundary, so nothing ever schedules it again and nothing would ever delete its
  image. The next driver sweeps those on the way in, reading the image ref out of
  the ledger, and records a `cleaned` row marked `reconciled`.

### One subject, for the whole benchmark

The rig's rule is one wave, one subject, and 500 instances over several days is
the longest wave there has ever been. But `.subject.json` is shared with the 5x5
matrix, and re-pinning under a live wave would silently re-arm a wave that ought
to have stopped. So the driver resolves the pin once, at start, and by cases:

| at start | what happens |
| --- | --- |
| no pin | it runs `./preflight.sh` and owns the pin |
| a pin that still matches the tree | it adopts it and does not rebuild |
| a pin that no longer matches | it **refuses to start** |

Re-pinning is an operator decision — `./preflight.sh`, deliberately — never a
side effect of starting a benchmark next to another wave. After that the pin is
never touched again: `flows.sh` re-derives the fingerprint on every call and
stops any instance whose subject moved, and that refusal is recorded per instance
rather than papered over. A moving git HEAD under an unchanged pin is written to
the ledger as a `head-moved` note and changes nothing else.

The report states the agreement outright: `one subject` when every driver session
ran the same stamp, and `MISMATCH` naming the others when they did not. Its other
preconditions — concurrency, budget, per-instance timeout — are read from the
*latest* session, because a benchmark resumed under a different budget must
report the one it is running under.

### Checkpoints, the report, and the budget

Every 25 completed instances (`SWB_FULLBENCH_CHECKPOINT_EVERY`) the driver
appends one row to `fullbench/progress.md` and regenerates `fullbench/report.md`
and `fullbench/report.json` from the manifest alone. Three things they say that
are worth knowing before reading them:

- **The resolve rate carries a 95% Wilson interval.** At 25 of 500 graded, 8
  resolved is a rate somewhere between 17.2% and 51.6%; a checkpoint that printed
  "32%" on its own would invite a conclusion the sample cannot support. Wilson
  rather than the normal approximation because the interval has to behave at 0
  and at small *n*, which is exactly where the early checkpoints live.
- **Extrapolating from a prefix is sound here, and only because of the order.**
  Instances run in the seeded draw order — mulberry32 at 20260818, the same
  procedure `sample.json` comes from — so the first *k* graded are a uniform
  random draw from the 500. In dataset order the first 231 rows are django and no
  prefix would mean anything. It also puts the five pinned instances first, so
  the benchmark's own numbers on them arrive early.
- **The projected finish comes in two labelled numbers.** "Observed" divides the
  wall clock the ledger actually spans by what completed in it, so it includes
  every hour the driver was stopped, paused or waiting on disk. "Modelled" is the
  mean instance wall divided by the concurrency, which is what the run would do if
  nothing ever stopped it. The truth is between them and the report does not
  pretend to choose.

The report also carries a per-repository breakdown, the cost and token totals,
and a comparison row: the benchmark's own single-attempt verdicts on the pinned
five against its rate over everything graded. That row exists so a drive that has
been reasoning about those five for eleven waves can see how far they sit from
the full set. It is not a claim — five instances have an interval wide enough to
contain almost anything — and when `matrix-report.json` is present the report
quotes it beside, with the same disclosure the matrix carries: the flows
best-of-n column is the selector's pre-grading choice and the codex column is an
oracle. **This benchmark's number is one attempt, so it belongs beside the
matrix's single-attempt column and nowhere else.**

**The budget is checked before every launch, not at checkpoints.** When the
cumulative cost read off the manifest reaches `SWB_FULLBENCH_BUDGET_USD` ($600 by
default) the driver stops scheduling, writes the reason to `fullbench/PAUSED` and
into `progress.md` and the ledger, drains what is in flight, writes a final
checkpoint and exits **7**. A paused benchmark will not restart until
`./fullbench.sh --clear-pause`, so continuing past a budget is always a decision
someone made.

**Cost counts attempts, not instances.** A `pulled` row replaces an instance's
earlier columns, which is right for a verdict and wrong for a bill: the tokens an
attempt burned before it was killed were still spent, and a benchmark that
crashed and resumed often could otherwise run past its cap while the gate only
ever saw the last attempt of each instance. The report's `spent so far` and the
gate's own figure are both the sum over every attempt the ledger records, and the
report names how many of them were re-runs. Two things the gate cannot see are
the instances in flight, which have not written their cost yet — an overshoot
bounded by `SWB_FULLBENCH_JOBS` instances — and a ledger it cannot read at all,
which pauses rather than being read as zero.

Cost per instance is read from the archived journal by `lib/run-cost.mjs`, which
sums the four token counters off `control.agent.model-settled` and prices them
with the committed table in `prices.ts`. It deliberately does **not** go through
`lib/journal-facts.mjs`: that module imports the harness's own modules to rebuild
the controller's decisions, and a benchmark running for days beside lanes that
edit `packages/smithers/agent/harness` must not have its cost column stop working because
another lane is mid-edit.

### Where the artifacts go

Each run carries the run index `r90` (`SWB_FULLBENCH_INDEX`), so it can never
collide with a matrix round — those are `r1`…`r5` — and needs no new naming rule:
`lib/run-paths.sh` already owns it. The instance's artifacts are then moved out of
the shared roots into `fullbench/`, so 500 stray `-r90` files never bury the
matrix's own.

| path | what it holds |
| --- | --- |
| `fullbench/manifest.jsonl` | the ledger: one row per state per instance, fsynced |
| `fullbench/waits.jsonl` | every disk-gate wait, with what was free and what was needed |
| `fullbench/progress.md` | the append-only checkpoint log, and any pause |
| `fullbench/report.md`, `report.json` | the scoreboard, regenerated at each checkpoint |
| `fullbench/patches/<id>.patch` | the captured patch, as graded |
| `fullbench/journals/<id>/` | the run's journal — the artifact worth keeping |
| `fullbench/timings/<id>.json` | the wall-clock stamp |
| `fullbench/reports/<id>.json` | the official evaluator's own report for that instance |
| `fullbench/logs/<id>.*` | the run, pull and grade logs |
| `fullbench/driver.log`, `driver.pid` | the detached driver |

**The journals are the point.** They are small once the testbeds are gone — single
megabytes — and they are the only record of what each of 500 runs actually did.
Every reading the rig makes after the fact, including `select-candidate.mjs` and
any later forensics, is made from them.

Grading accumulates into one evaluator run id (`fullbench`), so the official
per-instance reports also pile up under
`logs/run_evaluation/fullbench/flows-cell-harness/<id>/report.json` in the
evaluator's own layout. A patch of zero bytes is not sent to the evaluator at
all — it drops an empty prediction before it starts a container — and is recorded
as `empty patch`, which is a fact about the patch rather than a grading.

Those per-instance reports are what the driver reads, and they are the ones that
accumulate. The two files `evaluate.sh` writes beside them — `preds-fullbench.json`
and the evaluator's own `flows-cell-harness.fullbench.json` — are rewritten by
each single-instance grading, so at the end they describe the last instance
alone. `./fullbench.sh --aggregate` writes them over the whole run instead: every
graded instance already has a report, so the evaluator skips all of them, starts
no container and spends nothing, and the summary it writes is the official one
for all 500. Run it when the benchmark finishes, or any time a number is being
quoted from the evaluator's own file rather than from `fullbench/report.md`.

### Knobs

| variable | default | what it changes |
| --- | --- | --- |
| `SWB_FULLBENCH_JOBS` | 2 | instances in flight |
| `SWB_FULLBENCH_BUDGET_USD` | 600 | the cumulative cost that pauses the driver |
| `SWB_FULLBENCH_MIN_FREE_MIB` | 8192 | the disk gate |
| `SWB_FULLBENCH_DISK_WAIT_MAX` | 3600 | how long the gate may block before the instance fails |
| `SWB_FULLBENCH_CHECKPOINT_EVERY` | 25 | completed instances between checkpoints |
| `SWB_FULLBENCH_LIMIT` | unset | schedule at most this many instances this session |
| `SWB_FULLBENCH_BUDGET` | 1200 | the per-instance timeout, in seconds |
| `SWB_FULLBENCH_INDEX` | `r90` | the run index every artifact carries |
| `SWB_FULLBENCH_RUN_ID` | `fullbench` | the evaluator run id all 500 accumulate into |
| `SWB_FULLBENCH_PINNED` | the sample's first five | instances whose images are never deleted |
| `SWB_LOCK_TIMEOUT` | 3600 | how long a lane waits for `.extract-lock` before failing its run |
| `SWB_LOCK_STALE` | 1800 | when a lock with no owner recorded may be taken |
| `SWB_GRADE_LOCK_TIMEOUT` | 7200 | how long a grading waits for another evaluator |
| `SWB_TRANSPORT` | `docker` | `plue` runs every testbed and grading on Smithers Cloud; see [On Smithers Cloud](#on-smithers-cloud) |

`SWB_FULLBENCH_LIMIT` is how an operator spends one night's worth and reads the
checkpoint before committing the rest; it is also how the dry run holds a queue
still while it kills the driver.

### Proving the driver without spending a token

Two checks, and between them they cover the whole thing.

```sh
./verify.sh              # offline; includes fixtures/check-fullbench.mjs
./fullbench-dryrun.sh    # real docker, real kill, ~10 MB of pulls, no model
```

`fixtures/check-fullbench.mjs`, inside `verify.sh`, replays the parts that are
pure reading: the ledger's fold (including a re-run replacing a dead attempt's
columns, and a line torn by a kill), the resume boundary, the seeded draw order
and its refusal of a dataset that does not reproduce the pinned five, and the
whole report — the scoreboard, the Wilson arithmetic, the per-repo breakdown, the
extrapolation, the pinned-five comparison, and that two runs over one ledger
produce the same bytes. It also pins the two arithmetic rules a resumed
benchmark depends on: the bill counts every attempt while the fold counts
instances, and the observed finish divides the whole ledger's span rather than
the current session's. A copied rig with stub commands also checks archive copy
failures, interrupted copies, content mismatches, link and publication failures,
successful publication, and preservation of an earlier attempt before retry.

`fixtures/check-fullbench-status.mjs`, also inside `verify.sh`, runs
`lib/fullbench-status.mjs` over ledgers carrying every budget the driver
accepts, and asserts the screen and the checkpoint report print the same figure
for each. `fullbench.sh` accepts `.50` and `lib/fullbench-row.mjs` only numbers a
value with a digit before the decimal point, so a budget can reach the ledger as
text; both renderers read it through `lib/format-money.mjs`, which coerces, so a
screen an operator reads against a live driver cannot crash on a budget the
report prints.

`fixtures/check-lock.sh`, also inside `verify.sh`, proves the lock both drivers
share: one lane at a time, a holder killed with `-9` recovered by the next lane
within a poll, a stray release that leaves a live lock alone, and a bounded wait
that names who is holding it.

`fullbench-dryrun.sh` runs the real driver over stub instances that are in no
dataset, with the agent and the evaluator stubbed and everything between them
real. A–D are one four-instance benchmark; F–G are a second one, because every
crash they stage is about an instance that must **not** run again and the first
benchmark's ledger is pinned row by row:

| phase | what it proves |
| --- | --- |
| A | two instances in flight and never three, a real `docker pull`, a real extraction through the rig's `.extract-lock`, and then `kill -9` on the driver and its workers mid-instance |
| B | `--resume` skips both graded instances — their stubs are never invoked a second time — and re-runs the interrupted one from the top |
| D | a disk gate that cannot be satisfied logs each wait and fails the instance rather than pulling |
| C | cumulative cost over the cap writes `PAUSED`, records it in the ledger and `progress.md`, and exits 7 without scheduling anything |
| F | the driver alone is killed, its worker outlives it, and the next driver leaves that instance to the worker holding the claim instead of paying for a second attempt |
| H | a report left behind by an attempt that was never recorded is deleted rather than read: the re-run is graded on its own patch or not at all |
| E | an instance that fails after its pull leaves no image behind |
| G | an instance killed between `graded` and `docker rmi` has its image reconciled by the next driver, and its `cleaned` row says so |

The first two instances meet at a rendezvous inside the stub, so "two in flight"
is proved by construction rather than by two stubs happening to overlap: a serial
driver would leave the first one waiting there, and the timeout it writes is a
line the assertions fail on. Three images are used and the roles follow the
seeded draw, so no phase can quietly depend on an order the driver does not use:
`busybox` is pulled, extracted and deleted; `hello-world` is pulled and deleted;
`alpine` is pinned and is still present at the end — the stand-in for the five
images the matrix needs kept warm.

`SWB_DRYRUN_KEEP=1` leaves the temp directory, with every manifest, report and
driver log in it, for reading after a failure.

## The codex backfill

The full benchmark measures one harness. A resolved rate on its own is a number
about a benchmark; it becomes a claim only when a second harness runs the same
instances under the same conditions. `codex-backfill.sh` is that second harness.

```sh
./codex-backfill.sh --status        # counts, spends nothing
./codex-backfill.sh --list          # the ids still owed an attempt
./codex-backfill.sh --one <id>      # exactly one instance
./codex-backfill.sh                 # everything left, in order
```

Its population is **whatever `fullbench/manifest.jsonl` says was graded**, read
by the same `isDone` rule the flows driver resumes on. Nothing else is eligible:
an instance our side never finished has no flows attempt to compare against. The
ids come out in the order the ledger first saw them, which is the seeded draw
order, so a partial backfill is a prefix of the same uniform sample.

**The instances our own grading errored on are included, and flagged.** An
`eval error` verdict is a fact about our evaluator invocation and not about the
patch, and dropping those instances from the codex side would leave the two
harnesses measured over different populations — which is exactly what makes two
rates incomparable. Every ledger row carries `flowsVerdict` and
`flowsEvalError`, `--flagged` lists them, and `--table` marks them.

### The scoreboard

```sh
node compare-arms.mjs        # writes fullbench/arms.md and fullbench/arms.json
```

`--table` prints one row per instance; `compare-arms.mjs` turns the two ledgers
into the four-cell table the standing superset goal is stated in — both,
flows-only, codex-only, neither — so nobody counts by hand again. Two rules make
it honest, and they are the reason it is a script rather than a paragraph:

- **A verdict that is not a grading is not a verdict.** `eval error` means the
  evaluator never ran the patch, on whichever side it happened. Those instances
  are computed *outside* the table, listed by name with the arm that failed, and
  never counted as a loss — counting one manufactures a codex-only or flows-only
  win out of a docker fault. `empty patch` is the exception that still counts:
  the agent finished and changed nothing, which is a fact about the agent.
- **Coverage is stated before the rate.** "23 of 27 (85 %)" and "23 of 45 (51 %)"
  share a numerator, and quoting the first without its denominator is how an
  incomplete arm reads as a better one. Whenever either arm is missing a grading
  the report marks the superset claim **provisional in both directions**.

As of 2026-08-22 both arms have a real grading on all 45: **both 34, flows-only 1
(`django__django-14351`), codex-only 6, neither 4** — flows 35/45, codex 40/45.
The standing superset goal fails on this sample by six instances, which are the
six `analysis/PROGRAM.md` section 4 diagnoses and the re-run has to close. Two
caveats travel with the codex column and do not go away: it ran with network
egress and used it (its `24970` patch came from fetching the merged upstream PR,
its `7590` fix from the project's later 3.x history), and its dollar cost is not
derivable from what the CLI publishes.

Per instance, in one process, the same shape `lib/fullbench-instance.sh` uses:

```
claim -> slot -> disk gate -> pull -> codex run -> archive -> grade -> delete
```

Grading happens per instance, while the image is still local, for the reason the
full benchmark grades that way: collecting the patches and grading them
afterwards needs every image a second time.

### Two slots, and why not `flock`

`--one` is the unit, and a pipeline runs many of them at once. They share one
docker daemon, one disk and one evaluator, so each instance's docker-heavy span —
pull, run, grade, delete — is held inside a **two-slot semaphore** at
`fullbench/.codex-slots`. Two is what the full benchmark already proved this
machine sustains inside the 8 GiB disk gate.

The semaphore is two `lib/lock.sh` locks. `flock(1)` is a util-linux program
and is not on macOS, which is the host this rig runs on. The helper uses Python
3's `fcntl.flock` only while changing lock metadata. The slot itself records
the lane's pid and remains held after the acquire helper exits; the next waiter
recovers it if that lane dies. It is the protocol `.extract-lock` and
`.grade-lock` already use.

One instance is also claimed by pid. Two invocations naming one id would be two
paid agents writing one patch path, so the second refuses with exit 3 before it
takes a slot.

### Resume, and the run index

`fullbench/codex-manifest.jsonl` is append-only and fsynced, and **an id with a
verdict there is a no-op** — the script exits 0 without touching docker. A
`started` row (a kill mid-instance) and a `failed` row both carry no verdict, so
both are retried from the top, and the retry purges the dead attempt's artifacts
*and its evaluator report* first. The official evaluator skips an instance that
already has a report under the run id, so a retry that kept one would file the
dead attempt's verdict against a patch it never saw.

Each attempt carries the run index `r90c`: `r90` is the full benchmark's flows
lane and `r90c` is the codex lane over the same instances, so the two sit side by
side in the shared codex roots under one readable rule.  `lib/run-paths.sh`
accepts `r<digits><lowercase tag>` for exactly this; everything that reads a
matrix *round* keeps its own stricter `r<digits>` rule and ignores a tagged lane.

Auth is checked once, up front, against the rig's own `.codex-home`. A backfill
that discovered a logged-out home per instance would burn a claim, a pull and an
extraction on each one first.

| path | what it holds |
| --- | --- |
| `fullbench/codex-manifest.jsonl` | the ledger: `{id, verdict, wallSeconds, tokens, patchBytes, timestamps}` and the flags |
| `fullbench/codex/patches/<id>.patch` | the captured patch, as graded |
| `fullbench/codex/logs/<id>.*` | the transcript, last message, prompt, pull and grade logs |
| `fullbench/codex/timings/<id>.json` | the agent's own wall clock |
| `fullbench/codex/reports/<id>.json` | the official evaluator's report for that instance |
| `fullbench/.codex-slots/` | the two-slot semaphore, shared by every lane |

`tokens` is the CLI's own footer total. It is **one number with no input/output
split**, so nothing prices it: a USD figure for codex would be inventing that
split, and the bundle says so instead of printing one.

| variable | default | what it changes |
| --- | --- | --- |
| `SWB_CODEX_BACKFILL_SLOTS` | 2 | instances doing docker work at once |
| `SWB_CODEX_BACKFILL_JOBS` | 1 | instances a bare run works on at once (`--jobs`) |
| `SWB_CODEX_BACKFILL_BUDGET` | 1200 | the per-instance timeout, matching what the flows side got |
| `SWB_CODEX_BACKFILL_RUN_ID` | the lane's | the evaluator run id every instance accumulates into |
| `SWB_CODEX_BACKFILL_INDEX` | the lane's | the run index every artifact carries |
| `SWB_CODEX_BACKFILL_MIN_FREE_MIB` | 8192 | the disk gate |
| `SWB_CODEX_BACKFILL_SLOT_TIMEOUT` | 21600 | how long an invocation waits for a slot |
| `SWB_CODEX_LANE` | `net` | the lane, and with it the five rows below it |
| `SWB_CODEX_NETWORK` | the lane's | `on`, `sealed` or `off`; see the sealed lane |
| `SWB_CODEX_UNCONFINED` | unset | `allowed` opts a `net` lane into `SWB_CODEX_NETWORK=on`; nothing else is accepted |
| `SWB_CODEX_EFFORT` | the lane's | `minimal`, `low`, `medium`, `high` or `xhigh`; see [Reasoning effort](#reasoning-effort) |
| `SWB_CODEX_MODEL` | `gpt-6-sol` | the model, which must be the one the flows side ran |

### Lanes, and the sealed one

A lane is one measurement of the population under one condition, and it moves
four things at once — the archive, the ledger, the run index and the evaluator
run id — plus the conditions its runs are given. Moving only some of them would
grade one condition's patches into another condition's run id with nothing on
disk saying so.

| lane | archive | ledger | index | evaluator run id | network | effort | testbed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `net` (default) | `fullbench/codex/` | `codex-manifest.jsonl` | `r90c` | `fullbench-codex` | `on` | `medium` | `bridge` |
| `sealed` | `fullbench/codex-sealed/` | `codex-sealed-manifest.jsonl` | `r90s` | `fullbench-codex-sealed` | `sealed` | `medium` | `bridge` |
| `sealed-high` | `fullbench/codex-sealed-high/` | `codex-sealed-high-manifest.jsonl` | `r90sh` | `fullbench-codex-sealed-high` | `sealed` | `high` | `bridge` |
| `none` | `fullbench/codex-none/` | `codex-none-manifest.jsonl` | `r90n` | `fullbench-codex-none` | `sealed` | `high` | `none` |

**The `none` lane is the ruling made into a condition.** It is `sealed-high`
with the one hole closed: the same population, the same seal on codex's own
tools, the same `high` effort, and a testbed container with no route out of the
machine. It is the first lane whose sealed number needs no disclosure paragraph,
because there is no in-container fetch to disclose. `./preflight-network.sh`
runs before it, and `compare-codex-lanes.mjs --require none` gates the number
that comes out of it. See [The sealed testbed](#the-sealed-testbed).

**Every lane pins its own effort and its own testbed.** The two `medium` lanes ran while
`run-instance-codex.sh` had that value written into it as a literal; the default
is `high` now, so a lane that took the default would re-run at a condition its
recorded rows were never measured under. Two lanes may therefore share a network
condition — `sealed` and `sealed-high` do — while no two share an archive, a
ledger, an index or an evaluator run id, and no two share the *pair* of
conditions. Each run's conditions are also written into its own ledger row and
its own timings, so a row says what it was measured under without anyone reading
the lane table back.

```sh
./codex-backfill.sh --lane sealed --status        # counts, spends nothing
./codex-backfill.sh --lane sealed --jobs 2        # the whole lane, two at a time
./codex-backfill.sh --lane sealed-high --jobs 2   # the same seal at high effort
```

Every mode takes `--lane`, and it has to: `--status` on the wrong lane reads the
wrong ledger. The lanes are a table in the script rather than a name template,
because each one is a claim about how a number may be quoted. `--jobs` runs that
many instances at once by spawning `--one` **processes**: a background subshell
would share the driver's pid, and `lib/lock.sh` records the owner's pid, so two
subshells would look to each other like one live owner and either could release
the other's claim.

The sealed lane exists because the `net` lane's codex column carries a caveat
that no amount of arithmetic removes: it ran with network egress and used it.
`matplotlib__matplotlib-24970` is the recorded case — four
`curl https://api.github.com/repos/matplotlib/matplotlib/…` calls that read the
merged pull request — and `pytest-dev__pytest-6197` was the same shape on
2026-08-19. Our harness made no network call on either.

**What "sealed" denies, and what it does not.** `SWB_CODEX_NETWORK=sealed` keeps
codex's approval/sandbox bypass, so the run is the `net` lane's run in every
respect except two, which are the two ways out of the machine:

- **the child commands' network**: every command codex spawns gets `HTTP_PROXY`,
  `HTTPS_PROXY`, `ALL_PROXY`, `FTP_PROXY` and their lowercase spellings pointed
  at `http://127.0.0.1:1`, with `NO_PROXY` emptied.
  `shell_environment_policy.set` applies to child commands and not to codex's own
  API calls, which is what lets the model keep talking to the API while its tools
  cannot leave the machine. Measured on codex-cli 0.149.0, 2026-08-22:
  `docker exec` exit 0, `curl https://example.com` exit 7,
  `git ls-remote https://github.com/…` exit 128, `urllib.request.urlopen` raises.
- **codex's own web-search tool**, with `-c web_search=disabled`. That tool is
  the model's, not a child command's, so no amount of proxying reaches it, and
  it is **on by default** in `codex exec` on this build. Measured the same day on
  one prompt asking the model to look a page up: with the key, `NO_TOOL` and no
  search lines; without it, two search lines and the right answer.

> **Disclosure — the first r90s attempt was sealed on one surface only.** It set
> `tools.web_search=false`, a key this build ignores, and 15 of its 45 runs
> logged 126 `web search:` lines between them — several opening the instance's
> own upstream issue, which is the hindsight the lane exists to remove. Its
> shell seal held (the `curl` and `git ls-remote` attempts in those transcripts
> are refused by the dead proxy), so it measures *codex with a sealed shell and a
> live search tool* and nothing else. It is kept, whole, as
> `fullbench/codex-sealed-websearch/` with
> `fullbench/codex-sealed-websearch-manifest.jsonl`, and its evaluator reports as
> `logs/run_evaluation/fullbench-codex-sealed.superseded-<epoch>/`. No number
> from it may be quoted as a sealed number.

It is a seal on the tools an agent reaches for, not a kernel-level one. A raw
socket, an explicit `curl --noproxy '*'`, or a `curl` run *inside* the testbed
container would still get out — the container keeps the network the `net` lane
gave it, so test behaviour does not change with the condition. **A lane that
claims a seal therefore has to read its own traces back**, and a sealed report
owes the count: how many of its runs attempted egress, and whether any succeeded.

**Why not codex's own sandbox.** `SWB_CODEX_NETWORK=off` runs
`codex exec --sandbox workspace-write`, whose seatbelt policy denies egress
completely — and denies it to the docker daemon's unix socket along with
everything else. Measured the same day and build: a child command cannot reach
`unix:///…/docker.sock`, cannot reach a localhost TCP relay to it, cannot resolve
a name and cannot open a remote IP; neither `network.allow_unix_sockets` nor the
experimental `network_proxy` feature changes it, and `codex exec` has no
`--permission-profile` flag to reach the newer permissions system with. Both arms
are told to run the project's tests with `docker exec <container> …`, so an `off`
run cannot run a single test: the 2026-08-19 `pytest-dev__pytest-6197` probe
recorded "Tests could not run because Docker socket access was denied." An `off`
lane therefore measures a harness with no web **and** no way to check its work,
which is two variables where the comparison needs one. `off` is kept, and says
so in its own log line, because "codex with nothing at all" is a question someone
may want answered; it is not the sealed lane.

### Reading the two codex lanes

```sh
node compare-codex-lanes.mjs        # writes fullbench/codex-sealed/lanes.{md,json}
```

One row per instance — the flows verdict, the codex verdict with the network and
the codex verdict sealed — plus the three movement sets between the two codex
lanes, both denominators around every rate, and the rows one lane never graded
listed by name instead of counted as a loss. It also reads the sealed lane's own
transcripts back and prints, per instance, how many egress commands the run
issued and how many proxy refusals they produced: an environment seal is a claim
its traces have to support, and a run that never reached for the network and one
that reached and was refused are different findings a reader is entitled to tell
apart.

**Both surfaces of the seal are counted, not one.** The proxy reaches the
commands codex spawns; it does not reach codex's own web-search tool, so the
report counts `web search:` lines across the lane's transcripts and prints the
total with its denominator. Zero is the claim a sealed lane makes. A non-zero
total names the runs behind it and says outright that their verdicts are not
sealed verdicts — the `codex-sealed-websearch` failure was 126 such lines going
unnoticed, and it is now a number the report cannot omit.

**The sealed lane finished on 2026-08-22: all 45 instances carry a real
grading.** Scored over the 43 the exclusions leave, flows `r90` resolves 33,
codex `r90c` (network) 38, and codex `r90s` (sealed) 36; raw over 45 that is
35, 40 and 38. The seal moved three instances out of codex's column
(`pydata__xarray-7229`, `django__django-12273`, `django__django-15732`) and one
into it (`django__django-14351`), so **taking the network away costs codex two
net resolves** — a smaller effect than the two recorded egress cases suggested.
Against the sealed column the four-cell table is both 32, flows-only 1
(`django__django-15732`), codex-only 4 (`pydata__xarray-7233`,
`sphinx-doc__sphinx-7590`, `sympy__sympy-19495`, `django__django-13821`),
neither 6. The standing superset goal still fails, by four instead of six.

**What the traces say about the seal, in both directions.** The web-search tool
is off for the whole lane: **zero `web search:` lines across all 45
transcripts**, against 126 in the superseded `codex-sealed-websearch` lane. The
shell seal held wherever it applied: 21 runs issued an egress command from the
host and every one of them failed, with 13 carrying the dead proxy's own
diagnostic (`curl: (7) Failed to connect to 127.0.0.1 port 1`, `fatal: unable to
access 'https://github.com/…'`) and the rest failing silently under
`curl --silent` inside a pipeline whose last stage still exited 0.

**Two runs got out through the hole this section already names.** The proxy is
set through `shell_environment_policy.set`, which reaches the commands codex
spawns; a `docker exec <container> curl …` starts its process as the docker
daemon's child, in a container that keeps its network on purpose so that test
behaviour does not change with the condition. Two of the 45 used it, and both
fetched the merged upstream fix:

| instance | what it fetched | sealed verdict |
| --- | --- | --- |
| `sphinx-doc__sphinx-8721` | `github.com/sphinx-doc/sphinx/pull/8721.patch` — the upstream fix and its graded tests | resolved |
| `sympy__sympy-19495` | `github.com/sympy/sympy/pull/19495.diff` — the upstream fix | resolved |

**Neither verdict is a sealed verdict.** `sympy__sympy-19495` is one of the four
instances the sealed codex column wins and flows loses, so with it set aside the
codex-only set is three, not four; `sphinx-doc__sphinx-8721` resolves on both
arms and moves no cell. Read strictly, the sealed lane resolves **36 of 45 raw**
with two verdicts void, and the superset goal fails by three instances rather
than four. `compare-codex-lanes.mjs` now counts in-container fetches as a
`breaches` column and prints the offenders under "Where the seal did not hold",
so a later lane cannot report this number without reporting the hole with it.

Closing the hole means running the tests somewhere the container cannot reach
the network — a `--network none` testbed, or a proxy inside the container as
well — and both change what the *other* arm was measured under, so neither is a
change to make silently between two lanes of one comparison.

**It is closed, as a new lane rather than a silent edit.** Will ruled on
2026-08-24 that the testbed gets a proper sandbox so an agent cannot cheat.
`SWB_TESTBED_NETWORK=none` is the default for everything from that date, the
three lanes above pin `bridge` because that is what they were measured under,
and the `none` lane is `sealed-high` re-run with the hole shut. Nothing above is
re-graded: `r90s` and `r90sh` keep their numbers, their two void verdicts and
this disclosure. See [The sealed testbed](#the-sealed-testbed).

`django__django-13212` graded `eval error` on its first pass: the official
evaluator's `make_test_spec` fetches `tests/requirements/py3.txt` from
`raw.githubusercontent.com` and the host's DNS failed. The codex run itself
exited 0 with a 7212-byte patch, so `HARNESS=codex SWB_CODEX_LANE=sealed
./regrade.sh` re-graded that patch rather than paying for a second attempt; it
resolves to `unresolved`, and the ledger carries both the reason and the verdict
it supersedes.

### The sealed-high lane

`r90s` answers "what does codex resolve without the network". It does not answer
"what does codex resolve under the conditions flows was measured under", because
it ran at medium reasoning effort and every flows wave ran at high — see
[Reasoning effort](#reasoning-effort) for the confound and the ruling that
retires it. `sealed-high` is `r90s` with that one variable moved: same 45
instances, same seal, same model, same 1200-second budget, same grading rig,
`model_reasoning_effort=high`.

```sh
./codex-backfill.sh --lane sealed-high --status
./codex-backfill.sh --lane sealed-high --jobs 2
node compare-codex-lanes.mjs \
  --sealed fullbench/codex-sealed-high-manifest.jsonl \
  --logs fullbench/codex-sealed-high/logs \
  --out fullbench/codex-sealed-high \
  --label 'r90sh (sealed, high effort)'
```

`compare-codex-lanes.mjs` takes the lane it reads as flags, so the same script
scores this lane against `net` and reads its seal back off its own transcripts.
Everything the sealed lane owes its reader, this lane owes too, and for the same
reasons: the web-search line count across all 45 transcripts, the egress
attempts and the refusals they produced, and — separately, because it is a
different finding — the in-container `docker exec … curl` fetches the
environment seal cannot reach. **A verdict from a run that fetched the upstream
fix is not a sealed verdict**, whatever its effort.

**The lane finished on 2026-08-23: all 45 instances carry a real grading, none
failed, and none needed a re-grade.** Scored over the 43 the exclusions leave,
flows `r90` resolves 33, codex `r90c` (network, medium) 38, codex `r90s`
(sealed, medium) 36, and codex `r90sh` (sealed, high) 38; raw over 45 that is
35, 40, 38 and 38.

**Effort is worth two instances to sealed codex, in one direction.** Against
`r90s` the high-effort lane gains `django__django-12273` and
`astropy__astropy-14369` and loses nothing, so the confound flattered flows by
two on the sealed comparison and by nothing in the other direction. The
four-cell table against `r90sh` is both 32, flows-only 1
(`django__django-15732`), codex-only 6, neither 4 — the standing superset goal
fails by six, where against the medium sealed column it failed by four.

Effort also costs: 6584 seconds of agent wall clock against `r90s`'s 4494 (+47
%) and 1,982,783 footer tokens against 1,710,616 (+16 %), for those two
instances.

**Both excluded rows moved, which is what an exclusion is for.**
`psf__requests-1766` and `psf__requests-2317` resolve under `r90s` and do not
under `r90sh`. Their verdicts turn on the httpbin the family is graded against
(`lib/httpbin.sh`), not on a harness, which is why `lib/excluded.mjs` keeps them
out of every rate — and why `r90sh` reads 38 scored and 38 raw while `r90s`
reads 36 and 38.

**What the traces say, and where the seal did not hold.** The web-search tool is
off for the whole lane: **zero `web search:` lines across all 45 transcripts**,
counted by `compare-codex-lanes.mjs` rather than by hand. Twenty-four of the 45
runs issued 62 host egress commands between them and 16 carried the dead proxy's
own diagnostic; three transcripts read in full show none of the rest succeeded
either — `django__django-15732`'s verbose attempt names the seal outright
(`Uses proxy env variable https_proxy == 'http://127.0.0.1:1'`, connection
refused, zero bytes), `matplotlib__matplotlib-22865`'s two pipelines exit 127
and 1 with nothing fetched, and `psf__requests-1766`'s two matches are the word
`curl` quoted out of the repository's own docstring.

**Eight of the 45 got out through the in-container hole, against two at medium.**
Every one of them resolved, and every one fetched upstream hindsight — the merged
pull request, the issue thread, the file as it stands on `main`, or a later
release off PyPI:

| instance | what it fetched | `r90sh` verdict |
| --- | --- | --- |
| `astropy__astropy-8707` | `api.github.com/…/pulls/8707/files` — the merged fix | resolved |
| `pytest-dev__pytest-6197` | `api.github.com/…/issues/6197` — the issue thread | resolved |
| `django__django-16901` | `raw.githubusercontent.com/…/main/…/sql/where.py` | resolved |
| `django__django-11815` | `api.github.com/search/issues?q=repo:django/django…` | resolved |
| `sphinx-doc__sphinx-7590` | `pip download Sphinx` — a later release | resolved |
| `sympy__sympy-19495` | `api.github.com/…/issues/19495` | resolved |
| `astropy__astropy-14369` | `raw.githubusercontent.com/…/main/…/format/cds.py` | resolved |
| `django__django-13128` | `api.github.com/…/commits/2d67222472…` | resolved |

Read strictly — every breached verdict void, the rule the sealed lane applied to
its two — the lane resolves **30 of the 35 scored instances that did not breach**,
and the codex-only set shrinks from six to three: `pydata__xarray-7233`,
`django__django-12273` and `django__django-13821`. Three of the six the superset
goal fails on are runs that read the answer.

**The hole is now the dominant uncertainty in this comparison, and raising the
effort is what made it so.** Two breaches in 45 was a footnote; eight in 45,
every one resolved, is not. Closing it means a testbed the container cannot leave
— `--network none`, or a proxy inside the container as well — and that changes
what the *flows* arm was measured under too, so it is a change to make for both
arms at once and to re-run both, never a patch applied between two lanes of one
comparison. For what it is worth to that decision: no flows journal in
`fullbench/journals/` mentions `curl`, `wget`, `api.github.com` or
`raw.githubusercontent.com` on any of the 45, though the flows agent's `bash`
flow reaches the same container by the same route.

### The analysis bundle

```sh
node lib/trace-bundle.mjs <instance_id>
```

Writes `fullbench/analysis/<id>/bundle.md` — the task as the agent saw it, our
run's metrics and its frame-by-frame trace, codex's trace and its metrics — and
`fullbench/analysis/PROMPT.md`, the brief every analyst answers. One brief for
all of them, so two analyses of two instances are answers to the same question.

The brief asks for **the optimal trace**: a way of solving that instance using
only what a live agent could see, minimal in wall clock, model turns and dollars,
written as concrete flows cells. Then a diagnosis of where our trace spent what
the optimal one does not, classified (tool gap / teaching gap /
context-visibility gap / model choice gap / pure waste), what codex did that the
optimal trace adopts or rejects, the three traces' frames, tokens and dollars in
one table, and at most three **general** harness changes — never
instance-specific, and never an added review or audit step.

**A bundle withholds hindsight, and that is checked rather than remembered.**

| withheld | why |
| --- | --- |
| the gold patch | the answer |
| the graded test file | the answer, spelled as a test |
| `FAIL_TO_PASS`, `PASS_TO_PASS` | knowing which tests are graded makes every search trivial and every conclusion untransferable |
| `hints_text` | maintainer commentary from the PR, which no agent had |
| the evaluator's own report | it names every graded test |

Enforcement is at the source: the dataset row is projected through `visible()`
before anything is rendered and that projection is asserted to carry none of
those keys, and verdicts are read from the two ledgers rather than from
`fullbench/reports/<id>.json`. `fixtures/check-trace-bundle.mjs`, in
`verify.sh`, makes each withheld column a sentinel string and fails if one
reaches the output.

Scanning the finished bundle for graded test names would be the wrong check and
would fail on honest traces: an agent that found the right test by reading the
repository put it in its own transcript, and that is the trace working. What is
checked is that the bundle never *adds* it.

Every clip says what it dropped — `[+2912 chars]` — so a 40 KB test log reads as
40 KB rather than as its first 200 characters. Defaults: 200 characters per call
input, call result, codex command and codex output; 400 per codex assistant turn;
3000 per cell. All four are flags.

### Proving the backfill without spending a token

```sh
./verify.sh                    # offline; includes fixtures/check-trace-bundle.mjs
./codex-backfill-dryrun.sh     # real docker, real kill, ~10 MB of pulls, no model
```

The dry run runs the real script over five instances that are in no dataset, with
the agent, the evaluator and the auth check stubbed and everything between them
real:

| phase | what it proves |
| --- | --- |
| A | a logged-out rig fails loudly and claims, pulls and writes nothing |
| B | three `--one` invocations at once run two, the third waits for a slot and says so, and the ledger never shows three in flight |
| C | `kill -9` mid-instance leaves a `started` row with no verdict, and a second invocation naming a live instance refuses with exit 3 |
| D | the killed instance runs again from the top; an instance with a verdict is a no-op that touches no docker |
| E | a disk gate that cannot be satisfied logs its wait and fails the instance rather than pulling |
| F | the failed instance is retried, and the report its dead attempt left behind is deleted rather than read |
| G | an id the full benchmark never graded is refused; a bare `./codex-backfill.sh` works through the one instance no `--one` ever named; and a backfill with nothing left says so and exits 0 |

The first two instances meet at a rendezvous inside the stub, so "two at once" is
proved by construction rather than by two stubs happening to overlap; the third
is launched only once both are known to be inside their instances, so "the third
waits" is a fact about the semaphore rather than about which invocation won a
race. `busybox` and `hello-world` are pulled and deleted; `alpine` stands in for a
pinned instance's image and is still present at the end.

## The re-run

`fullbench/analysis/PROGRAM.md` reads 45 instances' traces and ends in eleven
harness changes, each with a falsifiable prediction about what the **same 45
instances** would then cost. `run-45.sh` is the measurement those predictions are
settled against, and `compare-runs.mjs` is the arithmetic that settles them.

```sh
./preflight.sh                    # pin the subject first; a wave measures the tree
./run-45.sh --lane r92            # detached; ./run-45.sh --lane r92 --status to read it
node compare-runs.mjs \
  --rerun fullbench/rerun-r92/manifest.jsonl \
  --out fullbench/rerun-r92       # baseline vs this lane, once it has finished
```

### The lane

A lane is one measurement of the population on one subject. `--lane r92` writes
`fullbench/rerun-r92/`, indexes every artifact `r92`, and grades into the
evaluator run id `rerun-r92`; all three move together, because a lane that moved
only some of them would grade one wave's patches into another wave's run id.
Every subcommand takes it — `--status` on the wrong lane reads the wrong ledger.

The default is `r91`, the first re-run, so an operator who names no lane resumes
that one rather than starting a nameless sixth. A lane name is a path component
and an evaluator run id at once, so it is refused unless it is letters, digits,
`.`, `_` and `-`. The index must also be one `lib/run-paths.sh` accepts,
`r<digits>[<lowercase tag>]`, so a lane named any other way (`jev1`) refuses to
start until `SWB_RERUN_INDEX` names one (`r99jev`). `SWB_RERUN_LANE` sets it from the environment, and `FB_DIR`,
`SWB_RERUN_INDEX` and `SWB_RERUN_RUN_ID` still override the three values it
derives, one at a time.

One lane never writes into another's ledger. That is what makes a second
measurement of the same 45 instances a second measurement rather than an append
to the first, and it is what `three-way.mjs` below depends on.

### What is held fixed

Everything except the harness, because the comparison is worthless otherwise:

| | r90 baseline | the re-run |
| --- | --- | --- |
| instances | 45, seeded draw order | **the same 45**, same order, read out of the baseline ledger |
| attempts per instance | one | one |
| per-instance budget | 1200 s | 1200 s |
| seat | `openai:gpt-5.6-sol` | `openai:gpt-5.6-sol` |
| journals | archived per instance | archived per instance |
| testbeds and images | deleted after the verdict | deleted after the verdict |
| grading | official evaluator, x86_64 images | the same, plus the two rig fixes above |
| in flight | 2 | 3 |

**The instance list is derived, never typed.** `lib/rerun-queue.mjs` takes the ids
the baseline ledger actually graded and orders them by the same seeded draw.
There is no flag that adds or drops one, so a re-run cannot quietly become a
re-run of an easier set, and a baseline instance the dataset does not contain is
a refusal rather than a smaller comparison.

**Three in flight rather than two** changes wall-clock scheduling, not what any
instance is measured at: every instance still gets its own container, its own
testbed and its own 1200 s budget, and the numbers being compared are
per-instance. What it does change is disk — three testbeds and three images
against the same 8 GiB gate — which is why the gate is still there and still
blocks. `SWB_RERUN_JOBS=2` holds even this fixed.

**The grading rig is fixed on both sides.** `./regrade.sh` has already written the
corrected verdicts into `fullbench/manifest.jsonl`, so the baseline the re-run is
compared against is the same rig, not the one that lost six verdicts to its own
concurrency and to a third party's outage.

It writes its own ledger and archive under `fullbench/rerun-<lane>/`, carries the
lane as its index, and grades into the evaluator run id `rerun-<lane>`. The
baseline's `fullbench/manifest.jsonl` is never appended to. Resume is the ledger,
exactly as the full benchmark's is.

### Knobs

| Variable | Default | What it changes |
| --- | --- | --- |
| `SWB_RERUN_JOBS` | 3 | instances in flight |
| `SWB_RERUN_LANE` | `r91` | the lane, and with it the three rows below |
| `SWB_RERUN_INDEX` | the lane | the index every artifact carries |
| `SWB_RERUN_RUN_ID` | `rerun-<lane>` | the evaluator run id all 45 accumulate into |
| `SWB_RERUN_BASELINE` | `fullbench/manifest.jsonl` | the ledger the population comes from |
| `SWB_RERUN_BUDGET_USD` | 60 | cumulative spend gate; the baseline was $37.84 |
| `SWB_FULLBENCH_BUDGET` | 1200 | per-instance seconds |
| `SWB_FULLBENCH_MIN_FREE_MIB` | 8192 | the disk gate |

`--limit N` spends one session's worth and leaves the rest queued; `--stop` ends
a live driver after its in-flight instances finish, and the next start clears the
marker so a stopped run resumes rather than wedging.

### The comparison

```sh
node compare-runs.mjs [--baseline f] [--rerun f] [--out dir] [--json]
```

It reads two ledgers and nothing else — no evaluator report, no journal, no
clock, no network — and writes `compare.json` and `compare.md` beside the re-run.
Three things it is careful about:

- **a partial re-run is compared like with like.** Totals cover the instances
  both ledgers finished, and the baseline's own numbers over that same subset sit
  beside them, so a re-run 20 instances in is never scored against the baseline's
  45. The whole-baseline totals are printed too, and labelled.
- **money is every attempt**, including one a crash replaced, because that is what
  the invoice says. The fold answers everything else.
- **wall clock comes in two labelled numbers**: `wallSeconds` is the whole
  instance (pull, extract, agent, capture) and `agentSeconds` is the journal's own
  span across the agent's frames. Neither is the wall clock of the run as a whole,
  which depends on concurrency and is not a property of a harness.

The program's success criteria are answered directly — resolved ≥ 33, cost ≤ $15,
instance wall ≤ 120 min, no instance over $1.00 or over 20 frames — and are
reported `pending` until the whole population is in, rather than declared met by
a favourable prefix. A seventh row is the standing superset rule: **an instance
the baseline resolved and the re-run did not is a regression**, listed by name,
however good the totals look. Every row answers the same way, the per-instance
ones included: pending while instances are outstanding, met only once the last
one is in, and failed the moment a counterexample appears, because a dollar
spent, a frame taken and a verdict lost cannot be taken back by the instances
still to run.

### Three lanes, one population

```sh
node three-way.mjs --baseline f --first f --second f [--out dir] [--json] \
  [--baseline-name r90] [--first-name r91] [--second-name r92]
```

`compare-runs.mjs` answers "did this change help", which is a question about two
ledgers. A programme already measured once asks a different one: a wave lands, its
report says what regressed, a surgical change answers that report, and the second
wave has to be read against **both** — against the baseline, which is what "did we
get back to where we were" means, and against the wave in between, which is what
"did the surgery act" means. Reading it against only one of them is how a
recovery gets reported as a win, or a remaining regression gets lost behind a
large improvement.

So this composes `compare-runs.mjs` twice rather than recomputing anything, and
adds the two rows that only exist with three ledgers:

- **recovered** — the baseline resolved it, the middle wave did not, this one
  does. That is the surgery's own scoreboard, and it is disjoint from **gained**,
  which is an instance no wave before this one had ever resolved.
- **still lost** — the baseline resolved it and this wave does not, whatever the
  middle wave did. That is what the next report has to answer for, and it is
  counted apart from **newly lost**, a regression this wave introduced.

### Every wave in one table

```sh
node n-way.mjs --wave r90=f --wave r91=f --wave r92=f --wave r93=f [--out dir] [--json]
```

`three-way.mjs` with the arity taken out. From the fourth wave on there is no
"the wave in between" to compare against: there are several, and the reason to
keep them all is that a number only means something beside the ones before it —
a recovery reads as a win without the middle columns, and a cost that halved
twice reads as a plateau without the first. The first `--wave` is the baseline
every other is folded against, so each column is `compare-runs.mjs`'s own fold
of that wave's ledger: one rule applied as many times as there are waves, rather
than one report quoting another. `recovered`, `still lost` and `gained` are all
statements about the **last** wave in the list, and every total is printed twice,
scored and raw.

### What the agent actually did

```sh
node lib/program-evidence.mjs <journals-dir> [--json]
node lib/surgery-evidence.mjs <journals-dir> [--json] [--interpreters <driver.log>]
node lib/round3-evidence.mjs <journals-dir> [--json] [--instance <id>]
```

The comparison answers what a wave cost. This answers what its agent *did*,
which is what settles a claim that a harness change acted: `recall` ordinals and
`render` keys named by a transition, frames that issued no call, frames that
applied no transition, calls that failed and whether their cell survived them,
`bash` calls carrying a payload as data against ones composing a shell string,
`test` calls and which of them asked for the pristine base, failed mutations, and
the cache rate. Every number is a count of `control.agent.*` events — no clock,
no network, no detector of its own — so a run's journal is the whole evidence and
a reading of it cannot drift from what happened. A database a live run is
mid-write in is reported unreadable rather than guessed at, so it is safe to run
against a wave still in flight.

`lib/surgery-evidence.mjs` answers the four next-steps the r91 report ended in,
and each is a count of the same events: `test` calls and which asked for the
pristine base; `bash` calls that used an absolute interpreter path against ones
that passed a bare `python3`; calls that went **hunting** for an interpreter —
`which python`, `ls /opt`, `sys.executable`, `conda env list` — against calls
that merely used the path they were handed, which is the distinction the whole
change turns on; results carrying `ModuleNotFoundError`; probes the flow itself
refused; and `model-retried` events, with `transport` counted apart because a
truncated response body was a class no retry classification saw until it was put
on the ladder. `--interpreters` sharpens "an absolute path" into "the path this
instance was told", by reading the `project interpreter` lines `run-instance.sh`
writes into the driver log.

`lib/round3-evidence.mjs` answers the next-steps the r92 report ended in, and
they are about two things the earlier readers have no column for.

**A vacuous-verification observation** is the controller telling a run that the
check it stored as `state.verification` is one it had already watched pass over
the tree it was handed. Nothing is refused when it fires, so the count alone
settles nothing: every firing carries its own after-record — how many frames the
run still had, whether it then stored a different proof, whether it went and
watched that same check fail, and how the run ended. The named check is matched
by re-deriving the text the observation quotes from the call's own input, so a
run that re-ran the check it was told about is told from one that ran a
different one.

**A ladder** is a maximal contiguous run of `model-retried` events. Every rung of
one sealed model step is journaled when that step settles, so a ladder's own wall
clock is read as the span from its frame's `turn-opened` to the rungs' shared
timestamp — the attempts and the sleeps together, which is the quantity
`defaultModelRetryWindowMillis` bounds. A ladder **survived** when the frame it
ran in went on to settle a model call; that is the only observable a transport
rebuild produces, because the rebuild itself is a process-internal exchange of
one HTTP client for another and no event records it. Ladders that did not survive
are split into ones that exhausted the declared rung count and ones that stopped
short of it.

```sh
lib/prompt-bytes.sh <driver.log> [index]
```

The cell contract's size is pinned by a unit test. The task prompt's is not: it is
rendered per instance out of the dataset row, the repository's own test command,
and the project interpreter measured off that instance's container. This renders
the prompt each instance was actually given — reading the interpreter back out of
the wave's own log rather than re-measuring it today — and prints its bytes. An
instance whose image answered nothing usable renders without the bullet and is
reported as `none`, so a wave that stated no fact is never credited with one.

`fixtures/check-program-evidence.mjs`, `fixtures/check-surgery-evidence.mjs`,
`fixtures/check-round3-evidence.mjs` and `fixtures/check-prompt-bytes.mjs` pin
every count against synthesised inputs whose every field is known, inside
`./verify.sh`.

### Excluded from the scoreboard, by name

`lib/excluded.mjs` is the only place this rig removes an instance from a
denominator, and it exists because three waves produced three different verdicts
for one byte-identical patch. `psf__requests-1766` and `psf__requests-2317` are
graded against `httpbin`: the container has no https route, `lib/httpbin.sh`
serves a documented local fallback that says in its own words it cannot answer
`test_mixed_case_scheme_acceptable`, and a re-grade against the public service
found that service degraded too. Those two rows are statements about the grading
environment, and no reading of them says anything about a harness.

Three rules make that scoping rather than tuning, and `fixtures/check-excluded.mjs`
enforces all three:

1. **Both arms, or neither.** An exclusion removes the row for flows and for
   codex identically. `compare-arms.mjs` computes the four-cell table over the
   scored intersection *and* over the raw one, and prints both.
2. **The cause is documented and names something outside the agent** — a
   container, a public service, a dataset defect. A cause mentioning a harness,
   a prompt or a model fails the check.
3. **Both denominators are printed, always.** Every rate in `compare-runs.mjs`,
   `three-way.mjs`, `compare-arms.mjs` and `fullbench-report.mjs` states the
   scored count and the raw count in the same sentence: on the 45-instance
   population that reads **43 scored of 45 run**, never 43 alone. Excluded
   instances keep their per-instance rows and are marked there. A population
   that excludes nothing reads exactly as it did before the list existed.

The repair that ends the exclusion is an https listener the graded container
trusts, at which point both rows are measurements again and both arms can be
re-graded against it. Delete the entry when that lands.

### Proving both without spending a token

`fixtures/check-run-45.mjs` drives the whole scheduler through
`SWB_RERUN_INSTANCE_CMD`, a stub that stands in for the per-instance pipeline:
the derived population, the resume boundary, the concurrency bound (measured from
the stub's own overlap, not from the configured number), `--limit`, `--stop` and
resume after it, the budget gate's pause row, and the refusals.
`fixtures/check-compare-runs.mjs` replays the comparison over synthesised
ledgers, `fixtures/check-three-way.mjs` the three-column one and
`fixtures/check-n-way.mjs` the n-column one; all three put a real excluded id
through the fold and check that it leaves every total and every movement row
while keeping its own row and its raw column.
`fixtures/check-excluded.mjs` checks the list itself. All run inside
`./verify.sh`, which needs no docker and no dataset. The per-instance pipeline
itself is `lib/fullbench-instance.sh`, already proved against real docker by
`./fullbench-dryrun.sh`.

## Score

```sh
node scorecard.ts --report flows-cell-harness.<wave>.json
```

It reads every `flows-cell-harness.*.json` report in this directory, the
journals under `work/`, the stamps under `timings/`, and the patches under
`patches/`. Flags override each of those (`--work`, `--patches`, `--timings`,
`--reports`, `--model`, `--baseline`, `--instances`, `--out`).

`scorecard.json` and `scorecard.md` open with the wave's **preconditions** —
the subject stamp, the git HEAD, the `CellTurn.ts` hash, the path it was loaded
from, the `packages/smithers/dist/esm` hash, the node version, any refusal the
preflight recorded, and an `agreement` line stating whether every instance ran
the same pinned subject. Copy that block into the wave report; do not retype it.
An `agreement` line reading `MISMATCH` means the wave is two measurements and
must not be reported as one.

They then grade every instance on all three dimensions and against the committed
codex baseline:

- **quality** — the verdict from the evaluator's report (`resolved`,
  `unresolved`, `empty patch`, `eval error`), patch size, and whether the run
  ever landed an edit;
- **speed** — wall clock from `timings/<id>.json`, the journal's own span,
  turns, model calls, and per-call latency when the journal carries it;
- **cost** — input, cached and output tokens, and USD from `prices.ts`, in two
  columns: `flows USD` is the seat's model turns, and `Jev USD` is every reading
  the run took of Jev, priced under the `typesafe-ai/jev` row. The journal
  meters Jev on three event types and the scorecard sums all three:
  `claim-demanded` (the completion brake), `supervisor-settled` (the per-frame
  supervisor) and the `jev` flow's own `cell-call-settled` result. A
  `decision-settled` row repeats a reading without usage and is never priced.
  `flows total` is both columns together; the codex arm asks Jev nothing, so
  its column is model-only either way. `lib/run-cost.mjs` reports the same
  split as `jevCalls`, `jevInputTokens`, `jevOutputTokens`, `jevUsd` and
  `totalUsd` beside `usd`.

The flows-side numbers come from the run's journal through
`Forensics.digest` — the same projection `flows status` renders — so the
scorecard and the CLI cannot disagree about what a run did.

Two caveats the output states for itself:

- **Per-call latency** is reported as unavailable until the journaled
  `model-settled` event carries a duration. The scorecard reads any of the
  plausible field names and never requires one, so it works before and after
  that lands.
- **The codex USD figure is a floor.** The committed baseline records one total
  token count per instance, with no input/output split, so it is priced
  entirely at the input rate. Real codex cost is higher.

## The seeded sample

`sample.json` is regenerated, not committed, and the procedure is pinned:
mulberry32 seeded with **20260818**, a standard backward Fisher-Yates shuffle
over the dataset in dataset order, then the first _n_ rows. The dataset ships
sorted by `instance_id`, so the draw does not depend on which order a caller
believes it is using.

The first five draws are the drive's regression suite:

1. `astropy__astropy-8707`
2. `django__django-16612`
3. `pydata__xarray-7393`
4. `pytest-dev__pytest-6197`
5. `sphinx-doc__sphinx-11445`

Draws 6 through 8 are `pydata__xarray-7233`, `matplotlib__matplotlib-20826`,
and `astropy__astropy-14365`.

`lib/sample.mjs` asserts the five, and `bootstrap.sh` fails if the assertion
fails. **If that assertion ever fails, stop.** It means the dataset revision or
the procedure changed under the drive, and every committed baseline number is
about different instances. Find out which changed; do not benchmark against a
different sample and do not edit the pinned list to match a new draw.

## Standing rules of the drive

- **The current sample's failing instances are the regression suite.** They stay
  the target until all of them pass. A wave that improves an already-passing
  instance and leaves the failures untouched has not moved the drive.
- **Grow the sample slowly.** Add instances only when the current set is
  understood, and take them in draw order from `sample.json` so the set is
  always a prefix of the same seeded sequence.
- **Always run codex on the same instances.** A flows number without a codex
  number on the same instance, same model, same budget, same container and
  **same prompt** is not a comparison. Add the codex result to
  `baseline/codex-comparison.json` when the sample grows.
- **Anything one harness is taught, both are taught.** The two prompts differ
  only where they name a harness's own tools — the `write` flow, and the Jujutsu
  colocation the flows CLI creates in its own workspace. Everything else,
  including the repository's test runner, is environment teaching and goes to
  both sides. `fixtures/check-prompts.mjs` lists the flows-only lines and fails
  on a sixth one, because this is the rule the rig has already broken once: see
  [The prompts](#the-prompts).
- **Both-fail instances are acceptable.** Some instances have hidden tests that
  reject the obvious fix. Recording `both fail` is a result, not a gap to close.
- **Any flows win gets called out explicitly.** The scorecard labels each
  instance `FLOWS WIN`, `codex win`, `both pass`, or `both fail`, and counts
  wins in the aggregate line. Say so in the write-up when the count moves.
- **One wave, one subject.** Pin with `./preflight.sh` before the first
  instance, and do not edit any package the CLI loads until the last one
  finishes. `flows.sh` enforces this and stops the wave when the subject moves;
  a wave that has to be restarted is cheaper than a wave whose report names a
  commit half of it did not run.
- **Never special-case an instance.** Not in the sampler, not in the queue, not
  in the disk gate, not in the grader, not in a report. The full benchmark runs
  500 instances through one pipeline and the only per-instance distinction it
  draws is the one the operator declared for a reason the code states: the five
  images the matrix pinned are kept warm. An instance that needs different
  treatment is a defect in the treatment.
- **A full-benchmark number is one attempt.** It sits beside the matrix's
  single-attempt column and nowhere near either best-of-n column. A write-up
  that prints it against a best-of-5 is comparing one draw with the best of five.
- **Grading is the official evaluator.** Never grade a patch by reading it.
- **A best-of-n number names how it was chosen.** The flows column is the
  selector's pre-grading choice and the codex column is an oracle; a write-up
  that prints them side by side without saying which is which is claiming a win
  the measurement does not support. Say it in the sentence that carries the
  numbers, not in a footnote. See [Best-of-n](#best-of-n).
- **The selector never sees the answer.** It reads `journals/` and `patches/`
  and nothing else, and it runs before grading. A change that gives it any other
  input — the evaluator's report, the dataset row, a hand-written verdict —
  turns every best-of-n number the rig has ever produced into an oracle.
- **Never correct a patch by hand.** If a captured patch holds something the
  agent did not write, that is a capture defect: fix `lib/capture-patch.sh` or
  `lib/snapshot-base.sh` and re-derive with `regen-patch.sh`. A patch edited
  after the fact grades a different artifact from the one the run produced, and
  it cannot be reproduced by the next wave.

  One recorded exception exists, and it is the reason the rule is written down.
  At the time, a **codex** run deleted its workspace unconditionally when it
  finished, so its patch could not be re-derived once the run was over.
  The 2026-08-20 sphinx correction therefore removed the whole
  contaminated `tox.ini` file section from the recorded capture rather than
  re-capturing, and the corrected patch still carries the pre-fix
  `old mode`/`new mode` lines that `lib/capture-patch.sh` no longer emits. That
  is admissible only under all three of these conditions, each of which that
  correction meets: whole file sections are dropped and no line is rewritten,
  the untouched capture is committed beside it, and the official evaluator
  re-grades the result. A future codex baseline should be re-run instead.
  Successful non-empty captures still delete their workspaces; failed and
  empty captures now retain them as described under "Patch capture".

## The committed baseline

`baseline/codex-comparison.json` and `baseline/patches-codex/` are the Codex CLI
results from the 2026-08-18 wave: `gpt-5.6-sol`, reasoning effort medium, the
same extracted checkouts and containers, graded by the official evaluator.
**Codex resolved 5 of 5.**

It was recorded as 4 of 5 until 2026-08-20. The `sphinx-doc__sphinx-11445`
verdict was decided by the patch-capture defect above, not by codex's patch:
captured against the base commit it carried the image's `tox.ini` churn, which
reverse-applied at grading. The agent-only content resolves. The committed
baseline patch is the recorded capture with that whole `tox.ini` file section
removed — not a re-capture, because a codex run deletes its workspace and there
is nothing left to re-capture from — so it still carries the pre-fix
`old mode`/`new mode` lines. See the hand-correction rule above for the
conditions that makes admissible. The evidence is in `baseline/evidence/` — the
evaluator's own report on exactly the committed patch, its summary, and the raw
contaminated capture the old rule produced, which is that patch plus the removed
section. **Sphinx is not a flows win.** Flows matched it in wave 4,
under the same correction, so the instance is both-pass; the only win on this
sample belongs to codex, on `pytest-dev__pytest-6197`.

The flows numbers recorded beside the baseline are from the wave that scored
1 of 5; the best recorded wave scored 4 of 5 (wave 4, 2026-08-20). Flows wins:
0. Those are the numbers to beat.

`fixtures/mirror-results.json` is what the flows side measured on that wave. The
journals themselves did not survive the scratchpad wipe, so `verify.sh` rebuilds
a journal carrying exactly those numbers and asserts the scorecard reports them:

```sh
./verify.sh
```

The default `./verify.sh` runs the same serial, token-free fixture suite as CI:

```sh
pnpm exec smthrs test //evals/swebench:offline --jobs 1
pnpm run check
```

Run these from this directory after the workspace dependency install. The offline
target declares the MJS, shell, Python, TypeScript and recorded fixture inputs.
It checks the scorecard, prompts, patch capture, CLI wrapper, ledger, scheduler,
locking and report behavior without a CLI build, Docker, evaluator venv, dataset
or funded model key. `.github/workflows/ci.yml` is generated from the root
`PACKAGE.ts`, which selects `//evals/swebench:offline` as a required test step.

The subject fingerprint, prompt-byte measurements and evaluator export checks
have separate prerequisites:

```sh
./preflight.sh
./bootstrap.sh
pnpm exec smthrs run //evals/swebench:prerequisites
```

That target requires the built CLI and `.venv-swb/bin/python`; a missing
prerequisite fails explicitly. It is an operator target and is not selected by
CI. Docker dry runs (`./fullbench-dryrun.sh`, `./codex-backfill-dryrun.sh`,
`./network-dryrun.sh`) and funded-model benchmark runs remain operator commands.

## `flows.sh`

The run scripts drive the CLI from an extracted testbed, which is an arbitrary
directory outside this repository. `flows.sh` resolves
`packages/smithers/bin/smithers.mjs` — the executable `@smthrs/cli` declares as its
bin — out of the checkout and execs it in place, so the CLI reads its project
flows from the workspace (`flows/fix/flow.mdx`) and keeps its control database
in the workspace's `.flows/`.

That shim runs `dist/esm/bin.js` when a build is there and falls back to
`src/bin.ts` under Node's type stripping when it is not. The fallback is what
makes `pnpm exec smithers` work in a source checkout, and it is exactly wrong
for a wave: the pinned subject is the build. So the wrapper refuses when
`packages/smithers/dist/esm/bin.js` is absent rather than measuring bytes no
fingerprint covers. `fixtures/check-cli-path.mjs` holds both halves.

The wrapper does not build. `./preflight.sh` builds and pins, once per wave, and
`flows.sh` checks itself against that pin on every invocation (see [The subject
under test](#the-subject-under-test)). The old rule was "build only when
`bin.js` is missing", which after the first wave is never — and since the CLI's
dependencies are loaded from the working tree, no rebuild rule could have
pinned them anyway.

Checked without spending tokens: `plan` renders the approval payload, `approve`
accepts it, and `run` reaches the model boundary and refuses with
`LaunchFailed: Set OPENAI_API_KEY to run the openai:gpt-5.6-sol seat` when no
key is exported. Everything past that boundary needs a funded key and is what
`run-instance.sh` exercises.
