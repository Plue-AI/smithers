---
title: "Claim a run and finish it"
description: "Take ownership of a run, keep its lease alive while you work, record progress, and settle it: the two-phase claim, the atomic form, heartbeat supervision, and the fenced transition."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/run-store/docs/guides/claim-and-finish-a-run.md"
---

This is the path a durable executor walks on every run it picks up. Each step
is a compare-and-swap you can lose, and losing is normal.

## Read the row and choose the snapshot

Every claim guards three fields. Read the row; you can restate those three as
the `expected` snapshot:

```ts
import type { RunRow, RunSnapshot } from "@smthrs/run-store/RunStore"

const snapshot = (row: RunRow): RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})
```

The three-field helper is optional: a complete `RunRow` returned by `get` can
also be passed directly as `expected`. The store copies only the three guarded
fields; extra own data fields are ignored. Missing or inherited required fields,
enumerable accessors on any key, and non-plain prototypes are refused.

## Claim, then activate

`claim` reserves a `pending` or `suspended` row and hands back the
`claimedAtMs` that is your fence token for the second step. `activate` trades
that token for ownership:

```ts
import { RunStore } from "@smthrs/run-store"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"

const take = (runId: string, owner: OwnerId) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const row = yield* runs.get(runId)
    const expected = snapshot(row)
    const nowMs = yield* Clock.currentTimeMillis

    const claim = yield* runs.claim(runId, expected, owner, nowMs)
    if (claim._tag !== "Claimed") return claim

    const activation = yield* runs.activate(runId, owner, claim.claimedAtMs, expected)
    if (activation._tag !== "Activated") {
      yield* runs.abandonClaim(runId, owner, claim.claimedAtMs)
    }
    return activation
  })
```

Take `nowMs` from `Clock.currentTimeMillis`, not from `Date.now()`. It is the
value the store persists as `claimed_at_ms`, and a reading more than
`heartbeatSkewAllowance` ahead of the store's own clock fails with
`invalid_run`.

Release the claim when activation loses. The gap between the two calls exists
so a caller can do work that must not be repeated, such as recording in the
journal who is taking the run over. If that work or the activation fails, a
claim nobody is using would block the next sweeper until it went stale.

## Or take it in one call

When there is nothing to do between reserving and owning, `claimAndOwn` is one
compare-and-swap:

```ts
const takeAtomically = (runId: string, owner: OwnerId) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const row = yield* runs.get(runId)
    const nowMs = yield* Clock.currentTimeMillis
    return yield* runs.claimAndOwn(runId, snapshot(row), owner, nowMs)
  })
```

It admits `pending`, `suspended`, and `running` rows. Re-entering a run you
already own needs nothing extra. Replacing a _different_ running owner needs
matching liveness evidence as the fifth argument, and reports
`EvidenceRequired` when the snapshot is still current, the other owner's
heartbeat is stale, and no evidence was supplied. Re-reading and retrying
cannot make progress from there; see
[Take over a stalled run](/guides/recover-a-stalled-run/).

## Keep the lease alive

An owner that stops writing `heartbeat_at_ms` is stealable after
`heartbeatStaleAfter`. `Ownership.heartbeatLoop` pulses until the fence is lost
and then interrupts itself, so racing it against the work makes losing
ownership interrupt the work:

```ts
import { Ownership } from "@smthrs/run-store"

const runOwned = <A, E>(
  runId: string,
  owner: OwnerId,
  work: Effect.Effect<A, E, RunStore.RunStore>
) => Effect.raceFirst(work, Ownership.heartbeatLoop(runId, owner))
```

Use `Effect.raceFirst` rather than `Effect.race`: the loop signals a lost fence
by interrupting itself, and `raceFirst` settles on the first outcome of either
side, interruption included.

## Record progress without giving up ownership

`transitionOwned` with the target `running` keeps the owner and rewrites only
the executable state. It is how a mid-flight run persists what a resume would
re-enter:

```ts
const checkpointRun = (runId: string, owner: OwnerId, state: unknown) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    return yield* runs.transitionOwned(runId, owner, "running", JSON.stringify(state))
  })
```

Omit the state argument to change status alone. Passing it rewrites
`state_json`; the column is never partially merged.

## Settle it

A terminal transition clears the owner, the heartbeat, and any claim, and
stamps `finished_at_ms`:

```ts
const finish = (runId: string, owner: OwnerId, state: unknown) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const outcome = yield* runs.transitionOwned(
      runId,
      owner,
      "completed",
      JSON.stringify(state),
      { cancelRequested: "absent" }
    )
    return outcome
  })
```

The guard is optional and is compiled into the same `UPDATE`, so a cancellation
request that arrives while you are deciding cannot slip between a check and a
terminal write. `GuardFailed` means you still own the run and the guard refused
it, which is a different situation from `FenceLost`.

`suspended` is the other useful target: it clears ownership without stamping
`finished_at_ms`, parking the run so any host may claim it again.

## The outcomes you have to handle

| Outcome            | Which call                      | What it means                                                          |
| ------------------ | ------------------------------- | ---------------------------------------------------------------------- |
| `NotFound`         | any                             | No such run row.                                                       |
| `AlreadyClaimed`   | `claim`, `claimAndOwn`, `steal` | Another process holds the claim columns.                               |
| `HeartbeatFresh`   | `claim`, `claimAndOwn`, `steal` | The row is `running` under a live lease.                               |
| `SnapshotChanged`  | claim family, `activate`        | The row moved between your read and your write.                        |
| `EvidenceRequired` | `claimAndOwn`                   | The snapshot is current and its stale owner needs evidence to replace. |
| `ClaimLost`        | `activate`, `abandonClaim`      | The claim columns no longer match your token.                          |
| `FenceLost`        | `heartbeat`, `transitionOwned`  | Another owner holds the run. Stop working on it.                       |
| `GuardFailed`      | `transitionOwned`               | You own the run; the guard predicate refused the write.                |

Every one of these is a success value. `RunStoreError` is reserved for invalid
input, corrupt rows, and database failures, so a caller can retry contention
without retrying corruption. See [Troubleshooting](/troubleshooting/).
