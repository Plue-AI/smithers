---
title: "Output and exit codes"
description: "What the CLI writes to stdout and stderr, the rules that make a rendering deterministic and safe, and the six process statuses a script can branch on."
sidebar:
  order: 4
---

The CLI writes one document to stdout and everything else to stderr, so a
`--json` reader never finds a diagnostic inside its document. The status the
process exits on comes from the document, not from the renderer.

## The two renderings

`Output.Format` has two values, and every handler produces both from one value:

- `human` indents two spaces per level. It is the default.
- `json` is the same document with no whitespace, selected by `--json`.

Object members are ordered by UTF-16 code unit in both, so a rendering is
byte-stable across runs and machines.

## What a rendering accepts

`Output` snapshots the value before writing it, and the snapshot admits inert
plain data only. It refuses, with a stable code and the path of the first
refusing member:

| Code | Refused because |
| --- | --- |
| `proxy`, `callable`, `accessor`, `to_json` | The value is executable. Rendering it would run caller-controlled code. |
| `cycle` | The value already appears at an earlier path. |
| `depth_limit` | The document nests deeper than 128 levels. |
| `member_limit` | The document holds more than 10,000 data members. |
| `byte_limit` | The rendered document exceeds 4 MiB of UTF-8. |
| `unsupported` | A class instance, a symbol-named member, a sparse array, or a non-enumerable member. |
| `unreadable` | The value could not be inspected without executing it. |

Special values are normalized rather than dropped: `undefined` renders as
`[Undefined]`, `NaN` and the infinities render as `[NaN]`, `[Infinity]`, and
`[-Infinity]`, negative zero renders as `-0`, a bigint renders with its `n`
suffix, and a `Redacted` value renders as `<redacted>`.

Exceeding a bound fails with a typed `RenderingError` before any output is
written, so a caller never reads a truncated document.

## Where the exit status comes from

`Output.exitCode` decides the status from the value itself, and only a value
that validates as a complete control receipt can set a nonzero one. An object
that merely has receipt-shaped member names returns 0.

Values that are not receipts, such as stored memory or a provider's own
document, are wrapped in `Output.renderValue` first. A wrapped value always
exits 0, so a caller-controlled `_tag` cannot imitate a receipt and change the
status of the command that printed it.

## The status vocabulary

| Code | Meaning |
| --- | --- |
| `0` | The command did what it was asked. |
| `1` | The command failed, or the run it reports settled `failed`. |
| `2` | The invocation was wrong. Retype it; the message names the flag or argument. |
| `3` | The run is parked at `waiting-approval`. Decide it with `smthrs approvals approve` or `smthrs approvals deny`. |
| `130` | The run was cancelled, or the process received `SIGINT`. |
| `143` | The process received `SIGTERM`. |

Codes 3, 130, and 143 report a run outcome rather than a failure of the
command, and are decided from the control receipt alone. The receipt kinds map
this way: `Parked` is 3, `Terminal` with status `cancelled` is 130, `Terminal`
with status `failed` is 1, `Conflict` is 1, and everything else is 0.

`CliError.exitCode` decides the other two: a `UsageError` exits 2, and an
`UnsupportedError`, a `ResourceLimitError`, or a `RenderingError` exits 1. The
split is the contract a script branches on: 2 means the operator can fix the
command line, 1 means they cannot.

## What a failure looks like

A failure is one line on stderr and nothing on stdout. The line names the
failure's class rather than its namespace, so it reads `ClaimLost`, not
`/control/ClaimLost`, followed by its sentence. A control failure that carries
no sentence is reported by the fields it does carry, contract code first:

```text
ClaimLost: claim_lost runId=run-42
```

Nothing else reaches stdout. The runtime's own cause reporting is turned off,
so a timestamped stack never lands on top of the document a script is reading.
Every built-in logger is redirected to stderr, and every log line passes
through the same redaction rules `@smthrs/journal` applies on its write path,
so a credential handed to `Effect.logInfo` reaches neither the terminal nor
`.flows/logs/<run-id>.log`.

## Resource bounds on reads

A finite history read retains at most 50,000 events and 16 MiB, with a 1 MiB
cap on any single event. `runs logs --follow` applies the per-event cap without
retaining prior events. Crossing a bound returns a typed `ResourceLimitError`
naming the operation and the subject, rather than partial output.

The MCP server narrows the same bounds: 10,000 events and 1 MiB for one history
result, and 4 MiB for any request or response frame.

## The terminal rendering

`Output` is the document path. `Ui` is the other one: the interactive rendering
`smthrs doctor` and `smthrs suggest` print through, with clack symbols and
spinners on a terminal and a plain-line fallback everywhere else.
`Ui.isInteractive` is the decision, and it requires both streams to be
terminals, `CI` to be anything but `"true"`, and `TERM` to be anything but
`dumb`. Under `--json` a verb prints its document through `Output` and does not
call the terminal renderer at all. See
[Embed the command tree](../guides/embed-the-command-tree.md) for driving the
terminal renderer from your own program.
