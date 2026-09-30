---
title: Burndown monitor
description: Host selection and health reports for a watched burndown run.
---

## Start

Start `burndown/monitor` in the same host checkout as the watched run, or pass
a `hostRoot` with `runId`. Omitted roots use the checkout where the monitor
loads; relative roots resolve from that checkout. Every run inspection passes
the canonical root explicitly and clears inherited remote, database and Node
loader overrides. Inspections execute `<hostRoot>/packages/smithers/bin/smithers.mjs`
with the observer's absolute Node executable; Bun execution is refused. The entry must resolve inside the
watched checkout. Supply a frozen source checkout with its own pinned dependencies;
the observer never falls back to a global `smthrs` or its own mutable CLI.
Missing or escaped CLI entries produce unknown/unhealthy evidence.
`reportRoot` selects the directory containing `status.txt`, `NEEDS-YOU.md`, and
append-only `monitor.log`; its default is `<hostRoot>/.smithers/burndown`.
An explicit relative `reportRoot` resolves from the monitor checkout.
The default seat remains `claude-code:sonnet`. Both monitor entry points require
an explicit operator launch and are excluded from model invocation.

`runId` must be nonempty, must not start with `-`, and must contain no whitespace
or control characters. `everyMinutes` must be finite and positive, with a duration
no larger than the maximum safe integer in milliseconds. Positive fractions are
accepted. Invalid identities and intervals fail before inspection or diagnosis.

CLI inspections stop after 15 seconds. Missing runs, mismatched identities,
unrecognized statuses, malformed output, and command failures produce unknown
inspection evidence and an unhealthy report. Unknown inspections retry on the
next interval; only a confirmed terminal run stops the monitor. Failed and
cancelled runs remain unhealthy even if the model returns a healthy verdict.

Inspection and diagnosis errors also retain an unhealthy report and retry on the
next interval. Failure receipts omit raw command and model diagnostics.

Diagnosis receives bounded typed journal summaries and redacted supplemental
operator notes. Reports retain the verdict and health result.

Version 6 adds durable progress inspection and changes callback and action implementation identities.
Start a new monitor execution; existing persisted rounds are not migrated.

The monitor reads read-only `runs inspect` and `runs logs` for the selected root and its recorded flow
descendants, retaining round ordinal, scheduled waits, running or settled actions
and typed worker/queue outcome counts. It parses bounded JSON before summarizing;
raw run lists, model counters and command diagnostics are not health evidence.
Missing or partial journal/results remain unhealthy/unknown. Status notes are
supplemental. A long check or a timer wait does not prove a stalled run; missing
evidence calls for read-only inspection, never cancellation or relaunch.

Health evaluates the newest observed round and its attached descendants, not old
round failures. Skipped checks remain unknown until successful completion confirms an untaken
branch; deferred checks remain pending.
A timer more than two round intervals overdue is unknown/unhealthy. Nested queue
failures and unavailable current action results remain visible.

Inspection subprocesses receive only basic location, locale and terminal
environment variables. Provider credentials and connection overrides are excluded.
A report-write failure retains its failed action receipt and retries next round;
it never claims that a report was saved.

Observe and Settle previews often exceed the engine’s 2 KB preview cap. The
monitor uses full recorded round-state counts and selected workers’ settlements
instead. Missing landing or worker results remain unknown. Inspection reads at most
10,000 journal events; an incomplete frame window remains unknown/unhealthy.

Current round observations determine lineage status; a completed root row can
be a handoff while later rounds run. Successful typed Complete results confirm
completion even when informational previews are truncated. `show` and `devtools`
are excluded because they can reconcile history gaps by writing to stores.

The read-only log stream accepts plain arrays and notice-bearing numeric objects.
It reads the oldest 10,000 entries; longer runs remain unknown until a supported
complete window is available. Buffer or timeout limits also remain unknown.

A truncated Launch preview uses native detached worker observations owned by the
current round and created within its recorded Launch window. Missing windows or
children and selected execution projection gaps remain unknown.

Referenced workers without observations and unresolved ownership gaps after a
truncated Launch remain unknown; retries retain workers already launched by the
current round. A watched-root projection gap also prevents healthy lineage claims.
