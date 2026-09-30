---
title: "The owner fence"
description: "Why the durable channel takes an OwnerId, what makes a write fail with fence_lost, and when the unfenced channel is the correct one."
sidebar:
  order: 2
---

A run can outlive the process that claimed it. A machine pauses, a supervisor
declares the run abandoned, another process takes it over, and then the first
process wakes up holding a half-finished lifecycle write. Without a fence, that
zombie write lands behind the live successor and the run's history says two
processes were driving it.

The journal refuses that write. `emitDurable`, `checkpoint`, and `compact` each
take an `OwnerId`, and each lands only while the consensus strategy the
journal was built with still records that owner as holding the run.

## The token

`OwnerId.OwnerId` is three fields:

```ts
import type * as OwnerId from "@smthrs/journal/OwnerId"

const owner: OwnerId.OwnerId = {
  hostId: "host-1",
  pid: process.pid,
  nonce: "run-1-claim"
}
```

`hostId` and `nonce` are plain strings. `pid` is a real operating-system
process id, so the schema states that: a non-negative integer.

The token lives in this package rather than with the ownership arbitration in
[`@smthrs/run-store`](/api/run-store) because the journal is what it fences.
The run store stores the token on runs and decides who holds it, and its
`Ownership` module re-exports `OwnerId` alongside that arbitration.

## What the fence actually checks

A fenced write joins the injected `Consensus` strategy's `guard` inside its
own write transaction. The guard succeeds while the strategy records the
supplied token as the run's owner and fails `fence_lost` otherwise, and
because the durable writer serializes write transactions no reclaim can
commit between the guard and the statements beside it.

Two consequences follow:

- A run that another process reclaimed fails the write with `fence_lost`.
- A run whose owner released it, because it suspended or finished, fails the
  same way. A finished run does not accept late lifecycle writes.

The strategy is the journal's own service. `SqlJournal.layer` fences through
`SqlConsensus`, whose lease lives in `flows_consensus_leases`, a table this
package's migrations create; `SqlJournal.layerWith` fences through whatever
strategy the composition provides, such as `Consensus.layerLocal` for a
single process. The same instance must arbitrate the run store's claims, which
is why `RunStore.layerWith` takes the strategy too.

## Who arbitrates

The journal owns the rules: one writer per run, fenced and unfenced appends,
commit-time admission, the generation fence, steal only on staleness plus
liveness evidence, and ownership transitions as events. A strategy chooses
where the lease lives and how the fence is checked. The claim lifecycle is
two-phase — `claim` or `steal` reserves the run and returns a grant
timestamp, `activate` presents that grant to take ownership, `release` gives
it back, and `recover` clears a dead claimant's stale claim — and
[`@smthrs/run-store`](/api/run-store) drives it for a durable run, mirroring
the outcome on the run row in the same transaction.

Heartbeats renew the lease and never enter the journal.

## A bad token is not a lost fence

An owner that is missing, null, or not an `OwnerId` at all fails
`invalid_event`. That is a caller contract violation, and reporting it as
`fence_lost` would send the caller hunting a race that never happened. A
fractional or negative `pid` is the common case.

Read the two codes as different questions:

- `fence_lost` asks who owns this run now. Stop writing.
- `invalid_event` asks what you passed. Fix the argument.

## The unfenced escape

`emitDurableUnfenced` is the same durability and the same receipt contract with
no fence. It exists for admissions that are genuinely ownerless, where
first-writer-wins is the design rather than an accident. The canonical case is
an external trigger: a deferred completion or a clock-schedule record delivered
by a sweeper that owns no run, where the producer dedup index rather than the
fence is the idempotency mechanism.

A caller that holds an `OwnerId` uses `emitDurable`. Reaching for the unfenced
channel to get past a `fence_lost` writes exactly the zombie entry the fence
exists to reject.

## Related reading

- [Write a fenced lifecycle event](../guides/write-lifecycle-events.md) is the
  task-shaped version of this page.
- [Execution IDs and ownership](/docs/concepts/ownership/) covers how a run
  acquires and loses the token in the first place.
