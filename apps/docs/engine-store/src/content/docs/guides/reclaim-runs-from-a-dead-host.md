---
title: "Reclaim runs from a dead host"
description: "Choose an isAlive check for your deployment, understand what evidence each takeover records, and read the journal to see why a steal was admitted or refused."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine-store/docs/guides/reclaim-runs-from-a-dead-host.md"
---

A process that is killed with SIGKILL leaves its runs `running` with a frozen
heartbeat. Nothing else revisits such a run on its own: it has no waiting row,
no pending clock, and no future deferred completion. This guide is about
choosing how aggressively another process may take those runs over.

## Choose an isAlive check

`isAlive` on `EngineStore.Options` is consulted before this store steals a run
whose lease has expired. Answering `true` refuses the takeover.

**Take the default when you have no better evidence.** Omit the option and the
store uses `Ownership.leaseLiveness(Ownership.heartbeatStaleAfter)`: the owner
is alive while its persisted heartbeat is younger than the staleness cutoff,
and gone once it is not.

```ts
import { EngineStore } from "@smthrs/engine-store"

const engine = EngineStore.layer({
  owner: { hostId: "worker-a" },
  journalSource: "worker-a-engine"
})
```

This is enough to reclaim from a hard kill without any application code, and
the steal it admits carries `lease-expired` evidence, which `RunStore.steal`
re-checks against the row inside the same write. A claimant that lies about the
lease loses the compare-and-swap.

**Probe the process table on a single machine.** When every engine over a
database runs on one host, ask that host:

```ts
import { Ownership } from "@smthrs/run-store"

const engine = EngineStore.layer({
  owner: { hostId: "worker-a" },
  journalSource: "worker-a-engine",
  isAlive: Ownership.sameHostPidProbe
})
```

A second process over the same file then cannot take a run out of a live one,
even while that process is busy enough to miss a heartbeat.

**Write your own for a multi-host deployment.** A supplied check receives the
recorded owner and a `LivenessContext` of `{ claimant, heartbeatAtMs, nowMs }`.
Guard any pid read with `Ownership.sameHostIncarnation(owner, claimant)`,
because a pid names a process only inside its own host's namespace. An
orchestrator that reports pod liveness is the other shape this takes.

Do not write a check that returns `false` without asking anything. That says
"the owner is gone" about an owner it never looked at, and the engine steals
runs out of live processes on the strength of it.

## Read the journal to see what happened

Every arbitration is recorded. Query the run's entries and look for two event
types:

| Record                      | `evidence`                     | Meaning                                                        |
| --------------------------- | ------------------------------ | -------------------------------------------------------------- |
| `steal-refused-owner-alive` | `lease-fresh`                  | The lease was still inside the window; no probe was consulted. |
| `steal-refused-owner-alive` | `probe`                        | Your `isAlive` check answered for the owner.                   |
| `stolen-and-activated`      | `lease-expired`                | The lease expired and nothing refused it.                      |
| `stolen-and-activated`      | `same-host-pid-dead`           | A same-host probe found the process gone.                      |
| `stolen-and-activated`      | `cross-host-unreachable-stale` | The owner was on another host and unreachable past the window. |

Refusals are deduplicated by run, refused owner, lease, and evidence, so a run
refused every second for an hour produces one record per distinct reason, not
thousands. Seeing both a `lease-fresh` and a `probe` refusal for one lease is
normal: the first is a wake arriving while the owner still pulses, the second
is the same owner alive but stalled past the window.

## What the sweep does with a stale run

The driver's periodic sweep runs on the heartbeat cadence and re-drives three
shapes through the ordinary claim, steal, and activate path: parked runs whose
cancellation was durably requested, runs parked with reason `released` by a
shutdown, and stale `running` rows left by a hard-killed owner.

The stale sweep reads a batch of 64 rows, oldest heartbeat first, and reads past
exactly the rows it is going to skip. Each refusal defers that run for two
heartbeat ticks, doubling per consecutive refusal against the same lease, capped
at the staleness cutoff. A deferral is forgotten as soon as the row leaves the
stale window, so a fresh stall under a new lease is probed on the first tick
that sees it.

## Check a run's own view

`DurableEngineState` answers directly, which is useful in a diagnostic tool:

```ts
import { DurableEngineState } from "@smthrs/engine-store"
import * as Effect from "effect/Effect"

const stalled = (staleBeforeMs: number) =>
  Effect.gen(function*() {
    const state = yield* DurableEngineState.DurableEngineState
    const stale = yield* state.staleRunningRuns(staleBeforeMs, 64)
    const parked = yield* state.waitingRuns({ reason: "released" })
    return { stale, parked }
  })
```

`staleRunningRuns` returns runs still `running` whose heartbeat froze before
the horizon, each with that heartbeat. `waitingRuns(filter)` returns parked runs matching a reason, a
`dueBeforeMs` bound, or a `cancelRequested` predicate. Results sort by ascending
`wakeAt`, with untimed waits (`wakeAt: null`) after every timed wait and ties
broken by `runId`. A `dueBeforeMs` bound includes matching deadlines and excludes
untimed waits.

## A restored backup needs an explicit fence

Restoring does not clear ownership: a restored database still carries the owner
tokens that were live when the backup was taken. Run
`DisasterRecovery.fence(manifest)` against the restored file before any engine
adopts it, or use `restoreAndFence`, which does both. See
[Back up and restore the store](/guides/back-up-and-restore/).

## Related

- [Ownership and fencing](/concepts/ownership-and-fencing/): the model
  behind this task.
- [Ownership](https://smithers.sh/docs/concepts/ownership/) on smithers.sh: the same story from
  the run store's side.
