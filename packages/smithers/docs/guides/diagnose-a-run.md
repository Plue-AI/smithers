---
title: "Diagnose a run"
description: "Work out why a run stopped: check the machine with doctor, read the status card, follow the transcript, print a node output, and file a bug with the digest attached."
---

Use `doctor` to inspect the local setup, then `runs show`, `runs logs`, and
`runs output` to read a run through the control plane. Those run commands also support
`--remote`.

## Is the machine ready?

```bash
smthrs doctor
```

`doctor` does not start a run. It reports the project root it resolved, how many flows
the registry discovered and one line per discovery warning, both database files
with how many migrations each has recorded, the running Node against the
supported range (26.4.0 or later), whether `jj` is executable,
which supported provider credential variables are set, and any Smithers 0.x
state beside the project.

Each check is `ok`, `warn`, or `fail`. A `warn` is a fact you should know that
stops nothing. A `fail` is a fact that will stop the next command you run, and
one `fail` makes `doctor` itself exit 1.

`--json` prints the report verbatim: an object with `root` and a `checks` array
of `{ name, level, detail }`. On a terminal the human rendering adds symbols
and a verdict line; on a pipe it is one line per check.

Reach for `doctor` when a flow discovers nothing, when a command wrote to a
database you did not expect, or when a launch is refused for a missing
credential.

## What happened to this run?

```bash
smthrs runs show <run-id>
```

`runs show` returns the run and its `diagnosis`, computed from the run's
journal events alone. It names the run by its flow: the engine runs every
planned flow inside an `agent/run` execution, and `runs show` reports that
wrapper under the flow's own name. `updatedAt` is the run's last recorded
progress; status-monitor checks do not advance it. `diagnosis.endedAt` stays
empty until the run settles.

`executions` lists what the run is doing: the run's own row first, then every
execution it spawned that is still live, then the latest settled ones, up to
20 rows (`executionsOmitted` counts the rest). Each row names the flow, its
status, the execution that spawned it, its round, its start and finish times,
and `running`, the actions it has scheduled and not yet settled:

```text
executions[2]{executionId,flowName,status,parent,round,startedAtMs,finishedAtMs,running}:
  run-1,parent,running,null,0,1790824422570,null,parent/Spawn
  1df0…/child,parent/child,running,run-1,0,1790824422810,null,parent/Hold
```

The rendered diagnosis card:

```text
Verdict   failed: Set OPENAI_API_KEY to run the openai:gpt-6-sol seat
Run       run-1 · hello · 0s
Trace     e83057ff72f0ed05c32463dd33e97d72
Activity  0 turns · 0 calls (0 refused, 0 duplicate) · edits 0/0
Tokens    0 in / 0 out
Cause     Set OPENAI_API_KEY to run the openai:gpt-6-sol seat
Next      smthrs runs logs run-1    # turn-by-turn transcript
```

Lines appear only when they have something to say. A run whose model calls
were priced gains a `Cost` line under `Tokens`: their USD total, each call at
its provider's reported charge or else its usage at the model's rate card. A
run with refused flow calls gains a `Refusals` line, aggregated by message with a count, which is
usually where a stuck agent's real problem is. A run Jev read memory for
gains a `Memory` line: the ids of the memory it was brought, then those
withheld as unneeded (`smthrs memory notes get <id>` shows one).
`smthrs runs show <run-id> --json` carries the same lists as
`diagnosis.memory`, and a client reads the same `relevance-settled` rows from
the run's `run-events` projection. A run that is still waiting
gains an `Unblock` line, and that line is the point of the card. It names
what ends the wait:

- A run parked on an approval:
  `smthrs approvals approve '<payload>' --scope run`, then
  `smthrs runs resume <run-id>`.
- A run no executor took, which `runs list` lists as `accepted` with
  `waitingReason: "executor"` and the card calls `pending`:
  `smthrs runs cancel <run-id>`, or run the flow from the host program that
  registers its delegates.

## What happens to subprocesses after a crash?

The local control executor records agent shell and configured MCP subprocesses
in the execution journal. On normal shutdown it escalates termination after
two seconds if a child does not stop. After a crash, the next local control
executor startup checks those records and reaps verified children whose owner
has died. It leaves another live CLI's children alone and refuses to signal a
process whose identity it cannot verify.

Startup cleanup can therefore happen while running a local control command,
not only when resuming the crashed run. Remote clients do not reap local
processes. Cleanup does not undo filesystem writes or other completed effects.

## What did it do, step by step?

```bash
smthrs runs logs <run-id>              # the recorded events, then stop
smthrs runs logs <run-id> --follow     # the recorded events, then new ones until the run settles
smthrs runs logs <run-id> --json       # the raw event stream
```

The human rendering prints one line per step: each action a run or its spawned
executions start and settle, each spawned execution's start and outcome, agent
turns, and printed output. Without `--follow` it stops at the newest recorded
event and ends with `End of recorded events` and the run's state; a run that is
still live suggests `--follow`. With `--follow` it keeps printing until the run
settles or you press Ctrl-C, which stops watching and leaves the run running.
`--json` is the raw `ControlEvent` stream in both modes, byte stable for a
script.

A finite read retains at most 50,000 events and 16 MiB, with a 1 MiB cap on any
single event, and fails with a typed resource-limit error rather than
truncating. Follow mode applies the per-event cap without retaining history.

## What did a step produce?

```bash
smthrs runs output <run-id>             # every registered node output
smthrs runs output <run-id> result      # one node
```

`runs output` projects the node outputs a run registered. A node id the run does not
have is a usage error naming the run, not an empty document, so a script never
mistakes "no such node" for "no output".

Node outputs are caller-controlled data, so they are rendered through
`Output.renderValue`. That means a stored value shaped like a control receipt
cannot change the command's exit status.

## Report it

```bash
smthrs bug "flow start hangs after the second turn" --run <run-id>
```

The summary may be quoted or supplied as separate words. Omitting it prompts on a TTY;
on a pipe, the CLI exits 2 before opening project state.

`bug` collects the context a maintainer always asks for: versions, platform,
only the named run and its event digest. Without `--run`, no runs are included. Everything it
collects passes through the journal's shared redaction rules before it leaves
the machine, and the report is refused outright if it contains a callable, a
proxy, a `toJSON` member, or a value past the walk limits, because those could
run code while the report is rendered.

The exact redacted JSON payload and endpoint are printed to stderr before any post.
Use `--dry-run` to inspect them without sending, including when `--yes` is also set.
Posting requires `--yes` or confirmation on an interactive TTY; declining or
omitting consent in a non-interactive session sends nothing and exits 2.

Reports go to `https://bug.smithers.sh/api/bugs` unless
`SMITHERS_BUG_ENDPOINT` names another one.

## See also

- [Output and exit codes](../concepts/output-and-exit-codes.md): the status
  each of these commands exits on.
- [Script the CLI](./script-the-cli.md): answering a park from a script.
- [`smthrs runs`](/cli/runs) and [`smthrs doctor`](/cli/doctor): the per-verb reference.
