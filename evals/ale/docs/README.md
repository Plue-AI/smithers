---
title: Agents’ Last Exam
description: Run prerequisites and evidence requirements for the ALE adapter.
---

## Scope

ALE is pinned to `d10fb61a14f9719774c3520c5763068b28ef5546`.
[docker_support.txt](../docker_support.txt) retains its exact 99-task Ubuntu
roster. The evidence gate covers one attempt of variant zero per task, per arm.
It refuses incomplete rosters rather than shrinking the denominator.
No oracle pass, Cloud deployment, or paired result has been recorded.

[requirements.json](../requirements.json) lists every pinned task card, VM
requirements, Docker membership, and source locations mentioning model judges.
This is a static inventory; optional or transitive judge requirements still need
an executed preflight. Windows/license snapshots require matching Windows
software; GPU cards require the declared GPU VM. The six nested-runtime tasks
excluded upstream require a full guest with Docker, Apptainer, or Singularity.

## Run prerequisites

- Approved [Hugging Face task archive](https://huggingface.co/datasets/agents-last-exam/agents-last-exam-data-archive) access; download using upstream `scripts/fetch_task_data.sh`.
- A Smithers Cloud Linux host with Docker and sufficient capacity for the published image (about 105 GB uncompressed), task data, and the task card’s CPU/memory limits. Do not pull this image onto a space-constrained development host.
- Node 26.4 or later on the control host.
- A built immutable Smithers checkout, including `packages/smithers/dist/esm/bin.js` and executable `target/release/smithers-jj-export`.
- A configured Smithers subscription account pool serving the ChatGPT route, with a subscription login in the pool, `SMITHERS_ACCOUNT_POOL_URL`, and host credential `SMITHERS_ACCOUNT_POOL_KEY`. Native Codex seats are refused: their separate MCP channel is outside the recorded ALE trajectory and their prompt drops images.
- Completion judge credential `AI_GATEWAY_API_KEY`. Model-graded tasks also require their upstream OpenAI/Gemini judge credentials. Keep all credentials on the control host.

Use upstream’s Docker **environment** with the deployer’s **local** executor:
the harness runs outside the task sandbox and connects to the remote shell and
computer-use MCP bridges. Set `SMITHERS_ROOT` to the immutable built checkout,
put it and the pinned ALE checkout on `PYTHONPATH`, and reference
[configs/agents/smithers.yaml](../../../configs/agents/smithers.yaml) in the ALE
experiment. `install()` discovers both bridge catalogs; `launch()` uses the
current public `flow start --wait` command with a named TypeScript `Flow.make`
and `AgentAction` layer and requires a completed journal plus
Sol/max/ChatGPT route evidence. Generated flows use public package imports. The trusted `runtime.mjs` Node
preload resolves these against the pinned host checkout, including when the
native runtime snapshots a flow. No dependency install is made per episode.
The explicit capability patterns match the existing opaque MCP contract.
Cancellation reaps the process group.

Inherited `SMITHERS_*` settings are stripped, then only the configured pool
endpoint/credential/ChatGPT provider and the adapter’s isolation settings are
added. Each episode also uses a fresh vendor home without a Codex login.
The host filesystem flows are absent and host shell access is sealed to a
random nonexistent container. Task operations go through ALE’s MCP servers.
The deployer records CLI/helper/preload entry SHA-256 identities and the resolved
host package entry identities, raw control bindings,
stdout/stderr, and the durable journal. Artifact parsing uses ALE-v1.0
`TrajectoryBuilder`. Image content within the journal’s 65,536-byte value bound
becomes a structured observation; larger results remain truncation markers.
Desktop screenshots commonly exceed that bound. Full screenshot retention
and live model propagation remain required before computer-use acceptance.
The parser does not assign rewards. Missing or corrupt journals produce a
system gap.

Screenshots preserved in an ALE trajectory do not establish that the Smithers
model consumed those images. Computer-use acceptance still requires a live
screenshot propagation check. The upstream Codex deployer uses a fork and API
routing; it is not the stock subscription baseline. A sealed stock Codex runner
and matched Cloud run remain required before publishing a comparison.

## Oracle and pair gates

The upstream dummy oracle is best-effort and skips missing positive fixtures.
Do not treat its successful launch as a passing oracle. Retain normalized
receipts for all 99 tasks with these fields:

```json
{"task_path":"<pinned ID>","variant_index":0,"status":"completed","eval_status":"completed","reward":1.0,"oracle":{"inputs_verified":true,"positive_outputs_copied":true,"skipped":false}}
```

Each arm must cite one full 40-character lowercase harness commit across its
roster; the two arms may use different commits.
Each oracle boolean must come from checked fixture-copy/input receipts, never
from the dummy’s exit status alone. The strict validator rejects missing
fixtures, nonperfect rewards, duplicates, missing/extra tasks, and infrastructure
errors. Preserve the original episode and fixture receipts beside the normalized
file; normalization itself is not evidence that the run occurred.

```sh
python3 evals/ale/gate.py oracle <oracle-records.json> > <oracle-gate.json>
python3 evals/ale/gate.py pair <paired-records.json> \
  --oracle-receipt <oracle-gate.json> > <pair-gate.json>
```

Paired records additionally name `arm` (`smithers` or `codex`), `model`
(`gpt-6-sol`), `reasoning_effort` (`max`), `auth_mode` (`chatgpt`), immutable
`harness_revision`, and `oracle_gate_digest` (`sha256:` plus the SHA-256 of the
exact oracle-gate file). Both arms must share its digest and the roster. Zero
and fractional task rewards are valid; graded agent timeouts or failures may
use `failure_kind` (`agent_timeout`, `agent_nonzero`, or `model_failed`), with
their original failure receipts retained; missing grading and infrastructure
errors are not. The CLI binds a paired gate to the supplied oracle receipt and
records source/roster hashes. Its checks cannot authenticate operator-generated
receipts; retain and review the underlying Cloud run evidence.

## Offline validation

The gate tests need only Python and include the host pool-ownership contract.
Parser and process tests need the pinned ALE
package and Pydantic; they use its actual public models, not Harbor ATIF or
replacement models. Point `ALE_TEST_SCRATCH` to a disposable directory.

```sh
python3 -m unittest discover -s evals/ale/fixtures -p check_gate.py
ALE_TEST_SCRATCH=<scratch> PYTHONPATH=<ALE-checkout> \
  python3 -m unittest discover -s evals/ale/fixtures -p 'check_*.py'
```

These checks cover evidence validation, artifact translation, subscription
bindings, process cancellation, and real CLI module/journal execution using
synthetic events. `check_cli.py` requires the built host checkout. They do not provision a sandbox, execute
ALE graders, or measure model performance.

Upstream code is Apache-2.0 and task data is CC BY 4.0; the retained roster and
metadata are derived from [ALE](https://github.com/rdi-berkeley/agents-last-exam/tree/d10fb61a14f9719774c3520c5763068b28ef5546).
