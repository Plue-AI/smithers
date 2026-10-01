---
title: "Launch a detached run"
description: "Start a run that outlives the shell with smthrs flow start -d, learn its run id from the admission line, find its log, and end it."
---

`smthrs flow start -d` launches a flow in a process of its own and returns as soon as
that child proves the run row is durable. Use it when the shell that starts a
run is not the shell that waits for it: a terminal you are about to close, a
CI step that only needs the run to exist, a supervisor that will poll.

## Launch it

```bash
smthrs flow start deploy/status --data '{"branch":"main"}' -d --json
```

```text
{"detached":true,"logFile":"/srv/deploy/.flows/logs/run-01J9.log","runId":"run-01J9"}
```

Three members, and that document is the only place a caller learns which run
started: there is no `--run-id` flag. Capture it:

```bash
launch="$(smthrs flow start deploy/status -d --json)"
run_id="$(printf '%s' "$launch" | jq -r '.runId')"
log="$(printf '%s' "$launch" | jq -r '.logFile')"
```

The child runs with the project root as its working directory and inherits this
process's environment. Of the flags, only `--mcp-config`, resolved to an
absolute path, and `--root` are passed through.

## How the launch knows the run is real

The child re-executes the CLI as `smthrs run <payload>` with a nonce in
`SMITHERS_INTERNAL_DETACHED_ADMISSION`. As soon as the control plane accepts
the launch and the run row is durable, the child writes one admission line
naming that nonce and the run id to its own log. The parent reads that line and
returns.

The ID must be 1 to 128 characters, start with an ASCII letter or digit, and
contain only ASCII letters, digits, `.`, `_`, or `-`. Other IDs are ignored as
missing admission, so a log line cannot redirect the log outside its directory.

Until the line appears, the child's output lands in
`.flows/logs/pending-<nonce>.log`, which is renamed onto the run id once the
run is known. The parent waits `SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS`
milliseconds, 30000 by default. A child that is silent past that window but
still alive gets a slow-boot line on stderr. The total admission deadline is
four times the window; after it, the parent terminates the child and reports
failure:

```text
smthrs: detached engine (pid 37916) is still booting after 30s; waiting up to 120s.
```

A first launch in a fresh project often crosses that line, because the engine
database still has to be created and migrated.

The selected flow loads without a separate deadline and logs progress every
30 seconds. The admission deadline remains the bound on a detached start.
Catalog entries use `SMITHERS_FLOW_LOAD_TIMEOUT_MS` (30000 ms by default);
a catalog `load_timeout` is retried on first use. Failure reports name the
limit that fired, including its setting and duration.

The receipt confirms that the run was persisted. It does not report settlement.
An attached local launch or resume prints its receipt only after settlement.

Until admission succeeds, the parent owns the child. Interrupting the wait or
encountering a launch error triggers cleanup before the CLI exits: SIGTERM,
then SIGKILL if needed, with a bounded wait for termination. POSIX cleanup
targets the process group; Windows cleanup targets the child handle. After
the receipt is returned, the child outlives the launcher.

## Follow it

Everything else the child writes goes to the log, including the launch sentence
for a run that no executor takes:

```bash
tail -f "$log"
smthrs runs logs "$run_id" --follow
smthrs runs show "$run_id"
```

`tail` reads what the child process printed. `smthrs runs logs` reads the run's
durable control events through the control plane, which is the same view any
other process gets.

## End it

```bash
smthrs runs cancel "$run_id"
```

`runs cancel` is durable and cross-process: the child sees the cancellation through
the control plane, not through a signal. `smthrs runs cancel-all` cancels every
non-terminal run in the project, which is the right thing in an
always-run cleanup step.

## When it refuses

- **`--remote` or `SMITHERS_REMOTE` is set.** A detached launch spawns a local
  executor, so the combination exits 1 rather than launching something the
  remote plane will never drive.
- **The flow id starts with `system/`.** Those ids are reserved by the control
  catalog and rc.0 ships a body for none of them.
- **The child never reached admission.** The launch exits 1. Its failure report
  includes `Log: <path>` and the last 32 KiB of output. Read the retained
  `.flows/logs/pending-<nonce>.log` at that path for the full output. Interrupted
  launches also retain the pending log. Remove failed launch logs manually when
  they are no longer needed.

## A run nothing drives

A module flow launched this way settles at `accepted` with
`waitingReason: "executor"` and stays there, because the CLI's agent host
drives prompt flows and a flow whose body is a module (`flow.ts`) is driven by
the host program that registers its delegates. That is a real wait for a real
external executor, so the run is not a bug and does not time out.

`smthrs runs list` labels it, `smthrs runs show` diagnoses it as `pending`,
`smthrs runs cancel <run-id>` ends it, and the detached child writes the
same explanation to its log at launch time.

## See also

- [`smthrs flow`](/cli/flow): the full reference for `flow start`.
- [Script the CLI](./script-the-cli.md): exit codes and idempotency keys.
- [The project and its state](../concepts/project-and-state.md): where the log
  files live.
