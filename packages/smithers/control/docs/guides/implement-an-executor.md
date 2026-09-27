---
title: "Connect an execution engine"
description: "Implement ControlExecutor so plan launches start real runs and cancels, signals, and resumes reach the engine: the five methods, the answers each one may give, and why a launch forks."
sidebar:
  order: 8
---

`ControlExecutor` is the seam between authority and execution. The plane hands
work over and learns only what the executor did with it.

Without it, the plane records facts nobody reads: a cancel that answers
`ClaimLost` to every process but the owner, a signal a parked run never sees,
and a resume nothing subscribes to.

## The five methods

```ts
interface Service {
  readonly launch: (input: Launch) => Effect.Effect<Acceptance, LaunchFailed>
  readonly requestCancel: (input: CancelRequest) => Effect.Effect<CancelRecord, PersistenceError>
  readonly deliverSignal: (input: Signal) => Effect.Effect<SignalDelivery, PersistenceError>
  readonly resumeRun: (input: ResumeRequest) => Effect.Effect<ResumeUptake, PersistenceError>
  readonly settleCancelledPark: (input: CancelRequest) => Effect.Effect<void, PersistenceError>
}
```

Each answer is a small closed vocabulary, and every value in it is a real
deployment:

| Method                | Answer                             | Means                                                                      |
| --------------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| `launch`              | `accepted`                         | This executor took the launch. The plane writes `running`.                 |
|                       | `pending`                          | It queued the launch. The plane releases the row as `control.run.pending`. |
|                       | fails `LaunchFailed`               | Nothing will ever drive this run. The plane settles the row as `failed`.   |
| `requestCancel`       | `recorded`                         | This call set `cancel_requested_at_ms` on the engine row.                  |
|                       | `already-requested`                | The column was already set, so the attribution record already exists.      |
|                       | `unknown`                          | This executor's engine has no row for the run.                             |
|                       | `{ _tag: "Terminal", status }`     | The engine row has already settled.                                        |
| `deliverSignal`       | `delivered`, `no-match`, `unknown` | See [Deliver a signal](./signal-a-run.md).                                 |
| `resumeRun`           | `resuming`                         | This executor hosts the run, took the fence, and is re-driving it.         |
|                       | `unknown`                          | It drives no execution for this run.                                       |
| `settleCancelledPark` |                                    | Finishes a parked execution whose cancellation is already durable.         |

`already-requested` is not a detail. The write is first-writer-wins and every
repeat of `cancel` re-runs the whole mutation, so answering `recorded` to all
of them journals one `control.run.cancel-requested` per ask for a single
cancellation.

`settleCancelledPark` exists because a park has no owner, so nothing is driving
the run and nothing reads the request `requestCancel` wrote. The engine's
parked-run sweep does, once per heartbeat, but a short-lived `smthrs runs cancel`
process writes the request at the very end of its life and exits first. The
plane calls this _after_ the cancel mutation commits, never inside it: driving
a run re-enters the engine, whose writes would wait on the writer the
transaction holds.

## Start from the noop

`ControlExecutor.makeNoop` answers the honest absence for every method, so an
implementation overrides only what it supports:

```ts
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as Effect from "effect/Effect"

const executor = ControlExecutor.makeNoop({
  launch: ({ plan, run }) =>
    Effect.sync(() => {
      queue.push({ flowId: plan.card.flowId, runId: run.runId })
      return "pending" as const
    })
})
```

`ControlExecutor.layer(executor)` and `ControlExecutor.layerNoop(overrides)`
provide it.

## Start the run the plane minted

`launch` receives the stored plan and the run row the plane has committed, and
it must start _that_ run: `run.runId` is the execution id, so the events the
engine journals and the row the plane projects name one run.

```ts
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as ControlRuntime from "@smthrs/control/ControlRuntime"
import type * as ControlSchema from "@smthrs/control/ControlSchema"
import type { FlowRuntime } from "@smthrs/flow"
import { Executable, Registry } from "@smthrs/registry"
import { RunStore } from "@smthrs/run-store"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import type * as Path from "effect/Path"

/** How a discovered descriptor is loaded, and what it may delegate to. */
const bridge: Executable.Options = { delegates: [] }

const executorLayer = Layer.effect(ControlExecutor.ControlExecutor)(
  Effect.gen(function*() {
    const plane = yield* ControlRuntime.ControlRuntime
    const services = yield* Effect.context<
      | Crypto.Crypto
      | FileSystem.FileSystem
      | FlowRuntime.FlowRuntime
      | Path.Path
      | Registry.Registry
      | RunStore.RunStore
    >()

    return ControlExecutor.makeNoop({
      launch: ({ plan, run }) =>
        Effect.gen(function*() {
          const executable = yield* Executable.fromRegistry(plan.card.flowId, bridge)
          Effect.runForkWith(services)(
            executable.flow.execute(
              { input: plan.decodedInput },
              { executionId: run.runId, discard: true }
            ).pipe(Effect.andThen(mirror(plane, run.runId)))
          )
          return "accepted" as const
        }).pipe(Effect.provide(services), Effect.orDie)
    })
  })
)
```

It forks so launch acceptance does not wait for execution to finish. Admission
is already committed before `launch` runs. After the executor answers
`accepted`, the plane marks a still-accepted run as running; an outcome the
executor has already recorded, including a parked or completed run, is preserved.

## Mirror the engine's status back

The plane cannot see into the engine's database, so an executor that walked
away after starting a run would leave every run reading `running` forever.
Reading the engine's own row back and writing the plane's vocabulary onto the
plane's row is the whole of that duty, and it is the `mirror` the launch above
chains onto:

```ts
/** The engine's run vocabulary, in the plane's. */
const planeStatus = (status: RunStore.RunStatus): ControlSchema.RunStatus =>
  status === "suspended" ? "parked" : status === "pending" ? "accepted" : status

const mirror = (plane: ControlRuntime.Service, runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const row = yield* runs.get(runId)
    const id = runId as ControlSchema.RunId
    const fence = yield* plane.claimFence(id)
    yield* plane.writeStatus(id, fence, planeStatus(row.status))
  }).pipe(Effect.orDie)
```

The engine calls a parked run `suspended`; an operator calls it `parked`. The
two vocabularies are not the same set, so the mapping is explicit: every status
the engine reports has to land on a member of `ControlSchema.RunStatus`, which
is the only vocabulary the plane's row accepts.

The complete, runnable bridge, with discovery, two databases, and one shared
journal, is
[`examples/src/24-control-plane-and-gateway.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/24-control-plane-and-gateway.ts).

## Where to go next

- [Ownership, fences, and claims](../concepts/ownership.md): what
  `claimFence` and `writeStatus` are doing.
- [Cancel a run, and restart one](./cancel-and-resume.md): the sequence
  `requestCancel` and `settleCancelledPark` sit inside.
- [Store control state in a database](./durable-storage.md): the other half of
  a real deployment.
