---
title: "Redaction"
description: "Why the journal scrubs payloads on the write path, what the default rules catch, where redaction deliberately stops, and the bounds that keep the scrub safe on hostile input."
sidebar:
  order: 4
---

A journal row is permanent and broadly readable. Every entry is replayed
verbatim to sync followers, to time-travel consumers, and into a support
bundle. A credential that reaches `payload_json` is therefore not a transient
leak, and no reader can undo it.

So the journal redacts once, on the write path. Every write funnels through one
preparation step, and that step scrubs `payload` and `meta` before they are
encoded. No channel can persist a credential.

## What the default rules catch

Redaction has two halves.

**Structural.** A field whose name reads as a credential has its value replaced
wholesale, whatever the value is: `authorization`, `cookie`, `apiKey`, `token`,
`password`, `passphrase`, `secret`, `secretAccessKey`, `credential`, `dsn`,
`connectionString`, `privateKey`, `sshKey`, `session`, `signature`, `auth`, and
the rest of that family, plus a trailing `key` that is a word of its own (`key`,
`api_key`, `x-api-key`). `Redaction.isSensitiveKey` is the predicate, and
`Redaction.placeholder` is the string that lands, `"[REDACTED]"`.

The match is a suffix test on the separator-free lowercase form of the name,
not a substring test, so `tokenizer`, `secretary`, `monkey`, and
`idempotencyKey` stay intact. Redacting them would destroy data in a permanent
row without protecting anything, and `idempotencyKey` in particular is the
durable identity an effect boundary replays on. Token counters are kept too: a
non-negative safe integer under `inputTokens`, `outputTokens`,
`cachedInputTokens`, `reasoningTokens`, or `totalTokens` is accounting, not
bearer material.

**Textual.** `Redaction.defaultRules` scans inside any string for credential
shapes seen in real bug reports: provider keys, bearer tokens, GitHub, AWS,
Slack, and Google credentials, URL passwords, Basic authorization, bare JWTs,
PEM private-key blocks, INI/YAML credential assignments such as
`SECRET = value` and `password: value`, cookie and session assignments, and
embedded JSON credential members.

The rule set is a best-effort net, not a proof. A value that must never persist
belongs in a `Redacted` field of the caller's own schema, where the type
system, rather than a name-suffix guess made at the storage seam, keeps it out.

Objects and arrays are rebuilt, a cycle collapses to `"[Circular]"` so the
result always encodes, and a number, a boolean, `null`, or `undefined` is
returned untouched. Every replacement reaches a fixed point, so replaying or
exporting an entry cannot mutate it again.

## Where redaction stops

Redaction is an observability concern, and it is confined to journal events and
to display surfaces.

It deliberately does not apply to executable state: `flows_runs.state_json`,
attempt checkpoints, errors, outcomes, cache results, and a journal
`Checkpoint`'s own `state`. Those values are decoded and re-entered on resume.
A placeholder there resumes the flow with the wrong data, and replacing a
non-string value with a placeholder string makes the persisted state fail
schema decode outright, which leaves the run undrivable.

That is why [`@smthrs/run-store`](/api/run-store) and
[`@smthrs/step-cache`](/api/step-cache) take no `redact` option at all.

## Choosing a redactor

`SqlJournalOptions.redact` defaults to `Redaction.make()`. Two other choices
are supported:

```ts
import { Redaction, SqlJournal } from "@smthrs/journal"

const verbatim = SqlJournal.layer({
  capacity: 1024,
  overflow: "reject",
  redact: Redaction.makeNoop()
})

const extended = SqlJournal.layer({
  capacity: 1024,
  overflow: "reject",
  redact: Redaction.make({
    rules: [...Redaction.defaultRules, { id: "internal-ticket", pattern: /\bTKT-\d{6}\b/g }]
  })
})
```

`Redaction.makeNoop()` persists payloads verbatim by choice, for a trusted
single-tenant store or a suite asserting on raw input. A custom rule set
replaces the defaults, so spread `Redaction.defaultRules` when you mean to add
to them rather than to swap them out. A non-global custom pattern is normalized
to global once, and a sticky one keeps its stickiness.

## Bounds on the scrub

Redaction runs on every write, so it is bounded against hostile input rather
than trusted to terminate:

- **Depth.** The walk traverses at most `Redaction.maxDepth` (256) container
  edges and fails a deeper payload as `invalid_event` rather than overflowing
  the stack. The canonical encoder carries the same ceiling, so a value that
  reaches it through `Redaction.makeNoop()` is refused the same way.
- **Binary views.** Enumerating a typed array's own properties materializes one
  pair per byte, so a view over `Redaction.binaryWalkLimit` (65,536) bytes, or
  one carrying that many own members, is named rather than walked. The size is
  read from the value's own internal slot, where nothing a caller writes can
  answer for it.
- **Rule cost.** The default rules are unanchored character-class scans with no
  nested quantifier and no alternation inside a repetition, so each is linear
  in the length of the value and no input backtracks catastrophically.

A redaction that throws, from the redactor itself or from a getter or proxy
trap on the value, fails the write as `invalid_event` with no `cause`. The
thrown value can quote the unredacted input, so the error carries only which
field, `payload` or `meta`, could not be redacted.

Values a JSON row cannot hold are named rather than dropped:
`Redaction.binaryMarker`, `Redaction.functionMarker`,
`Redaction.symbolMarker`, and `Redaction.depthMarker`.

## Rendering a stored column

`Redaction.redactJsonString` scrubs an already-encoded JSON string at a display
surface, leaving the durable row untouched. Use it for a rendered `state_json`
or a support bundle, where the value is already encoded and must not be decoded
back into the executable path.

```ts
import { Redaction } from "@smthrs/journal"

const redactor = Redaction.make()
const forDisplay = (stateJson: string): string => Redaction.redactJsonString(stateJson, redactor)
```

A string that does not parse is returned untouched: validation belongs to the
caller, and rejecting here would turn a redaction concern into a schema error.
Once parsing succeeds the function fails closed, returning the JSON string
`"[REDACTED]"` rather than the original text, if the redactor throws or the
result cannot be re-encoded.

## The other half: log output

The journal closes the durable half. The operator's terminal is the other place
the same credential surfaces, and `RedactedLogger` closes it with the same
rules. See
[Keep credentials out of log output](../guides/redact-log-output.md).
