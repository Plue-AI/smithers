---
title: "The chain contract"
description: "The governing design of @smthrs/chain: the slice, the four gates, the failure taxonomy, concurrency, resource limits, the JSON boundary, determinism, and isolation."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/chain/docs/contract.md"
---

The governing design of `@smthrs/chain`, in one page: what a chain is made
of, what each gate rejects, which failures reach your error channel, and
every default you inherit. Read it when you need the rule rather than the
recipe.

## The slice

The journal is the only state. Every other structure a host shows (the
call cache used for replay, transcripts, timelines, a UI) is a pure fold
over `Event.Event`. There is no agent-loop object.

A **link** either runs its authored script to an outcome, or, when it has no
script (bootstrap) or its script was rejected by a gate, asks the author
seat for a successor built from the goal plus the journaled observations.
Continuation is whatever the link returns: `done` ends the chain, `to`
authors the next link, `park` suspends the lineage with a typed reason.

A **call** is the one door. Every effect a script performs is
`ctx.call(name, payload)`. A call the gates ADMIT settles as a journaled
`CallSettled` event keyed by `CallKey`: the link, the digest of the script
that issued it, the ordinal within that link, and the digest of the entry's
declaration. A call a gate REJECTS journals a `GateRejected` observation at
that ordinal instead, and one that parks pending approval journals nothing at
all, so resuming re-executes it. The author seat's shape gate is the one
place both events share an ordinal: the rejection is journaled first and the
raw reply is then settled as a marker, so a crash between the two resumes
through the rejection rather than replaying the marker as a script.

Editing one character of a script re-keys exactly the calls inside it and
nothing else, which is why a script's digest is always the digest of its
text. `Outcome.to` re-derives it and discards whatever the
caller passed: scripts are model-authored, so a script chooses the text it
hands on, never the replay identity that text is keyed by.

A **resume** replays the settled prefix of the current link by ordinal, with
zero effects, and then runs live. A settled result is served only under the
same entry declaration it was produced under; a redeclared entry re-keys its
calls and the resumed chain refuses loudly with `replay_divergence` rather
than serving a stale result. Payload divergence includes bounded excerpts
around the first differing canonical JSON code unit. Harness author
payload errors also name `Options.context`, which must remain stable when
resuming a settled author call; it is not pinned separately in `ChainStarted`.

## Catalog descriptions

`Prompt.assemble` places a fixed instruction before the catalog declaring
entry descriptions untrusted repository data. Each description is a
JSON-quoted string labelled `untrusted repository description`. Embedded
instructions cannot override the user's goal or authorize actions. The
harness-owned `author` description remains trusted.

Descriptions are collapsed to one line, stripped of backticks, and bounded
to 200 characters before JSON encoding. Quotes, backslashes, and control
characters are escaped after truncation, preserving the data delimiter.
Runtime catalog and capability checks still govern every call.

## The gates

| Gate             | Where                 | What it rejects                                                                         |
| ---------------- | --------------------- | --------------------------------------------------------------------------------------- |
| 1. Shape         | `Script.extract`      | An author reply that is not exactly one fenced `flow` block.                            |
| 2. Budget        | `Chain.run`           | A link past `maxLinks`, or a call past `maxCallsPerLink`.                               |
| 3. Catalog       | `Catalog.lookup`      | A call naming an entry the catalog does not carry.                                      |
| 4. Authorization | `Authorize.authorize` | A call whose declared capabilities the host's policy denies, or parks pending approval. |

A rejected call becomes a journaled `GateRejected` observation the next
author reads, not a crash. Four exceptions are deliberate. A denied model
seat propagates typed, because routing around a denial by authoring again
would burn tokens on a chain that cannot author. A required approval parks
the run in place WITHOUT a `LinkEnded`, so resuming re-executes the link from
its settled prefix and re-asks the seam under whatever grant now exists. And
a call rejected by gate 2's per-link budget parks the chain with a `quota`
reason instead of authoring again: the observation is journaled, but the link
is out of fuel, so there is no next author to read it. A harness-built author
payload refused by the JSON boundary also journals `fuel` and parks with
`quota`: another author attempt cannot shrink caller-supplied context.

## Failures

Every failure the run's error channel carries is a tagged error with a stable
`code`. Codes are part of the contract: a host branches on them, never on
prose. `Catalog.CallError` is the one entry below that carries no `code` of
its own: it is a host's failure, described by `name` and `message`, with an
optional `cause` for the subsystem's own stable code.

