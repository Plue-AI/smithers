---
title: "@smthrs/testing"
description: "The testing and conformance library for Smithers flows: plan and journal assertions, engine and host conformance suites, record-and-replay model doubles, and deterministic score gates."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/testing/docs/README.md"
---

`@smthrs/testing` is the test library for code built on Smithers flows. It
supplies the three things a flow test needs and a general test framework does
not: assertions that read a built plan and a written journal, conformance
suites an engine or a host bundle has to pass, and model doubles that record a
provider call once and replay it on every run after.

It is not a test runner. Every assertion is an ordinary `Effect` and every
conformance case is a plain value, so any runner can register them. A thin
vitest adapter ships alongside for the runner most projects already use.

## Why you would reach for it

A durable flow is hard to test with a return value. The claims that matter are
about the shape of the run: that a repeated idempotency key returns the first
execution instead of starting a second, that a resume replays the completed
prefix instead of re-running it, that the losing branch of a race is
interrupted and journaled as `aborted`. None of that is visible from what the
flow returned. It is visible in the plan the flow built and the journal the run
wrote, and this package gives you a vocabulary for both.

The second problem is the model. A step that calls a provider is slow,
nondeterministic, and billed. `CachedModel` records the first call to a fixture
file and replays it forever after, so the same test runs offline and gives the
same answer twice.

## Install

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

`vitest` and
`@effect/vitest` are optional peers, needed only by the `Vitest` adapter.
Node.js 26.4.0 or later is required. [Installation](/installation/) has the
rest.

## Certify an engine in fifteen lines

`Conformance.coreSuite()` is nine black-box pins covering identity,
interruption, replay, and race. Point them at an implementation and they run:

```ts
import { Conformance, EngineSubject, FlowEngineLike } from "@smthrs/testing"
import { describe, it } from "@smthrs/testing/Vitest"
import * as Effect from "effect/Effect"

const subject = FlowEngineLike.layerMemory

describe("engine conformance", () => {
  for (const conformanceCase of Conformance.coreSuite()) {
    it.scoped(conformanceCase.name, () =>
      Effect.flatMap(EngineSubject.EngineSubject, conformanceCase.run).pipe(
        Effect.provide(subject)
      ))
  }
})
```

`FlowEngineLike.layerMemory` is the only line naming an implementation.
Swapping it is how the same nine cases certify a different engine. Use
`it.scoped` or `it.effect`, not `it.live`: the race and interrupt pins advance
a `TestClock`, so under the real clock they wait on a clock nothing is moving.

The [Quickstart](/quickstart/) walks the same file and shows what each pin
proved.

## What is in the box

- **Assertions** over the artifacts a flow produces: `PlanAssertions` for a
  built plan, `JournalAssertions` for a journal, `Divergence` for the first
  attributable difference between two journals, and `ScoreGate` for graded
  eval suites.
- **Conformance suites** an implementation has to pass: `Conformance.coreSuite`
  for any engine, `HostSuite.hostSuite` for any Host bundle.
- **Doubles**: `MemoryEngine` and `RestartableEngine` as reference engines,
  `FlowEngineLike` as the adapter that runs the same pins against a real
  engine, and `RecordedModel`, `RecordingModel`, and `CachedModel` as the
  record-and-replay model loop.
- **Layer bundles** that make a test tier explicit: `TestLayers.unit` for the
  unit tier, `TestLayers.poisoned` for plan-time purity.
- **Fault primitives** under `@smthrs/testing/Faults`, which are not doubles:
  `killProcess` sends a real signal to a real pid, and `skewClock` moves the
  wall clock a durable timer is measured against.

## Where this sits

`@smthrs/testing` has no parent package. It sits beside the runtime it tests
rather than inside it, which is why nothing in the Smithers runtime depends on
it: you install it as a dev dependency and it reads the same public types your
own code does.

Each part of the library answers for one part of the runtime, and each of those
packages documents the types the assertions read:

| To test                                               | Use                                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| An engine, or your own runtime binding                | `Conformance`, `EngineSubject`, `FlowEngineLike`, over [`@smthrs/engine`](https://engine.smithers.sh/reference/api/)   |
| A durable engine binding rather than an in-memory one | `FlowEngineLike.layerOver`, over [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/)             |
| The plan a flow builds before anything runs           | `PlanAssertions`, over [`@smthrs/plan`](https://plan.smithers.sh/reference/api/) and [`@smthrs/flow`](https://flow.smithers.sh/reference/api/)       |
| The history a run wrote                               | `JournalAssertions` and `Divergence`, over [`@smthrs/journal`](https://journal.smithers.sh/reference/api/)             |
| A capability-gated host bundle                        | `HostSuite`, over [`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/)                                        |
| A step that calls a model provider                    | `CachedModel`, `RecordedModel`, and `RecordingModel`, over [`@smthrs/model`](https://model.smithers.sh/reference/api/) |
| A graded eval suite                                   | `ScoreGate`, alongside [`@smthrs/evals`](https://evals.smithers.sh/reference/api/)                                     |

`@smthrs/testing/TestHost` supplies the deterministic host services a run
needs, while [`@smthrs/journal`](https://journal.smithers.sh/reference/api/) supplies `TestJournal`. This
package also supplies what a test says about the run those services produced.

If you arrived here without knowing what a flow is, start at the top of the
tree: [`@smthrs/cli`](https://cli.smithers.sh/reference/api/) is the `smithers` command line, and
[`@smthrs/flow`](https://flow.smithers.sh/reference/api/) is the authoring model everything else executes.

## Next steps

- [Installation](/installation/): the import forms, the optional peers, and
  the four modules that stay off the root barrel.
- [Quickstart](/quickstart/): run the nine conformance pins and read what
  each one proved.
- [Test tiers](/concepts/test-tiers/): why a harness here is a layer set
  rather than a class.
- [Replay a model](/guides/replay-a-model/): record once, replay forever,
  and the calls the recorder refuses to write.
- [API reference](/reference/api/): every module and every export.
