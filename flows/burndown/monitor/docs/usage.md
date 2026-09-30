---
title: Burndown monitor
description: Host selection and health reports for a watched burndown run.
---

## Start

Start `burndown/monitor` in the same host checkout as the watched run, or pass
an absolute `hostRoot` with `runId`. Every run inspection passes that root explicitly and clears inherited remote
and database connection overrides.
`reportRoot` selects the directory containing `status.txt`, `NEEDS-YOU.md`, and
append-only `monitor.log`; its default is `<hostRoot>/.smithers/burndown`.
The default seat remains `claude-code:sonnet`.

CLI inspections stop after 15 seconds. Missing runs, mismatched identities,
unrecognized statuses, malformed output, and command failures produce unknown
inspection evidence and an unhealthy report. Unknown inspections retry on the
next interval; only a confirmed terminal run stops the monitor. Failed and
cancelled runs remain unhealthy even if the model returns a healthy verdict.

Inspection and diagnosis errors also retain an unhealthy report and retry on the
next interval. Failure receipts omit raw command and model diagnostics.

Version 3 changes payloads, callback identities and action implementations.
Start a new monitor execution; existing persisted rounds are not migrated.
