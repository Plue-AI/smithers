---
title: "Quickstart"
description: "Compose a durable engine over one SQLite file, run a flow, then run it again from a fresh engine and watch the sealed step replay instead of executing."
sidebar:
  order: 2
---

This quickstart builds the production composition over one SQLite file, runs a
flow through it, and then builds a second engine over the same file. The second
run replays the recorded attempt instead of executing the step again, which is
the whole point of the package.

## Prerequisites

- Node.js 26.4.0 or later.
- A package with the dependencies installed. Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

## Declare a sealed action and a flow

Create `quickstart.ts`. The action is `sealed`, which is what makes its result
addressable and therefore replayable:

```ts
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Schema from "effect/Schema"

export const Measure = Action.make("quickstart/Measure", {
  payload: {},
  success: Schema.String,
  tier: "sealed",
  idempotencyKey: "quickstart/measure/v1"
})

export const Analyse = Flow.make("quickstart/Analyse", {
  payload: {},
  success: Schema.String,
  body: (payload) => Measure.call(payload)
})
```

## Open the database and install the schema

`Migrations.layer` installs the composed schema for every storage package the
engine uses. It sits under the stores, so no store is exposed before its tables
exist:

```ts
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Migrations } from "@smthrs/engine-store"
import * as Layer from "effect/Layer"

const database = (filename: string) =>
  Layer.provideMerge(
    Migrations.layer,
    Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
  )
```

## Build the storage context

The engine needs the journal, the three run and cache stores, the durable
engine state, an owner identity, a workspace root, and an artifact store:

```ts
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import { DurableEngineState, OwnerIdentity } from "@smthrs/engine-store"
import { SqlJournal } from "@smthrs/journal"
import * as Workspace from "@smthrs/kernel/Workspace"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"

const stores = (filename: string, root: string) =>
  Layer.mergeAll(
    SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    DurableEngineState.layer,
    OwnerIdentity.layer,
    Workspace.layer(root),
    ArtifactStore.layerFileSystem({ directory: `${root}/.flows/objects` })
  ).pipe(Layer.provideMerge(database(filename)))
```

## Build the engine

`StepBoundary.layer` measures the declared read and write sets of each step.
`WorkspaceSandbox.layerFileSystem()` runs each sealed body in an isolated
workspace, which is what lets the boundary honestly claim it observed the whole
tree. `Jj` records compensable snapshots; this flow uses a sealed action, so a
stub keeps the wiring honest without requiring a `jj` binary:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodePath from "@effect/platform-node/NodePath"
import { EngineStore, StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
import { Jj } from "@smthrs/kernel"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { Ownership } from "@smthrs/run-store"
import * as Effect from "effect/Effect"

const stubJj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () =>
      Effect.succeed({ changeId: "quickstart-snapshot" as never, commitId: "quickstart-commit" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const engine = (filename: string, root: string, hostId: string) =>
  EngineStore.layer({
    owner: { hostId },
    journalSource: `${hostId}-engine`,
    isAlive: Ownership.sameHostPidProbe
  }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(StepBoundary.layer, WorkspaceSandbox.layerFileSystem(), stubJj)
    ),
    Layer.provideMerge(stores(filename, root)),
    Layer.provideMerge(Layer.mergeAll(NodeCrypto.layer, AtomicFileSystem.layer, NodePath.layer))
  )
```

`AtomicFileSystem.layer` is Node's filesystem carrying the packaged
descriptor-relative helper. The workspace sandbox refuses to build over a plain
`NodeFileSystem.layer`: its copy-back must never follow a symlink swapped into
the workspace while it writes.
`NodePath.layer` supplies the host's path syntax. The boundary and the sandbox
resolve the workspace root with it, so a Windows drive root confines correctly.

`isAlive` is the liveness arbitration this engine applies before stealing a run
from a stale owner. `Ownership.sameHostPidProbe` asks this machine's process
table, so a second process over the same file cannot take a run out of a live
one. Omit it and the lease alone decides. See
[Reclaim runs from a dead host](./guides/reclaim-runs-from-a-dead-host.md).

## Run it twice

The implementation is attached per composition, so the same declaration can be
driven by two independently built engines over one file. Count the executions
to see the replay:

```ts
export const main = (filename: string, root: string): Effect.Effect<{
  readonly first: string
  readonly second: string
  readonly executions: number
}> =>
  Effect.gen(function*() {
    let executions = 0

    const implementation = Measure.toLayer(() =>
      Effect.sync(() => {
        executions += 1
        return "42"
      })
    )

    const flow = Layer.mergeAll(implementation, Interpreter.layer(Analyse)).pipe(
      Layer.provideMerge(Action.layerImplementations)
    )

    const first = yield* Effect.scoped(
      Analyse.execute({}, { executionId: "analyse-1" }).pipe(
        Effect.provide(flow.pipe(Layer.provideMerge(engine(filename, root, "worker-a"))))
      )
    )

    // A second engine over the same file: a different process, in effect.
    const second = yield* Effect.scoped(
      Analyse.execute({}, { executionId: "analyse-1" }).pipe(
        Effect.provide(flow.pipe(Layer.provideMerge(engine(filename, root, "worker-b"))))
      )
    )

    return { first, second, executions }
  }).pipe(Effect.orDie)
```

Run it against a real file and print the result:

```ts
console.log(await Effect.runPromise(main("./.quickstart/.flows/engine.db", "./.quickstart")))
```

```text
{ first: '42', second: '42', executions: 1 }
```

## What just happened

The first run claimed `analyse-1`, opened an attempt row for the sealed step,
ran the body inside a workspace transaction, settled the step boundary, and
recorded the result under a content-addressed step key. The journal holds every
one of those decisions.

The second engine, a different owner over the same database, found the
succeeded attempt row for the same key and replayed it. The body never ran, so
`executions` stays at 1. Delete the file and the count becomes 2, which is the
falsifiable version of the claim.

## Next steps

- [Compose a durable engine](./guides/compose-a-durable-engine.md): every
  required and optional service, and what each one changes.
- [Attempts and replay](./concepts/attempts-and-replay.md): why a succeeded
  row replays, why a failed row rethrows, and what admission refuses.
- [Cache admission](./concepts/cache-admission.md): what makes a result
  reusable by a different run rather than only by this one.
