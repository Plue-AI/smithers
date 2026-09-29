---
title: "Keep credentials out of log output"
description: "Install RedactedLogger so the journal's redaction rules also cover the terminal, the JSON log document, and the spans a tracer logger exports."
sidebar:
  order: 6
---

The journal redacts on the write path, so a credential an action logs or
returns never reaches a committed row. The operator's terminal is the other
place the same credential surfaces: every built-in Effect logger renders through
the fiber's `Console`, so an action that hands a token to `Effect.logInfo`
writes it to stderr in full, and it reaches whatever collects that stream.

`RedactedLogger` closes that half with the same rules rather than a second rule
set. A log line is a diagnostic, so it takes `Redaction.diagnosticRules`: the
default rules plus the spellings too broad for a durable row.

## Install the layer

```ts
import { RedactedLogger } from "@smthrs/journal"
import * as Layer from "effect/Layer"

const logging = RedactedLogger.layer()
```

The layer composes over whatever loggers are already installed rather than
choosing one, so an operator keeps the format they had: their own logger, their
own layout. A host that installed its own logger keeps it too.

Pass `Redaction.Options` to extend or replace the rules, exactly as you would
for the journal write path. Spread `Redaction.diagnosticRules` to add to them.

## What it covers

Two halves carry load, and both are necessary:

- **The log event itself.** The message, the cause, and the log annotations are
  redacted before the wrapped logger is handed them. This matters because a
  logger is free to read the event instead of rendering it, and one in Effect's
  default set does: `Logger.tracerLogger` publishes the message as a span event
  name and the pretty cause as the span's `effect.cause` attribute, and never
  touches `Console`. Redacting only the console would hide a credential on
  stderr and export it in clear to whatever OTLP collector is configured.
  Cause stack annotations are redacted too: span names, lazy stack text, parent
  frames, and interruptor frames. The original cause is unchanged; the delegate
  receives rebuilt reasons with redacted frame chains.
- **The fiber's console.** The wrapped logger is handed a view of the fiber
  whose `Console` is a redacting console, so whatever the logger renders for
  itself, a pretty line or a JSON document, passes through the rules on its way
  to the stream.

Cost is bounded by the rules: each rule is linear in the length of the line,
with no catastrophic backtracking.

## Two differences from the write path

**A too-deep value is named, not refused.** The journal throws on a payload
past `Redaction.maxDepth` so the write fails with a typed `invalid_event`. A
logger cannot: a throw there is caught one frame up and replaces every argument
on the line with a placeholder, so one deep member would cost the operator the
whole line. `wrap` therefore defaults `onTooDeep` to `"name"`. A caller passing
its own `onTooDeep` still wins.

**An `Error` is rebuilt as a plain `Error`.** Its `message` and `stack` live on
non-enumerable properties, so the own-key rebuild the write path uses would
print `{}` where the operator expected a failure. The copy keeps the name,
message, stack, and own members with the rules applied, but not the class. A
copy built on the original's prototype would inherit everything the prototype
defines, and `name`, `cause`, `toJSON`, `Symbol.toStringTag`, and
`nodejs.util.inspect.custom` each carried a credential out that way.

## Wrap a single logger

Use `wrap` when you are constructing a logger rather than composing a layer:

```ts
import { RedactedLogger } from "@smthrs/journal"
import * as Logger from "effect/Logger"

const json = RedactedLogger.wrap(Logger.formatJson)
```

`wrap` is idempotent. Both the CLI and the durable runtime install the layer,
and a detached run is both at once, so a logger this module already wrapped is
returned unchanged rather than paying the rules twice per line.
`RedactedLogger.isRedacted` reports whether a logger is already wrapped.

## Next steps

- [Redaction](../concepts/redaction.md) for the rules, the bounds, and where
  redaction deliberately stops.
- [Observability](/docs/guides/observability/) for exporting the spans this
  logger writes into.
