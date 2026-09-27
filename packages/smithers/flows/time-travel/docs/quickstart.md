---
title: "Quickstart"
description: "Execute a durable run, then replay it: compose the time-travel service onto an engine, address a frame, and fold the run's journal into an answer."
sidebar:
  order: 2
---

This quickstart replays a run from its own history. You execute an ordinary
durable flow, leave it parked at a durable wait, and then fold the journal it
wrote into a number. Nothing is stubbed except the version-control service,
which replay never calls.

By the end you will have the two things every other operation needs: a
composition that provides `TimeTravel`, and a `Position` that addresses a point
in a run's past.

## Prerequisites

- Node.js 26.4.0 or later.
- A package with the dependencies installed. Not on npm yet; see [Installation](/docs/installation/#use-the-libraries).

## Declare a run worth replaying

Create `quickstart.ts`. The flow posts a ledger entry and then waits on a
durable deferred, which is what leaves the run suspended with its history
committed rather than finished and gone:

```ts
import { Action, DurableDeferred, Flow } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/** A sealed action. Its result is recorded, so replaying it is a cache read. */
const Credit = Action.make({
  name: "quickstart/Credit",
  success: Schema.Number,
  tier: "sealed",
  idempotencyKey: "quickstart/credit/v1",
  execute: Effect.succeed(30)
})

/** The durable wait the run parks at. */
const Settlement = DurableDeferred.make("quickstart/settlement", { success: Schema.String })

/** The step the flow's body names; the wait lives in its implementation. */
const Post = Action.make("quickstart/Post", { payload: {}, success: Schema.String })

const post = () =>
  Effect.gen(function*() {
    const amount = yield* Credit
    const settlement = yield* DurableDeferred.await(Settlement)
    return `${amount}:${settlement}`
  })

const Ledger = Flow.make("quickstart/Ledger", {
  payload: {},
  success: Schema.String,
  body: (payload) => Post.call(payload)
})
```

## Compose time travel onto the engine

`TimeTravel.layer` asks only for injectable contracts, so it merges onto a
durable engine composition over the same SQLite file. Building it also finishes
or rolls back any rewind a crash interrupted, which is why recovery never
appears as a call:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
import { Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { Jj } from "@smthrs/kernel"
import { Ownership } from "@smthrs/run-store"
import { SqlTimeTravelStore, TimeTravel } from "@smthrs/time-travel"
import * as Layer from "effect/Layer"
import { dirname } from "node:path"

/**
 * A Jujutsu service that records nothing. Replay never calls it; the layer
 * requires it because fork and rewind do.
 */
const stubJj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "quickstart-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const durableEngine = (filename: string) =>
  NodeRuntime.layer(
    {
      filename,
      workspaceRoot: dirname(filename),
      owner: { hostId: "quickstart" },
      isAlive: Ownership.sameHostPidProbe
    },
    StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    Layer.empty
  ).pipe(
    Layer.provideMerge(stubJj),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeFileSystem.layer)
  )

const layer = (filename: string) =>
  Layer.mergeAll(Post.toLayer(post), Interpreter.layer(Ledger)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(TimeTravel.layer),
    Layer.provideMerge(SqlTimeTravelStore.layer),
    Layer.provideMerge(durableEngine(filename))
  )
```

`SqlTimeTravelStore.layer` applies its own migration ladder while it is built.
The database must already have the journal and run-store ladders applied;
missing prerequisite tables fail with a typed `TimeTravelError`. Run
`Migrations.run` to install the complete durable schema on a fresh database; see
[Provide a store](./guides/provide-a-store.md).

## Execute the run, then replay it

A frame is the pair `(lineageId, seq)`. The sequence comes from the journal;
the lineage comes from `FlowEngine.Lineage`, the one constructor that mints
one. The engine stamps its result on every record the run writes, so an
ordinary run is addressable as it stands:

```ts
import { FlowEngine } from "@smthrs/engine"
import { Journal, JournalEvent } from "@smthrs/journal"

export interface Summary {
  readonly entries: number
  readonly frame: number
  readonly attempts: number
}

export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    // Drive the run until it parks at the deferred. It releases ownership on
    // the way out, which is the state fork and rewind both require.
    yield* Ledger.execute({}, { executionId: "ledger-1", discard: true })

    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: "ledger-1" as JournalEvent.RunId, limit: 200 })
    // The frame to read at: the last sequence this run committed.
    const seq = page.entries.at(-1)?.seq ?? 0

    const timeTravel = yield* TimeTravel
    const attempts = yield* timeTravel.inspect(
      { runId: "ledger-1", frame: { lineageId: FlowEngine.Lineage.root("ledger-1"), seq } },
      {
        initial: 0,
        reduce: (count: number, entry) => entry.eventType === "flows.engine.attempt-started" ? count + 1 : count
      }
    )

    return { entries: page.entries.length, frame: seq, attempts }
  }).pipe(Effect.provide(layer(filename)), Effect.scoped, Effect.orDie)

console.log(await Effect.runPromise(main("./.smithers/quickstart.sqlite")))
```

Run the file with your TypeScript runner:

```text
{ entries: 8, frame: 7, attempts: 2 }
```

The run wrote eight journal entries, the frame addresses the last of them, and
folding the prefix under that frame finds the two attempts the engine had
admitted there. The exact counts follow from what the engine recorded, not from
anything the projection stores.

## What just happened

`inspect` read committed evidence and nothing else. It paged the run's journal
in sequence order, kept the entries whose `meta.lineageId` matches the frame,
stopped at the frame, and handed each one to your `reduce`. There is no
dispatcher behind it, so a replay can never re-execute a model call or a child
flow, and no amount of replaying changes the run.

The `Position` you built is the same value the other two verbs take.
`timeTravel.fork(position)` branches a child run that inherits the history
under it. `timeTravel.rewind(position)` removes everything above it.

## Next steps

- [Replay a run into a view](./guides/replay-a-run.md): the read knobs, lineage
  filtering, and what a projection may and may not do.
- [Fork a run at a frame](./guides/fork-a-run.md): the child run, its workspace,
  and what it inherits.
- [Rewind a run to a frame](./guides/rewind-a-run.md): the fenced protocol, the
  detached-child policy, and the audit row it leaves.
- [Frames and lineage](./concepts/frames-and-lineage.md): why a frame carries a
  lineage rather than a run.