| Error                        | Codes                                                         | Reaches the caller when                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Chain.ChainError`           | `replay_divergence`, `invalid_journal`                        | The journal and the current program disagree. Never recoverable by re-authoring.                                                                                                                       |
| `Journal.JournalError`       | `journal_conflict`, `journal_unavailable`                     | The journal is unreachable, or another writer advanced this chain's scope.                                                                                                                             |
| `Author.AuthorError`         | `exhausted`, `author_unavailable`                             | The model seat is out of budget or unreachable.                                                                                                                                                        |
| `Authorize.AuthorizeError`   | `denied`, `approval_required`, `authorize_unavailable`        | Gate 4's verdict. `denied` and `approval_required` are absorbed for catalog calls; `authorize_unavailable` always propagates.                                                                          |
| `Steering.SteeringError`     | `steering_unavailable`                                        | The steering channel is mounted but broken.                                                                                                                                                            |
| `ScriptRunner.ScriptFailure` | `compile`, `runtime`, `invalid_outcome`, `runner_unavailable` | Absorbed into a `script_failed` observation. It never reaches `Chain.run`'s error channel, but `QuickJsRunner.layer()` carries it: loading the WebAssembly module can fail while the layers are built. |
| `Catalog.CallError`          | host-supplied `cause`                                         | Absorbed into a `call_failed` observation, unless `cause` is `approval_required`, which returns `ApprovalWait`. An internal child-run failure wrapper re-raises the original typed error.              |

`Chain.run`'s error channel therefore carries a `ChainError`, a
`JournalError`, an `AuthorError`, a `SteeringError`, or an `AuthorizeError`,
and nothing else. A script that fails, a handler that fails, and a value
that will not serialize are all observations the model can route around. A
script's own `compile` failure is one of those observations, raised while the
link runs.

Building the layers is separate: `QuickJsRunner.layer()` carries a
`ScriptFailure`, so a host that cannot load the QuickJS WebAssembly module
(a browser CSP blocking it, say) fails with `runner_unavailable` while the
runtime is constructed, before any run starts.

## Execution

Chain provides exactly-once replay of journaled settled calls and
at-least-once handler execution. A matching settled call replays its recorded
result without running its handler. If a handler succeeds but a crash or
append failure prevents `CallSettled` from being recorded, resume can execute
the handler again. Handlers must be idempotent or, for non-repeatable effects,
use an external durable idempotency key derived from the stable call identity
(`chain`, `link`, `ordinal` in `Catalog.CallSlot`).

The journal binding must durably persist settlement before acknowledging
`Journal.append` for replay to survive process loss. Handler execution and
the settlement append are separate operations.

## Concurrency

`Journal.append` takes an `expectedPosition` so an append is a
compare-and-swap. `Chain.run` reads the journal once, at start, and then
tracks the position it last observed; it never re-reads before an append.
It cannot simply trust that position, because a sub-chain legitimately
appends to the same journal under its own id while the parent frame is
suspended inside the spawning handler. An append at a stale position
conflicts, and one fresh read decides what moved. When only foreign scopes
grew, the run retries at the position the journal now reports. When ITS OWN
scope grew, a second writer holds the scope and the run fails with
`journal_conflict`. A binding that refuses the very position its read
reports is surfaced as its own conflict, never retried. Effect execution
remains at-least-once: a losing writer may dispatch one handler before it
discovers the conflict, but each `(link, ordinal)` slot settles exactly once
and each link ends exactly once.

The cost of a run is therefore one full read plus one append per event, plus
one read per sub-chain return. Only this scope's events are held in memory;
a journal shared with hundreds of thousands of foreign-scope events costs a
run one filter at start, not one per append.

## Resource limits

Every default a caller silently inherits:

| Limit                                   | Default                               | Where                                                    |
| --------------------------------------- | ------------------------------------- | -------------------------------------------------------- |
| Links per chain                         | 32                                    | `Chain.defaultMaxLinks`                                  |
| Calls per link                          | 64                                    | `Chain.defaultMaxCallsPerLink`                           |
| Sub-chain nesting depth                 | 4                                     | `SubChains.defaultMaxDepth`                              |
| QuickJS realm memory                    | 64 MiB, floored at 256 KiB            | `QuickJsRunner.defaultLimits.memoryBytes`, `memoryFloor` |
| QuickJS in-realm stack                  | 256 KiB, capped at 256 KiB            | `QuickJsRunner.defaultLimits.stackBytes`, `stackCeiling` |
| QuickJS interrupt polls                 | 10000                                 | `QuickJsRunner.defaultLimits.steps`                      |
| JSON boundary depth                     | 128                                   | `JsonBoundary.maxJsonDepth`                              |
| JSON boundary size budget               | 8 MiB in nodes plus string code units | `JsonBoundary.maxJsonSize`                               |
| Catalog entry name in the prompt        | 64 characters                         | `Prompt.maxEntryName`                                    |
| Catalog entry description in the prompt | 200 characters                        | `Prompt.maxEntryDescription`                             |

The stack limit is not optional in production. Without it, deep in-realm
recursion exhausts the host WebAssembly stack rather than QuickJS's own:
`evalCode` throws a host error the realm can neither see nor catch, the
realm is left holding live GC objects, and disposing it aborts the module.
At 256 KiB QuickJS raises its own catchable `stack overflow` instead.

New observation messages are capped at 8192 UTF-16 code units, including a
`[truncated]` marker when shortened. The harness recovery context retains
observation lines in journal order up to 32768 code units in total, including
a truncation marker. This projection also bounds observations from older
journals without rewriting those events. Goal and `Options.context` are not
silently truncated; an oversized harness payload parks with `quota`.

Recorded rejections and settled calls replay before the live call budget is
applied. For live calls, the fuel gate runs before inspecting the payload,
so JSON refusal cannot bypass `maxCallsPerLink`.

## The JSON boundary

`JsonBoundary.jsonBoundary` is the one gate every value crosses: call
payloads, handler results, and script outcomes. Only `null`, finite numbers,
strings, booleans, and acyclic plain objects and arrays cross, and what
crosses is a structural COPY.

The walk is total and single-read. It builds the copy as it validates,
reading every property exactly once, so an accessor that answers differently
on a second read cannot smuggle an unvalidated subtree across; and it turns
every throw (a throwing accessor, a throwing proxy trap, a cycle, a depth
or size overrun) into a refusal. A host handler returning something
unserializable is never a defect: at the runner boundary it rejects the
script's own `ctx.call` promise, and inside `Chain.run` it is a `call_failed`
observation that ends the attempt and hands the next author the reason.

Copy semantics a caller must expect:

- `undefined` is refused everywhere except as the whole value, where it
  becomes `null`. Array holes read as `undefined` and are refused too,
  because `JSON.stringify` would rewrite them to `null`.
- Non-finite numbers (`NaN`, `Infinity`) are refused rather than rewritten.
- `-0` crosses as `0`. It is the one accepted value the boundary normalizes,
  because JSON cannot represent a negative zero and the QuickJS binding,
  which encodes in-realm, already hands the host `0`. Every other accepted
  value crosses unchanged.
- A `toJSON` method is never called, however it is reached: own or
  inherited. An ENUMERABLE function-valued property refuses the object
  outright, because a function is not a JSON value; a non-enumerable or
  inherited one is simply not part of the copy.
- Non-plain prototypes are refused: a `Date`, a `Map`, a class instance.
- Identity is not preserved. Two references to one object become two copies.

Both runner bindings apply this boundary to the outcome, the QuickJS one
in-realm before its own `JSON.stringify` can rewrite the value. That is what
keeps `done(NaN)` a typed `invalid_outcome` in production and not a silent
`Done(null)`.

The in-realm twin captures the `Object`, `Array`, `Number`, and `JSON`
operations it uses, plus the error and promise constructors, into its closure
before the script body runs. Reassigning a realm global therefore cannot
change what the boundary accepts.

Capture alone is not enough, because the realm's PROTOTYPES stay writable.
`JSON.stringify` reads an inherited `toJSON`, so a copy that kept its
prototype would be validated by the walk and then replaced by a hook the
script installed on `Object.prototype` or `Array.prototype`: the host
handler would receive a payload the boundary never saw, and `done([1, 2, 3])`
would journal whatever the hook returned. Every container the in-realm copy
is built from therefore carries no prototype at all, which is what makes "a
`toJSON` method is never called" true however that method is reached.

The host walk still runs over the decoded result afterwards: the realm check
prevents realm-side rewriting, while the host check treats bridge output as
untrusted and enforces the shared bounds, so the two checks are not
redundant.

## Determinism

The sealed realm deletes `Date` and `Math.random`. Time and randomness are
ordinary journaled calls: `sys/now` and `sys/random`, the two entries in
`Catalog.system`. Every catalog composition appends them through
`Catalog.withSystem`, which places them LAST, and `Catalog.make` indexes
last-wins, so nothing a host passes can shadow them with an unjournaled
clock or generator. Replay determinism rests on that ordering.

## Isolation

There are two runners and only one of them is a sandbox.

- `QuickJsRunner.layer()` is the production sealed interpreter: a fresh
  QuickJS realm per link, with the memory, stack, and step limits above, and
  no host globals. This is the only runner for model-authored scripts. A
  script that closes its async wrapper fails with `runtime` and
  `QuickJsRunner.escapedWrapper`; it cannot replace the outcome the host
  reads.
- `ScriptRunner.layerInProcess` provides NO isolation. The `Function`
  constructor builds its body in global scope, so a script reaches
  `globalThis`, `process`, and dynamic `import()`. It exists for trusted
  fixtures and for this package's own tests.
