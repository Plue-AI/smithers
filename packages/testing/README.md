# @smthrs/testing

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://testing.smithers.sh

Testing and conformance library for Smithers flows. It provides layered engine
and model doubles, pure plan and journal assertions, restart and parity suites,
Vitest adapters, and deterministic score gates.

`@smthrs/testing/ScoreGate` re-exports the pure grading contract from
`@smthrs/scorers/ScoreGate` and adds the fixed-suite runner and `ciGrade`
report helper. Runtime applications import scorers directly; testing stays a
development dependency. `TestingError.ScoreGateError`, `ScoreGateCode`, and
`InvalidScoreSample` re-export the same class and schemas from scorers, so
constructor identity, tags, fields, and existing test imports are preserved.

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/).

`effect` is a required peer at exactly `4.0.0-rc.115`. `vitest` and
`@effect/vitest` are optional peers, needed only by the `Vitest` adapter.
Everything else runs under any runner, because an assertion is an ordinary
`Effect` and a conformance case is a plain value. Node.js 26.4.0 or later is
required.

## What is in it

- **Assertions** over the artifacts a flow produces: `PlanAssertions` for a
  built plan, `JournalAssertions` for a journal, `Divergence` for the first
  attributable difference between two journals, `ScoreGate` for graded eval
  suites.
- **Layer bundles** that make a tier explicit: `TestLayers.unit` for the unit
  tier, `TestLayers.poisoned` for plan-time purity, and `TestHost` for a fully
  deterministic host surface.
- **Conformance suites** an implementation must pass: `Conformance.coreSuite`
  for any engine, `HostSuite.hostSuite` for any Host bundle.
- **Doubles**: `MemoryEngine` and `RestartableEngine` as reference engines,
  `FlowEngineLike` as the adapter that runs the same pins against the real
  engine, and `RecordedModel`, `RecordingModel`, and `CachedModel` as the
  record-and-replay model loop.

`@smthrs/testing/TestHost` supplies the deterministic host services a run
needs, while `@smthrs/journal` supplies `TestJournal`. This package also
supplies what a test says about the run those services produced and the doubles
the run executes against.

Every module, every export, and the contract of each is at
<https://testing.smithers.sh/reference/api/>.

## Inspect real processes

`@smthrs/testing/ProcessTable` queries explicit POSIX `ps` columns with a
64 MiB buffer. Select a PID for resident-size and state probes, or scan the
table for containment checks. Use `comm` for executable names and `args`
when a script marker must be distinguished from its interpreter. Spawn
failures throw; an absent selected PID returns empty text. This Node-only
helper stays off the main barrel so browser test hosts remain portable.

## Certify an engine in fifteen lines

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

Nine black-box pins run: identity, interruption, replay, and race. The race and
interrupt cases advance a `TestClock`, which is why they are registered through
`it.scoped` rather than `it.live`.

## Record, then replay

A model test runs the same code twice. The first run has no fixture, so it
calls the provider and writes what came back. Every run after it reads that file
and never touches the network. `CachedModel` is both halves.

```ts
import { CachedModel, FixtureStore } from "@smthrs/testing"
import { Effect, Layer } from "effect"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("./fixtures/balance.json", import.meta.url))

const modelLayer = Layer.unwrap(
  Effect.map(
    Effect.acquireRelease(FixtureStore.makeFile(fixture), (store) => store.flush()),
    (store) => CachedModel.layer({ live: liveModel(), fixture: store })
  )
)
```

The package reads no environment variable, so how a suite decides to record
stays the suite's business. Two rules the recorder follows, because a fixture is
executable state: an interrupted or dead call is not recorded, because a
truncated stream would replay as an aborted turn; and a call the `@smthrs/kernel`
permission kernel refused is not recorded either, because the provider never saw
it.

`RecordedModel` is the strict double instead: it claims each recorded call once,
matches by request shape with `modelId` erased, and dies on a request the
fixture does not describe.

## Four modules stay off the root barrel

The root entry point exports one namespace per module, and each is also
importable from `@smthrs/testing/<Module>`. Four are reachable only by
subpath.

`TestHost` is the deterministic host bundle: an in-memory filesystem, scripted
interpreter, `TestClock`, and seeded PRNG. It remains a subpath so importing
generic assertion helpers does not initialize test-only platform services.

`Vitest` is ESM only. `vitest` refuses to load through `require()`, so a barrel
that carried it would break `require("@smthrs/testing")` for every CommonJS
consumer of the assertion helpers.

`Faults` is not a double: it is a set of real, machine-global fault primitives.
`killProcess` sends a real signal to a real pid and waits for the operating
system to reap it, `parentPid` and `waitForReparent` read the orphan a kill
leaves behind, and `skewClock` moves the wall clock a durable timer is measured
against. Importing it by subpath keeps that decision visible at the import site.

```ts
import { isAlive, killProcess, waitForReparent } from "@smthrs/testing/Faults"

await killProcess(engine.process)
const reparented = await waitForReparent(orphan, engine.process.pid!)
```

Pids, process groups, and ports are machine global, so give a suite that uses
`Faults` its own tree and its own runner config: `fileParallelism: false`, a
finite timeout, and coverage off.

`ProcessTable` spawns `ps` through `node:child_process`, which browser test
hosts cannot load, so it stays at `@smthrs/testing/ProcessTable`. See
[Inspect real processes](#inspect-real-processes).

`@smthrs/testing/package.json` is also exported. `internal/*` and nested
`*/index` subpaths are not public.
