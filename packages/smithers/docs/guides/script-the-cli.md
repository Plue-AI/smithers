---
title: "Script the CLI"
description: "Drive smthrs from a shell script or a CI job: read --json documents, branch on exit codes, and retry a command without duplicating its effect."
---

Write a script against three things the CLI promises: one document on stdout,
one status vocabulary, and an idempotency key per mutation. Nothing else about
the output is stable.

## Read the document, not the prose

Pass `--json` and parse stdout. The human rendering is the same document with
indentation, so both carry the same members in the same order, but only the
compact form is meant for a parser.

```bash
plan="$(smthrs flow plan deploy/status branch=main --json)"
approval="$(printf '%s' "$plan" | jq -c '.approval')"
```

stdout carries the document alone. Notices, banners, and the failure sentence
all go to stderr, so a parse never trips over a diagnostic. Redirect stderr
when you want it:

```bash
smthrs runs list --json 2>/dev/null
```

Add `--quiet` when banners or progress on stderr are unwanted. It never
suppresses the stdout document, so `smthrs runs list --json --quiet` remains valid
input to a JSON parser.

`--silent`, `--verbose`, and `--audience human` preserve the retained fork
workspace for `runs resume <run-id>`.

## Branch on the status

```bash
smthrs flow execute "$approval" --json
case $? in
  0)   echo "run completed" ;;
  1)   echo "run failed, or the command did"; exit 1 ;;
  2)   echo "the command line is wrong"; exit 2 ;;
  3)   echo "parked at waiting-approval" ;;
  130) echo "cancelled or interrupted" ;;
  143) echo "terminated" ;;
esac
```

Status 3 is the one outcome the payload alone cannot tell you: the run did not
fail, it is waiting for a decision. Status 2 is the one that means retyping the
command can help.

The statuses that report a run outcome, rather than a failure of the command,
are decided from the control receipt. That only happens when this process owns
the executor, which a local composition does and a `--remote` client does not.
See [Local and remote control planes](../concepts/local-and-remote.md).

## Answer a park

Exit 3 happens two ways, and the receipt tells them apart.

A `Parked` receipt means the Plan carries no grant. Approve the same payload
you submitted to record the grant, then submit it with `flow execute` to launch
the run. Reuse the payload's `idempotencyKey` for both commands. Plan approval
alone returns no `runId` and starts no execution:

```bash
status=0
receipt="$(smthrs flow execute "$approval" --json)" || status=$?
if [ "$status" -ne 0 ] && [ "$status" -ne 3 ]; then
  exit "$status"
fi
if [ "$(printf '%s' "$receipt" | jq -r '._tag')" = "Parked" ]; then
  smthrs approvals approve "$approval" --scope run --json
  receipt="$(smthrs flow execute "$approval" --json)"
fi
```

An `Accepted` receipt with exit 3 means the run started and then parked on an
in-run Node approval. The run journals a `control.approval.requested` event
whose `payload.question` describes the ask and whose `payload.payload` is the
exact argument for `smthrs approvals approve`. Approving that Node resumes
the existing run; it needs no new `flow execute` submission:

```bash
run_id="$(printf '%s' "$receipt" | jq -r '.runId')"
ask="$(smthrs runs logs "$run_id" --json \
  | jq -c 'map(select(.kind == "control.approval.requested")) | last | .payload.payload')"
smthrs approvals approve "$ask" --scope once --json
```

`--scope` decides how far the grant reaches: `once` answers this ask alone,
`run` covers the whole run, and `remembered` covers every later run.
`smthrs approvals approve` defaults to `run`, matching what `smthrs flow start`
grants itself. Pass the scope explicitly in scripts.

Use `smthrs runs resume <run-id>` to retry taking up a run if its approval was recorded without an
executor available to resume it.

## Retry safely

Every mutation the CLI sends carries an idempotency key, so re-running a
command that already took effect replays the recorded receipt instead of
performing the operation twice.

| Verb | Key |
| --- | --- |
| `runs cancel` | `cli:cancel:<run-id>` |
| `runs signal` | `cli:signal:<run-id>:<payload digest>` |
| `runs steer` | `cli:steer:<run-id>:<uuid>` |
| `approvals approve`, `approvals deny` | The `idempotencyKey` member of the payload you pass |

`runs signal` includes the payload digest because two different signals to one run
are two mutations. Sending the identical payload twice replays the first
receipt; sending a different one delivers a second signal.

`runs steer` mints a fresh key per invocation, so two identical steering messages
are two messages.

## Wait for a run without polling

```bash
smthrs runs logs "$run_id" --follow
```

Follow mode streams one line per event as it lands, and applies the per-event
1 MiB cap without retaining prior events. A finite read (`smthrs runs logs
<run-id>`) retains at most 50,000 events and 16 MiB and fails with a typed
resource-limit error rather than truncating.

Attached `flow execute` and `flow start` wait for settlement when this process
owns the executor. `approvals approve` and `approvals deny` wait when deciding an in-run Node approval;
a Plan decision has no run to wait for.

## In CI

- Set `CI=true`. `Ui.isInteractive` is false whenever `CI` is `"true"`, either
  stream is not a terminal, or `TERM` is `dumb`, so every interactive rendering
  falls back to plain lines.
- Pass `--root` explicitly when the job's working directory is not the project
  root, rather than relying on the upward walk.
- Run `smthrs doctor` as a first step. It runs nothing, exits 1 on a blocking
  problem, and its `--json` report is one object with a `root` and a `checks`
  array.
- Use `smthrs runs cancel-all --root "$project_root" --json` in an always-run
  step, with `project_root` set to the job's project directory. It reads every
  page and cancels every nonterminal run through one control connection. Use
  `smthrs gc --older-than <duration>` to bound how much the databases keep.

## See also

- [Output and exit codes](../concepts/output-and-exit-codes.md): what makes a
  rendering deterministic, and what refuses.
- [Launch a detached run](./launch-a-detached-run.md): starting a run that
  outlives the script.
- [Diagnose a run](./diagnose-a-run.md): reading back what a run did.
