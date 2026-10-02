---
title: "@smthrs/run-store"
description: "Durable run state and fenced ownership for long-running jobs: which runs exist, what each one is doing, which process owns it, and how a restart takes one back safely."
---

`@smthrs/run-store` keeps the live state of long-running jobs in a SQL database.
It answers two questions about every run: what is it doing right now, and which
process is allowed to touch it.

It is an [Effect](https://effect.website) library of two services, `RunStore`
and `AttemptStore`, plus the ownership arbitration that decides who holds a run.

## What it solves

A process that owns a long job can die at any moment. Two things then go wrong.
The work is stranded, because nothing else knows the job existed or how far it
got. And picking the job back up is dangerous, because the process you assume is
dead may still be alive and writing.

This package handles both in the database rather than in your code:

- **One row is the authority.** `RunStore` keeps a row per run holding its
  status, its owner, its heartbeat, whether cancellation was requested, and the
  executable state a resume re-enters. A restarted process reads that row
  instead of replaying a log to work out where it was.
- **Every owned write carries a fence.** An owner identity is
  `{ hostId, pid, nonce }`, and all three fields are compared inside the same
  SQL statement as the mutation they guard. There is no window between checking
  ownership and using it, so two processes cannot both win.
- **Competition is a value, not an error.** Losing a race returns
  `AlreadyClaimed`, `HeartbeatFresh`, or `FenceLost` as an ordinary success
  value you branch on. The error channel is reserved for real defects such as an
  invalid argument or a corrupt row.
- **Step attempts inherit the run's fence.** `AttemptStore` records when each
  execution of a step started, the checkpoints it wrote, and how it ended, and
  refuses every write from a process that no longer owns the run.

The stores carry no database of their own. They are written against the
driver-neutral [`@smthrs/database`](/api/database) contract, so the same code
runs over a local SQLite file, over a server, or over an in-memory database in a
test.

## Install

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/apps/site/docs/installation.mdx).

Node.js 26.4.0 or later. [Installation](./installation.md) covers the import
forms and the two services a composition has to supply.

## Take a run, do the work, settle it

This program creates a run, claims ownership of it, and finishes it. The stores
are the production ones. `TestRunStore.layer` provides them over a migrated
in-memory database, so the file runs with no configuration:

```ts
import { RunStore } from "@smthrs/run-store"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import * as TestRunStore from "@smthrs/run-store/test/TestRunStore"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"

const owner: OwnerId = { hostId: "worker-1", pid: 4102, nonce: "9c31-af02" }

const program = Effect.gen(function*() {
  const runs = yield* RunStore.RunStore

  yield* runs.create("build-42", JSON.stringify({ step: "checkout" }))

  const nowMs = yield* Clock.currentTimeMillis
  const taken = yield* runs.claimAndOwn(
    "build-42",
    { status: "pending", owner: null, heartbeatAtMs: null },
    owner,
    nowMs
  )
  if (taken._tag !== "Activated") return `another process has it: ${taken._tag}`

  // Do the work here, heartbeating while it runs.

  const settled = yield* runs.transitionOwned(
    "build-42",
    owner,
    "completed",
    JSON.stringify({ step: "done" })
  )
  return `run ended as ${settled._tag}`
})

console.log(
  await Effect.runPromise(
    program.pipe(Effect.provide(TestRunStore.layer), Effect.scoped)
  )
)
```

```text
run ended as Transitioned
```

The second argument to `claimAndOwn` is the row as you last read it, restated as
the three fields a claim guards. The third argument is the new owner. The claim
is admitted only while the row still matches. If a peer took the run between
your read and your write, this caller loses the race and leaves the peer's
ownership unchanged. The example then returns before calling `transitionOwned`.

## How this relates to @smthrs/flows

`@smthrs/run-store` is one of the storage services inside
[`@smthrs/flows`](/api/flows), the package that carries the whole Smithers
durable flow engine in a single dependency. When you write a flow with
`@smthrs/flows` and run it on a Node host, this package is the code deciding
which process owns your run and what a restart re-enters. Flow authors never
call it.

Reach for `@smthrs/run-store` directly when you are building the host rather
than the flow: a scheduler, a worker pool, or any service that hands durable
work between processes and needs ownership arbitration it can trust. Most hosts
do not wire it by hand even then.
[`@smthrs/engine-store`](/api/engine-store) already composes these stores with
the journal, the step cache, and the engine's own state into one storage ladder,
and `@smthrs/flows/NodeRuntime` builds that ladder over a single SQLite file.

Above all of it sits [`smithers`](/api/cli), the command line that plans, runs,
and inspects durable flows without your writing a host at all. Start there if
you want to run flows rather than build the machinery underneath them.

## Where to go next

- [Quickstart](./quickstart.md) drives one run through its whole lifecycle,
  including a step attempt, against an in-memory database.
- [Fencing and ownership](./concepts/fencing.md) explains the compare-and-swap
  every write goes through, and [the heartbeat lease](./concepts/leases.md)
  explains how a run is judged stale.
- [Claim a run and finish it](./guides/claim-and-finish-a-run.md) and
  [take over a stalled run](./guides/recover-a-stalled-run.md) are the two
  paths a host has to get right.
- [Compose the stores into a host](./guides/compose-the-stores.md) gives the
  layer order that satisfies both services.
- [API reference](./api.md) documents every export.
- [Troubleshooting](./troubleshooting.md) lists each refused outcome and typed
  error, and what to change.
