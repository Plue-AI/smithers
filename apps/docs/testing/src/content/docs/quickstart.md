---
title: "Quickstart"
description: "Run the mandatory engine conformance suite against the engine that ships: nine black-box pins covering identity, interruption, replay, and race, in fifteen lines of test."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/testing/docs/quickstart.md"
---

This quickstart certifies an engine. You register the nine mandatory
conformance pins as vitest cases, point them at the in-memory implementation of
the production engine, and watch identity, interruption, replay, and race run
against it. Nothing is stubbed but the storage.

## Prerequisites

- Node.js 26.4.0 or later.
- A package with the test dependencies installed. Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

Both `effect` packages are exact peer pins. [Installation](/installation/)
says why.

## Register the suite

Create `engine.test.ts`. A conformance case is a value with a `name` and a
`run`, so registering the suite is a loop:

```ts
import { Conformance, EngineSubject, FlowEngineLike } from "@smthrs/testing"
import { describe, it } from "@smthrs/testing/Vitest"
import * as Effect from "effect/Effect"

// The subject: the conformance port over the engine's in-memory runtime.
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

Three things are load bearing here.

`it` comes from `@smthrs/testing/Vitest`, not from `vitest`. Its `scoped` and
`effect` registrars run each body under a `TestClock`, and the race and
interrupt pins advance virtual time. Registering them through `it.live`, which
uses the real clock, hangs them.

`Effect.provide(subject)` is inside the body, so every case builds its own
engine. A subject shared across cases would let one pin's journal answer
another pin's question.

`FlowEngineLike.layerMemory` is one expression, and it is the only line that
names an implementation. Swapping it is how the same nine cases certify a
different engine.

## Run it

```bash
pnpm vitest run engine.test.ts
```

```text
 ✓ engine.test.ts > engine conformance > identity/distinct-executions 132ms
 ✓ engine.test.ts > engine conformance > identity/idempotency-key 3ms
 ✓ engine.test.ts > engine conformance > identity/digest-key-stability 40ms
 ✓ engine.test.ts > engine conformance > interrupt/fiber-abort 116ms
 ✓ engine.test.ts > engine conformance > replay/completed-prefix 11ms
 ✓ engine.test.ts > engine conformance > replay/suspended-frontier 7ms
 ✓ engine.test.ts > engine conformance > race/loser-interrupted 15ms
 ✓ engine.test.ts > engine conformance > race/recorded-winner-replay 15ms
 ✓ engine.test.ts > engine conformance > race/recorded-loser-interruption 15ms

 Test Files  1 passed (1)
      Tests  9 passed (9)
```

## What each pin proved

| Pin                                | The claim it holds the engine to                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `identity/distinct-executions`     | Two runs of one flow and payload, with no idempotency key, are two independent executions.                   |
| `identity/idempotency-key`         | A repeated idempotency key returns the first execution instead of starting a second.                         |
| `identity/digest-key-stability`    | Sealed aliases sharing one digest reuse a single recorded result; duplicate unsealed steps run separately.   |
| `interrupt/fiber-abort`            | An interrupt reaches the live body fiber, and the journal records the outcome it produced.                   |
| `replay/completed-prefix`          | A resume replays the completed prefix instead of re-running it, and continues at the first unfinished step.  |
| `replay/suspended-frontier`        | An execution that suspended resumes from its frontier rather than from the beginning.                        |
| `race/loser-interrupted`           | The losing branch is interrupted and its interruption is journaled as an `aborted` outcome.                  |
| `race/recorded-winner-replay`      | A replay reconstructs the journaled winner even when the timing is inverted so the recorded loser would win. |
| `race/recorded-loser-interruption` | The loser's recorded interruption replays as recorded rather than being re-raced.                            |

## Run the suite against your own engine

`FlowEngineLike.layerMemory` is one binding of a port. Any implementation of
`EngineSubject` runs the identical case list, and the port is five methods
wide:

| Method      | What the suite expects of it                                                   |
| ----------- | ------------------------------------------------------------------------------ |
| `run`       | Starts an execution from a `FlowSpec` and a payload, and answers how it ended. |
| `result`    | Reads how a named execution ended, without starting anything.                  |
| `interrupt` | Cancels a running execution.                                                   |
| `resume`    | Continues a suspended or interrupted execution and answers how it ended.       |
| `journal`   | Returns the entries the execution wrote, each carrying its own `index`.        |

[Certify an engine](/guides/certify-an-engine/) builds one of these against
a real implementation.

## Next steps

- [Certify an engine](/guides/certify-an-engine/): filtering the suite,
  restart and hard-kill subjects, and what conformance does not cover.
- [Register an Effect test body](/guides/register-effect-tests/): the
  registrars, the layer per case, and the clock each one supplies.
- [Test tiers](/concepts/test-tiers/): why a harness here is a layer set
  rather than a class.
