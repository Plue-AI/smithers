---
title: "Compensate an irreversible effect"
description: "Contribute the handler that lets a rewind undo an effect that left the system: what revert and rollback must do, how a handler is matched to recorded evidence, and why the default refuses."
sidebar:
  order: 6
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/time-travel/docs/guides/compensate-an-effect.md"
---

With no handlers provided, every crossed irreversible effect assesses as
blocking and a rewind across it fails `irreversible`. That is the safe default,
and it is also the default you have to replace before a rewind can cross a
charge, a message, or a deployment.

## Contribute a handler

`CompensationHandlers` is an optional service the composition provides. The
adapter that performed the effect owns its compensation, and the composition
that wires that adapter is the only place that can close over the services a
`revert` needs:

```ts
import { CompensationHandlers } from "@smthrs/time-travel"
import * as Effect from "effect/Effect"

const refunds = CompensationHandlers.layer([{
  kind: "billing/charge",
  tier: "irreversible",
  compensation: "billing/refund@1",
  requiresIdempotencyKey: true,
  residue: (effect) => `Charge ${effect.id} was refunded, not un-charged.`,
  revert: (effect) => Effect.succeed({ refunded: effect.id }),
  rollback: () => Effect.void
}])
```

Provide it under `TimeTravel.layer`. A composition with no irreversible
adapters provides `CompensationHandlers.layerNoop` or nothing at all.

Handlers are **closed values**: everything `assess`, `revert`, and `rollback`
need must be captured when the handler is built, because a rewind resolves them
outside the composition that produced the effect. The registry behind them
stays internal; you write a `Handler` and provide a layer, and never see the
lookup.

## The three functions

**`residue(effect)`** is operator-facing disclosure: what remains outside the
journal once this effect is compensated or allowed to stand. It is the sentence
an operator reads on a warning.

**`revert(effect)`** performs the compensation and returns whatever the handler
needs to undo **its own** compensation. That value becomes the durable rollback
receipt, persisted against the audit row before the journal range the effect
belongs to is truncated. The ordering is what lets recovery tell an effect that
was already rolled back from one that never was, so a resumed rewind never
compensates the same effect twice.

The receipt is stored exactly as `revert` returned it, without the redaction
pass `@smthrs/journal` applies to journal payloads: recovery decodes it and
hands it back to `rollback` byte for byte, and a placeholder there would roll
back the wrong thing. A receipt must never carry a credential. Keep tokens and
connection strings in the handler's closure and return only the identifier
`rollback` needs, such as a refund id or a retraction handle. Compensation
enforces this: a receipt the journal's redaction rules would rewrite, such as
one with an `apiToken` field or a `Bearer` value, fails the rewind with
`compensation_failed` before it is persisted, and every receipt collected so
far is rolled back.

**`rollback(effect, receipt)`** undoes a compensation this handler performed,
from the receipt `revert` returned. A rewind that fails after compensating
replays these in reverse order. It is required even when the answer is "nothing
to undo", because a silent default would make a handler that forgot to write
one indistinguishable from one that deliberately has nothing to do.

`revert` and `rollback` must be bounded and honor interruption. Bound network
requests and cleanup in the adapter; do not mask an indefinite wait. Time travel
applies `TimeTravel.Options.compensationTimeout` to each handler call and jj
snapshot or restore, including rollback. The default is three minutes. A timeout
fails with `compensation_failed` and retains the timeout in its cause. Startup
recovery runs in a child fiber and is awaited with
`TimeTravel.Options.recoveryTimeout`, which bounds every pending audit together
and defaults to ten compensation deadlines.

Before restoring a workspace, rewind snapshots its current state and durably
records both current and target pointers. Startup recovery restores the recorded
current pointer whether the process died before or after the target restore.

## How a handler is matched to evidence

A handler is held to what the journal recorded, and each of these mismatches
assesses as `blocking` rather than reverting the wrong thing:

- **Descriptor.** An effect that recorded a `compensation` descriptor resolves
  only to the handler declaring the same one, so an adapter swapped in after a
  restart never compensates evidence another implementation left behind. An
  effect that recorded none resolves by `kind` alone.
- **Tier.** A handler registered for a different tier than the effect records.
- **Completion.** An effect whose terminal status is not `succeeded`. An
  `unknown` outcome means nobody knows whether it reached the world.
- **Idempotency key.** A handler with `requiresIdempotencyKey: true` never
  reverts an effect that recorded no key.

A rollback is checked the same way: it refuses a receipt whose tier or
descriptor the handler does not match.

## Refine the verdict

Add `assess` when the default `revertible` is too generous, for example when
the effect is only compensable inside a time window:

```ts
import type * as CompensationHandlers from "@smthrs/time-travel/CompensationHandlers"

const assess: NonNullable<CompensationHandlers.Handler["assess"]> = (effect) =>
  Effect.succeed({
    classification: "warning",
    reason: "The refund window has closed.",
    residue: `Charge ${effect.id} stands.`
  })
```

The result is decoded against the `Assessment` schema before a rewind acts on
it, and a result that does not decode assesses as `blocking`. A handler bug can
refuse a rewind; it can never let one through.

## What a rewind does with them

The assessment runs before anything is compensated or truncated. One blocking
verdict refuses the whole rewind with `irreversible`, carrying the blocking
assessments as its cause: identity and verdict only, never the effect's `input`
or `output`, because the error encodes its cause onto the wire and into logs.
The full records stay on the audit detail.

Handlers then run in reverse journal order. A handler failure rolls back every
earlier receipt before the typed failure escapes as `compensation_failed`.

## Where to go next

- [Effect tiers](/concepts/effect-tiers/): the full verdict table, and how
  sealed and compensable effects are assessed.
- [Journal an effect boundary](/guides/journal-an-effect/): declaring the `kind`
  and `compensation` this handler matches.
- [Rewind a run to a frame](/guides/rewind-a-run/): where the assessment sits in
  the call.
