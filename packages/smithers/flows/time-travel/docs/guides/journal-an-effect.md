---
title: "Journal an effect boundary"
description: "Record the evidence a rewind needs around an action that leaves the system: what a boundary description declares, what guard writes before and after, and how to read the records back."
sidebar:
  order: 5
---

A rewind can only reason about what the journal recorded. `EffectBoundary` is
the producer side of that contract: it wraps an action in the two durable
records that say an effect was attempted and how it settled.

This is a guide for adapter and engine authors. If you are calling
`replay`, `fork`, or `rewind`, the engine already writes these records for you.

## Describe the effect, then guard it

```ts
import type { OwnerId } from "@smthrs/journal/OwnerId"
import * as EffectBoundary from "@smthrs/time-travel/EffectBoundary"
import type * as Effect from "effect/Effect"

declare const lineageId: string
declare const postTheMessage: Effect.Effect<string>

const send = (owner: OwnerId) =>
  EffectBoundary.guard(
    {
      id: "notify-42",
      kind: "notifications/send",
      tier: "irreversible",
      runId: "ledger-1",
      lineageId,
      owner,
      sourceId: "notifications",
      sourceSeq: 7,
      idempotencyKey: "notifications/send/notify-42",
      compensation: "notifications/retract@1",
      residue: "The message was delivered and can only be retracted, not unsent."
    },
    postTheMessage
  )
```

`guard` runs `postTheMessage` between two records on the journal:

- `intended`, written durably **before** the action runs, at `sourceSeq`.
- the terminal record, at `sourceSeq + 1`: `succeeded` with the action's value,
  or `unknown`.

Interruption, defects, and typed failures all settle the boundary as `unknown`
before the original cause is re-raised, and the settlement is uninterruptible,
so cancellation cannot strand an action that has already crossed the boundary.

`guard` requires the `Journal` service and adds `TimeTravelError` to the
action's error channel. It never swallows the action's own failure.

## What the fields are for

| Field               | Why a rewind cares                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `id`                | Identity. Both records of one crossing carry it, and the fold groups by it.                      |
| `kind`              | The action name a compensation handler is registered against.                                    |
| `tier`              | `sealed`, `compensable`, or `irreversible`. See [Effect tiers](../concepts/effect-tiers.md).     |
| `idempotencyKey`    | Required for an irreversible effect, and what a handler may demand before it will revert one.    |
| `compensation`      | The stable descriptor the adapter owns, matched against the handler that claims to implement it. |
| `residue`           | Operator-facing disclosure of what remains outside the journal if the effect stands.             |
| `cacheKey`          | The content-addressed key a sealed result is read back under.                                    |
| `changeId`          | The Jujutsu pointer in force, for a compensable effect.                                          |
| `durableBoundary`   | Whether the boundary is durable. Defaults to `true`.                                             |
| `providerStream`    | Whether the effect streamed from a provider. Defaults to `false`.                                |
| `attempt`, `nonce`  | Attempt identity, so a retry's records are distinguishable from the original's.                  |
| `input`, `metadata` | Diagnostic payload carried on the record and its journal metadata.                               |

A `metadata` record merges into the entry's journal metadata field by field.
Any other value is carried under `upstream`, and an unset one adds no key.

Four declarations are refused before the action runs, all as `invalid`: a
description that does not decode, a `kind` the engine reserves
(`EventTypes.childSpawnKind`, from which a rewind derives the children it
archives), a `sourceSeq` at `Number.MAX_SAFE_INTEGER` (there is no room for a
terminal record above it), and an `irreversible` tier with no idempotency key.

## Crossing twice is refused

If the `intended` write comes back as a duplicate, the effect already crossed
its durable boundary and `guard` fails with `already_crossed` instead of
running the action a second time. That code exists separately from `busy`
precisely so a caller can tell a re-armed effect from a contended run.

## Read the records back

Boundary records carry the event type `EffectBoundary.eventType`, which is
`flows.time-travel.effect-boundary`. Four functions decode them:

```ts
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as EffectBoundary from "@smthrs/time-travel/EffectBoundary"

declare const entries: ReadonlyArray<JournalEvent.Entry>

const effects = EffectBoundary.fromEntries(entries)
```

- `decodeEntry(entry)` decodes one known boundary event and **fails closed**
  with `invalid` when its durable payload is corrupt. An entry of another event
  type answers `undefined`, so the projection stays total over a shared journal.
- `fromRecords(records)` folds decoded records to one per effect.
- `fromEntries(entries)` does both, and is what a rewind uses.

The fold enforces the shape of a legal crossing: an `intended` record followed
by at most one terminal record, with exact duplicates tolerated because a
reader can page the same record twice. Two terminals, a terminal followed by an
`intended`, two records at one sequence that disagree, or two records whose
identity fields differ all fail `invalid`. Keeping the last record listed
instead would let a reordered journal turn an `unknown` outcome, which must
block a rewind, into a `succeeded` one a handler would compensate.

## Where to go next

- [Effect tiers](../concepts/effect-tiers.md): the verdict each tier's evidence
  produces.
- [Compensate an irreversible effect](./compensate-an-effect.md): the handler
  that matches the `kind` and `compensation` you declared here.
