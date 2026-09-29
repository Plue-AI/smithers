---
title: "Testing"
description: "Assert a body's topology without an engine, run a flow on the in-memory engine, prove a step replayed, drive a suspension with a test clock, and pin step identity."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/flow/docs/testing.md"
---

Flows are testable at three levels, and picking the right one keeps a test fast
and its failure legible.

| Level          | Reach for it when                                                               | What you need                                                  |
| -------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Topology       | The assertion is about the plan: node ids, edges, which arm exists.             | `Graph.build`. No engine, no crypto.                           |
| Interpretation | The assertion is about one drive: what settled, failed, or was skipped.         | `Interpreter.interpret`, action layers, a runtime.             |
| Execution      | The assertion is about the durable lifecycle: replay, suspension, cancellation. | `FlowEngine.layerMemory` from [`@smthrs/engine`](https://engine.smithers.sh/reference/api/). |

## Assert a body's topology

Building a plan is pure, so a topology test needs nothing but the declarations:

```ts
import { expect, it } from "@effect/vitest"
import { Graph } from "@smthrs/flow"

it("plans both checks before the report", () => {
  const graph = Graph.build(Gate, { target: "web" })
  const ids = Graph.nodes(graph).map((node) => node.id)

  expect(Graph.diagnostics(graph)).toEqual([])
  expect(ids).toContain("root.lint")
})
```

This is the level to test a refusal at, too: a body that computes on a planned
value throws a `GraphBuildError` from `Graph.build`, with no run in sight.

## Run a flow in memory

`FlowEngine.layerMemory` implements the whole `FlowRuntime` port in the process.
The composition is the production one with the engine swapped:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const layer = Layer.mergeAll(
  Greet.toLayer(({ name }) => Effect.succeed(`Hello, ${name}.`)),
  Interpreter.layer(Greeting)
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer)
)
```

Use the real `NodeCrypto.layer` rather than a stub. Step identity is a digest,
and a fake digest tests a key derivation nobody ships.

## Prove a step did not run twice

Counting dispatches is the cheapest way to assert replay, and the counter lives
in the implementation rather than in the flow:

```ts
let calls = 0

const counted = Greet.toLayer(({ name }) =>
  Effect.sync(() => {
    calls += 1
    return `Hello, ${name}.`
  })
)

const countedLayer = Layer.mergeAll(counted, Interpreter.layer(Greeting)).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer)
)

it.effect("dispatches the action once across two drives", () =>
  Effect.gen(function*() {
    const run = Effect.orDie(Greeting.execute({ name: "Ada" }, { executionId: "greet-1" }))
    yield* run
    yield* run

    expect(calls).toBe(1)
  }).pipe(Effect.provide(countedLayer)))
```

A second, different implementation of one action tag dies with
`Action.DuplicateImplementation` unless it registers with
`toLayer(handler, { override: true })`. Closing the overriding scope restores
what it shadowed. `countedLayer` needs no flag because it builds its own
composition rather than overriding one.

## Drive a suspension

To test a parked run without waiting for its result, use
`execute(payload, { discard: true })`, `start(payload)`, or
`ensure(payload, { key })` to acknowledge admission. Test the wake by completing
the wait point and resuming:

```ts
import { DurableDeferred, WaitFor } from "@smthrs/flow"

const gate = WaitFor.deferred("ship")

it.effect("resumes when the wait point is completed", () =>
  Effect.gen(function*() {
    yield* Ship.execute({ build: "42" }, { executionId: "ship-1", discard: true })

    const token = DurableDeferred.tokenFromExecutionId(gate, { flow: Ship, executionId: "ship-1" })
    yield* DurableDeferred.succeed(gate, { token, value: { approved: true } })
    yield* Ship.resume("ship-1")

    expect(yield* Ship.poll("ship-1")).toMatchObject({ value: { _tag: "Complete" } })
  }))
```

`discard: true` answers with the execution id instead of waiting for the result,
which is what you want for a run you intend to park. Ordinary `execute` follows
the run: with the default polling policy (no attempt or expiry bound), its caller
can stay pending while the run is suspended. A bounded `suspendedRetryPolicy`
can end that caller with a `SuspendedResumeGaveUp` defect without cancelling the
parked run.

For a timer, drive the clock rather than the wall. Effect's `TestClock` advances
a `Sleep.action` or a `DurableClock.sleep` deterministically, and a test that
sleeps for real is a test that is slow and flaky in the same commit.

## Pin the identity

Step identity is a wire format: it outlives a process and decides whether a
result is found or recomputed. Pin the derivations you depend on with literal
vectors, so a change to how a step is keyed is a red test rather than a silent
cache miss:

```ts
import { StepIdentity } from "@smthrs/flow"

it.effect("keys a dispatch the way it always has", () =>
  Effect.gen(function*() {
    const scope = yield* StepIdentity.allocationScope({ kind: "action", name: "payments/Charge" })
    expect(scope).toBe("<the recorded digest>")
  }))
```

The same discipline applies to a completion token, a derived execution id, and a
child execution id digest. Each one is read by a process that did not write it.

## Related pages

- [Inspect the plan a body builds](/guides/inspect-the-plan/): the accessors a
  topology test reads.
- [The runtime port](/concepts/the-runtime-port/): what the in-memory engine
  is standing in for.
