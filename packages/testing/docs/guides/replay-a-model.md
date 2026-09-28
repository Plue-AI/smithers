---
title: "Replay a model instead of calling one"
description: "Record a model exchange once, then replay it on every later run: the file-backed fixture store, CachedModel for a record-or-replay seam, RecordedModel for a strict double, and RecordingModel on its own."
sidebar:
  order: 4
---

A model test runs the same code twice. The first run has no fixture, so it
calls the provider and writes what came back. Every run after it reads that
file and never touches the network.

## Record, then replay

`CachedModel` is both halves. A request whose canonical digest is already in
the fixture replays from it; a request that is not runs against the live model
and is appended.

```ts
import { CachedModel, FixtureStore } from "@smthrs/testing"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("./fixtures/balance.json", import.meta.url))

const modelLayer = Layer.unwrap(
  Effect.map(
    Effect.acquireRelease(FixtureStore.makeFile(fixture), (store) => store.flush()),
    (store) => CachedModel.layer({ live: liveModel(), fixture: store })
  )
)
```

The first run records:

```bash
pnpm vitest run test/balance.test.ts   # fixtures/balance.json does not exist yet
git add test/fixtures/balance.json
```

Read the fixture before you commit it. Each call stores the full request and
response: the system prompt, every message, and tool arguments and results.
The recorder refuses token-shaped credentials such as `sk-` keys and JWTs (see
[A credential is never recorded](../concepts/fixtures.md#a-credential-is-never-recorded)),
but it does not detect private user content or a password in any other shape.
Record against test data you can publish.

Every run after it replays:

```bash
pnpm vitest run test/balance.test.ts   # no API key, no network
```

The fixture is consulted per call rather than once, so a miss recorded by one
call is a hit for the next identical call inside the same run.

## Decide how to record

The package exposes the layers and nothing else. It reads no environment
variable and has no opinion about how a suite decides to record. Three shapes
are common:

- An environment flag such as `SMTHRS_RECORD=1` that swaps `live` for a model
  with no credentials, so a run that forgot to record fails loudly.
- A separate `test:record` script.
- Deleting the fixture file and re-running.

## Pick a fixture store

| Constructor                      | Behavior                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `FixtureStore.makeFile(path)`    | Recovers the JSON and journal. Appends to the journal; `flush` publishes JSON. Node only. |
| `FixtureStore.makeMemory(init?)` | Keeps the fixture in memory. `load` reports `None` until the first call is recorded.      |

Each has a `layer` form: `FixtureStore.layerFile(path)` and
`FixtureStore.layerMemory(init?)`.

The file store journals each append and atomically publishes JSON at `flush`.
The scoped example above flushes even when a test fails. A path permits one
active writer; competing stores fail instead of overwriting calls. See
[file persistence and recovery](../concepts/fixtures.md#file-persistence-and-recovery)
for lock ownership and recovery after a killed process.

Neither method has an error channel. A fixture that cannot be read or decoded
is a broken test setup rather than an outcome the code under test can handle,
so it is a defect. A fixture that does not exist yet is `None`, which is what a
first recording run sees.

## Replay strictly

`RecordedModel` is the strict double. It matches by request shape with
`modelId` erased, claims each recorded call once, dies on a request the fixture
does not describe, and dies on a fixture recorded against another model:

```ts
import { RecordedModel } from "@smthrs/testing"
import * as Effect from "effect/Effect"

const asserted = Effect.gen(function*() {
  const replay = yield* RecordedModel.make(fixture)
  yield* runTheCodeUnderTest(replay.model)
  // Nothing recorded may go unused: an unclaimed call is a call the run
  // stopped making.
  const left = yield* replay.controller.unconsumed()
  expect(left).toEqual([])
})
```

`RecordedModel.layer(fixture, options)` provides both `ModelLike` and the
controller. `RecordedModel.scripted(...calls)` builds one from handwritten
calls, for a test that wants an exchange no provider ever produced.

Pass `{ strictRequestOrder: true }` when the order of the calls is itself the
claim. Calls are claimed before the returned stream starts, so stream
interruption leaves no pending claim and no background replay fiber.

Use `CachedModel` when a test only needs its calls to be free and
deterministic. Use `RecordedModel` when the test must assert that exactly the
recorded calls happened.

## Record without a cache

`RecordingModel` is the recorder on its own, for a test that wants the calls in
memory rather than in a file:

```ts
import type { Fixture } from "@smthrs/testing"
import { RecordingModel } from "@smthrs/testing"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"

const observed = Effect.gen(function*() {
  const recorded = yield* Ref.make<ReadonlyArray<Fixture.RecordedCall>>([])
  const model = RecordingModel.make(liveModel(), (call) => Ref.update(recorded, (calls) => [...calls, call]))
  yield* runTheCodeUnderTest(model)
  return yield* Ref.get(recorded)
})
```

The sink cannot fail and needs no services, so wrapping a model never widens
its stream's error channel or its requirements.

## What a recorder refuses to record

Two calls never reach a fixture, and both refusals protect the replay:

- **An interrupted call, or one that died.** A truncated stream has no `settle`
  event and would replay as an aborted turn.
- **A call the kernel refused**, with `PermissionRequired`,
  `PermissionDenied`, or `GrantStoreError`. The provider never saw it, so there
  is no exchange to record. The failure still reaches the caller unchanged.

## Related

- [Fixtures and replay identity](../concepts/fixtures.md) explains the
  canonical digest, the memoized index, and why the doubles die rather than
  fail.
- [`@smthrs/create-app`](/api/create-app) wraps this loop as one call for a
  routed flow; see [its guide](/pkg/create-app/guides/test-a-flow).
