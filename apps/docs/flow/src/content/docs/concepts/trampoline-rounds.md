---
title: "Trampoline rounds"
description: "How a flow loops: one round settles with Done, To, or Park, the engine follows a handoff to the next round, and maxRounds bounds the lineage."
sidebar:
  order: 5
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/flow/docs/concepts/trampoline-rounds.md"
---

A body builds one round. Loops that depend on a runtime value are not written
inside a round; they are written as a **lineage** of rounds, where each round
ends by naming the next one. That is a trampoline, and it is why the plan can
stay static while the loop count cannot.

## The three settlements

A body may settle a round with an ordinary success value, or with one of three
outcomes:

| Outcome | Constructor                    | What it means                                           |
| ------- | ------------------------------ | ------------------------------------------------------- |
| `Done`  | `Flow.done(value)`             | End the lineage with this value.                        |
| `To`    | `someFlow.to(payload)`         | End this round and open the next one with this payload. |
| `Park`  | `Flow.park({ reason, token })` | Park this round durably under a waiting reason.         |

A round that hands off settles as `Flow.Handoff`, beside `Complete` and
`Suspended`. Following the handoff is the engine's job: this package produces the
settlement, and [`@smthrs/engine`](https://engine.smithers.sh/reference/api/) opens the next round.

A handoff completes the round successfully and discards its `withRollback` registrations.
It closes the current round's scope with a success exit, running its exit
finalizers. The next round has a fresh scope, so its failure cannot roll back
effects from earlier rounds. The engine does not provide lineage-scoped
compensation; compensation across rounds requires an explicit durable design.
Suspension keeps the current round's scope open instead. See
[Scope and cleanup](/concepts/suspension-and-replay/#scope-and-cleanup).

Values are passed in their author-facing form. The engine encodes a `Done` value
with the settling flow's success schema and a `To` payload with the target flow's
payload schema, at the settlement boundary. Callers do not pre-encode.

## A loop that counts

```ts
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Schema from "effect/Schema"

const Increment = Action.make("trampoline/increment", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

type CounterFlow = Flow.Flow<
  "trampoline/counter",
  Schema.Struct<{ value: typeof Schema.Number; target: typeof Schema.Number }>,
  typeof Schema.Number,
  typeof Schema.Never,
  Action.Requirement<"trampoline/increment">
>

const Counter: CounterFlow = Flow.make("trampoline/counter", {
  payload: { value: Schema.Number, target: Schema.Number },
  success: Schema.Number,
  body: ({ target, value }: { readonly value: number; readonly target: number }) =>
    Increment.call({ value }).pipe(
      Node.branch({
        if: (next) => next >= target,
        then: (next) => Flow.done(next),
        else: (next) => Counter.to({ value: next, target })
      })
    )
})
```

Two things about that declaration are load bearing.

The body names the flow it is the body of. That is legal because a body is read
when a round is planned, long after `Flow.make` returned, so the binding is
initialized by then. The explicit `CounterFlow` type annotation is what breaks
the circularity for the compiler.

`.to()` **drops** the requirement channel. A self-handoff that propagated its
requirements would have to name its own requirements inside them, and the type
would not be finite. Dropping it is sound because a handoff ends this execution
and the next round runs under its own driver's context.

## Cancelling a logical run

Keep the execution ID returned at admission. `flow.interrupt(id)` requests
cancellation across the logical run, even after that round has handed off;
using a later round ID reaches the same lineage. A completed predecessor is
historical evidence, not proof the whole job is complete. Its recorded handoff
is not rewritten as a cancellation.

Cancellation reaches linked children, including children created by earlier
rounds and their handoff successors. A fork's ancestry does not, by itself,
create a cancellation link. The durable engine serializes intent with handoff
admission; the memory engine retains intent before admitting a later round.
Returning from `interrupt` means the request was recorded, not that user cleanup
or an owner in another process has finished. It is permanent; `resume` does not
undo it. Low-level `poll(id)` still reads the named round's result, not a
consolidated logical-run observation.

## The round budget

`Flow.make`'s `maxRounds` bounds one lineage. It is a budget, not loop detection:
identical consecutive rounds are legal, so a runaway lineage is stopped by
counting rounds rather than by comparing them. Absent means unbounded, which is
the right default for a lineage whose exit condition is its own branch.

`maxRounds` must be a positive safe integer; `Flow.make` throws a `RangeError`
otherwise. Exceeding it terminates the lineage with a `Flow.MaxRoundsExceeded`
defect recorded in the execution result. It is not a typed `execute` failure,
because a lineage that ran away is a declaration bug rather than an outcome a
caller was told to expect.

## The lineage deadline

A lineage is one run, so `Flow.make`'s `deadline` bounds the whole lineage, not
each round. The originating round journals its first start; each round that
hands off stamps that start and the bound on its `Flow.Handoff`, and the next
round runs under the stamp whatever it declares. Every round therefore expires
at the originator's start plus the originator's deadline, and settles with
`Flow.DeadlineExceeded` when it passes.

## Recognizing an outcome

`Flow.isOutcome` does not work by shape. Ordinary success data may carry the same
`_tag` fields, and treating it as control would let a payload steer a run. Graph
construction carries a non-enumerable marker from the authoring node to its
hydrated value, and the guard reads that marker, so
`{ _tag: "Done", value: 1 }` written by hand is not an outcome.

## What trampolines are for

- **Fan out over discovered data.** `Node.all` fixes its width at plan time. When
  the width comes from a step result, end the round and carry the list in the
  next round's payload, where it is real data.
- **Loop until a runtime condition holds.** `Poll.make` is exactly this,
  packaged: its body is one attempt that either settles the lineage or sleeps and
  hands off with the attempt counter raised. See
  [Poll until something is ready](/guides/poll-until-ready/).
- **Park a round for something outside the run** without pretending the wait is a
  step, with `Flow.park`.

## Related pages

- [Bodies are plans](/concepts/bodies-and-plans/): why width is fixed inside a round.
- [Suspension and replay](/concepts/suspension-and-replay/): the other two results and
  what a re-drive does.
- [Run a flow as a child execution](/guides/run-a-child-flow/): the other
  boundary that drops requirements, and how it differs from a handoff.
