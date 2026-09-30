---
title: "Fencing and ownership"
description: "How a run row decides which process may mutate it: the OwnerId fence, the exact-snapshot compare-and-swap, the two claim paths, and why competition is a success value rather than an error."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/run-store/docs/concepts/fencing.md"
---

A durable run outlives the process that started it. Two processes over one
database will at some point both believe they should be running the same run,
and one of them has to lose without corrupting anything. That arbitration is
what this package is for.

## The fence is an identity, not a lock

`OwnerId` is three fields, defined by [`@smthrs/journal`](https://journal.smithers.sh/reference/api/) and
re-exported from `Ownership` because it is the same token the journal accepts
on durable appends:

```ts
import type { OwnerId } from "@smthrs/run-store/Ownership"

const owner: OwnerId = { hostId: "host-a", pid: 4102, nonce: "3f9c-8b21" }
```

`hostId` names the machine, `pid` names the process, and `nonce` distinguishes
one incarnation of that process from the next. The nonce is what makes a
restarted process a different owner from its predecessor, and what lets two
engines composed inside one process tell each other apart.

Nothing is locked. Every owned write asks the injected `Consensus` strategy
whether the complete triple still holds the run inside the same serialized
write transaction as the mutation, and the run row is updated only after the
strategy answers:

```ts
const held = yield * consensus.guard(runId, owner) // fails fence_lost otherwise
yield * sql`UPDATE flows_runs SET ... WHERE run_id = ${runId}`
```

The durable writer serializes write transactions, so there is no window
between checking who owns the run and writing to it, and a displaced owner's
late write fails instead of racing. `RunStore.layer` arbitrates through the
journal's database-backed `SqlConsensus`, whose lease lives in
`flows_consensus_leases`; `RunStore.layerWith` takes any strategy, and the
journal must be built over the same instance so both agree on who holds the
run.

## The snapshot is the compare-and-swap

`RunSnapshot` is the exact triple a claim guards: `status`, `owner`, and
`heartbeatAtMs`. You read the row, restate those three fields, and hand them
back with your write. The store admits the write only while the row still
matches, and then only if the strategy grants the claim: the row admits, the
lease decides, and a refusal is reported from the row exactly as a failed
compare-and-swap always was.

```ts
import type { RunRow, RunSnapshot } from "@smthrs/run-store/RunStore"

const snapshot = (row: RunRow): RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})
```

Partial snapshots are refused as invalid input rather than treated as a miss.
`running` requires both an owner and a heartbeat; every other status requires
neither. That invariant is also a SQL `CHECK` on the table, so no writer,
including one issuing raw SQL, can leave a half-owned row behind.

## Two ways to take a run

Claiming is deliberately two phase for the engine's path, and atomic for the
control plane's.

**Two phase.** `claim` writes the claim columns (`claim_host_id`, `claim_pid`,
`claim_nonce`, `claimed_at_ms`) on a `pending` or `suspended` row and returns
the `claimedAtMs` that becomes your fence token. `activate` then trades that
token for ownership: it sets `status = 'running'`, writes the owner columns and
the first heartbeat, and clears the claim. The gap between them is where a
caller does work that must not be repeated, such as recording in the journal
who is taking the run. If activation loses, `abandonClaim` releases the
reservation so the next sweeper is not blocked by a claim nobody is using.

**Atomic.** `claimAndOwn` does both in one compare-and-swap. It admits
`pending`, `suspended`, and `running` rows, and replacing a different running
owner additionally requires matching liveness evidence. Use it when there is no
work to do between reserving and owning.

`steal` is the third entry, and it produces a claim rather than ownership: a
successful steal writes the claim columns of a stale running row, and the
caller follows with `activate`. That is why the takeover path and the ordinary
claim path converge on the same second step.

Every transition the strategy grants — `claimed`, `activated`, `released`,
`stolen`, `expired` — is appended as a `flows.consensus.*` fact on the run's
`run-store` companion journal stream in the same transaction, beside the run's
own stream rather than in it. Heartbeats renew the strategy's lease and never
enter the journal.

## Competition is a value, failure is an error

Every operation splits its answers into two channels, and the split is the
contract:

- **Success values** describe the race. `AlreadyClaimed`, `HeartbeatFresh`,
  `SnapshotChanged`, `FenceLost`, `ClaimLost`, `ClaimFresh`, `ClaimChanged`,
  `EvidenceRequired`, and `LivenessUnconfirmed` all mean the store worked
  correctly and your write did not win.
- **`RunStoreError`** describes a defect. Invalid input (`invalid_run`), a
  corrupt durable row (`decode_failed`), a constraint violation
  (`constraint`), a missing row on a direct read (`not_found_row`), and a
  database failure (`persistence_failed`).

A caller can therefore retry contention without retrying corruption, and can
type its error channel without swallowing races. Each outcome and its cause is
listed in [Troubleshooting](/troubleshooting/).

## Leaving a run

`transitionOwned` is the only way to move a run you own, and the target decides
what happens to the ownership columns:

- `running` keeps the owner and updates only the executable state. It is how a
  run records progress mid-flight.
- `suspended` clears the owner, the heartbeat, and the claim, and leaves
  `finished_at_ms` null. The run is parked and claimable again.
- `completed`, `failed`, and `cancelled` clear the same columns and stamp
  `finished_at_ms`. A terminal row is never claimed, activated, or reopened.
- `pending` is refused with `invalid_run`. A run does not go back to unstarted.

A transition may also carry a `TransitionGuard`, an extra predicate evaluated
in the same write transaction as the fence check. `{ cancelRequested:
"absent" }` is the "do not finalize a run somebody asked to cancel" rule,
expressed inside the serialized transaction rather than as a read-then-write
race. See [Cancel a run](/guides/cancel-a-run/).

## Attempts inherit the run's fence

`AttemptStore` never carries its own ownership. `put`, `heartbeat`, `finish`,
and `patch` each embed an `EXISTS` subquery over `flows_runs` requiring that
the run is `running` and owned by the caller. One consequence is worth knowing
before you debug it: once a run reaches a terminal status its owner columns are
cleared, so every later attempt write on that run reports `FenceLost`. A
delayed write from a displaced owner cannot rewrite the winning row.
