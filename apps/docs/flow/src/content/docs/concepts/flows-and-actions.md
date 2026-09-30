---
title: "Flows and actions"
description: "The two nouns of the authoring model: an action carries an implementation attached as a layer, a flow carries a pure body, and the requirement channel is what connects them."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/flow/docs/concepts/flows-and-actions.md"
---

The package has two nouns and one rule about each.

- An **action** is the atom that does the work. It carries an implementation,
  and that implementation attaches separately, as a layer.
- A **flow** is the composite. It carries a `body`, and never opaque executable
  code.

A typed `prompt` declaration lowers to a flow whose body calls one ordinary
action. The host attaches the model implementation to `flow.action`; the
renderer is `flow.prompt`. See [Prompt-backed flows](/guides/use-a-prompt/).

Everything else follows from that split, including the surprising part: there is
no `toLayer` on a flow. A flow has exactly one behavior and it is the body, so
there is no second behavior to attach.

## Two forms of action

`Action.make` selects its form by whether the first argument is a string.

The **declared** form is the one you write in a body. It is pure data: a tag,
schemas, a tier, and optional identity. It holds no code.

```ts
import { Action } from "@smthrs/flow"
import * as Schema from "effect/Schema"

export const Charge = Action.make("payments/Charge", {
  payload: { customer: Schema.String, cents: Schema.Number },
  success: Schema.String,
  tier: "irreversible",
  idempotencyKey: { charge: "checkout-v1" }
})
```

The **inline** form carries its `execute` effect directly and is itself an
`Effect`. It is what an implementation reaches for when it needs a nested durable
operation of its own, and it is what `Action.retry` and `Action.raceAll` take.

```ts
import * as Effect from "effect/Effect"

const probe = Action.make({
  name: "payments/Probe",
  success: Schema.String,
  execute: Effect.succeed("ok")
})
```

## The requirement channel

`Action.make(tag, ...)` mints one context key for that declaration, derived from
the tag. `Charge.call(payload)` records a node whose type carries that key.
`Flow.make` reads the union of those keys off the node its body returns, so a
flow states in its own type which implementations it names and does not hold:

```ts
Checkout.execute({ customer: "ada", cents: 4_200 }, { executionId: "checkout-1" })
// Effect<string, ..., FlowRuntime | Crypto.Crypto | Action.Requirement<"payments/Charge">>
```

`Charge.toLayer(...)` provides that key. A composition missing an implementation
therefore fails to compile at the call site instead of dying partway through a
run. Planning stays requirement-free: building the plan a body describes asks for
no service at all, and `execute` is the one place the obligations are collected.

Three propagation rules follow from where a plan actually goes:

| Where                                        | What happens to the requirement                                                                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flow.call(payload)`                         | Propagates. The callee's steps join the caller's plan, so its obligations are the caller's.                                                          |
| `flow.child(payload)` and `flow.to(payload)` | Dropped. Each opens a new execution whose own driver supplies its context. Dropping at `to` is also what keeps a self-looping lineage's type finite. |
| `poll`, `interrupt`, `resume`                | Not collected. The first two never drive a body, and a re-driven round runs under the context the flow was registered with, not the resumer's.       |

## System actions mint nothing

`Action.makeSystem` is the declared form with the requirement erased. `Sleep`,
`WaitFor`, `HumanTask`, and `Poll`'s exhaustion step all use it, so a body that
waits pushes no layer obligation onto its callers. The engine owns those
implementations, and an author cannot be the party who forgot them. You still
provide `Sleep.layer` or `WaitFor.layer` in the composition; the compiler does
not force you to.

## The name-keyed table

The requirement is the compile-time half. `Action.Implementations` is the
run-time half: a table keyed by action tag that `toLayer` files itself into. A
driver expanding a plan it read back out of a journal has no types left to
consult, so it resolves by tag.

That is why `Action.layerImplementations` goes **under** the implementation
layers rather than beside them:

```ts
import { Interpreter } from "@smthrs/flow"
import * as Layer from "effect/Layer"

Layer.mergeAll(Charge.toLayer(chargeCard), Interpreter.layer(Checkout)).pipe(
  Layer.provideMerge(Action.layerImplementations)
)
```

Filing an implementation happens while its layer is built, so the table has to
exist first. The table is optional: a composition that only executes handlers
registered directly with the runtime never needs it.

## Tiers

Every action declares a `tier`, which tells the engine what a retry of it means.

| Tier           | Meaning                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sealed`       | The default. The result is a pure function of the inputs, so a recorded result can be replayed and, with the right declarations, reused across runs.                    |
| `compensable`  | The body changes the workspace. The engine takes a pre-image before an attempt and restores it before the next one, so the undo is the engine's rather than the body's. |
| `irreversible` | The body changes the world outside the workspace. Retrying one without a declared `idempotencyKey` fails with `IrreversibleRetryRequiresIdempotencyKey`.                |

## Related pages

- [Bodies are plans](/concepts/bodies-and-plans/): what a body may and may not do.
- [Attach an implementation to an action](/guides/implement-an-action/): the
  layer, the tier, and the ordering rules, in one place.
- [The runtime port](/concepts/the-runtime-port/): what an engine has to supply for any
  of this to run.
