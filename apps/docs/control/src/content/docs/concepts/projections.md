---
title: "Journal projections"
description: "How watch turns committed journal entries into ControlEvent values, why a cursor scopes to one run, how the snapshot hands off to the live tail, and which deltas the plane derives rather than records."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/control/docs/concepts/projections.md"
---

`watch` is a projection, not a bus. It reads committed journal entries and maps
each one onto a `ControlEvent`:

```ts
interface ControlEvent {
  readonly sequence: number
  readonly kind: string
  readonly runId?: string | undefined
  readonly occurredAt: number
  readonly payload: Json
}
```

A consumer that subscribes after the fact still receives what it missed,
because the cursor is durable and the source is a table rather than a live
fan-out that forgets.

## Partitions, and why a cursor needs a run

The journal is partitioned. Every run is a partition, and each plan gets one of
its own under the id `plan:<planId>`. Sequences are partition-local: the plan
partition and every run partition each start at 0.

One scalar cursor applied to all of them would therefore skip every lower
unseen sequence in every partition but the one the cursor came from. So
`watch` refuses either `afterSequence` or `afterCursor` without a `runId`:

```text
InvalidInput: afterSequence: a watch cursor resumes one run, so it requires runId
```

Exactly-once resumption is a promise about a scoped watch, and only about a
scoped one.

## Snapshot, follow, and the handoff between them

`WatchFilter.follow` selects the delivery mode.

- `follow: false` asks for a finite snapshot of what is durable when the
  request is handled. The stream ends. This is the mode a test and a one-shot
  reader want.
- Omitting `follow` opens the live stream a UI subscribes to. It does not end.

The live stream is a handoff, not a deduplicated overlap. The projection
subscribes to journal changes first, then pins a high-water sequence for each
partition it can see. A row committed at or below its partition's mark is read
from the finite snapshot; a row above it is read from the buffered tail. An
entry from a partition the snapshot never read has no mark and passes straight
through.

The unscoped watch reads eight partition snapshots at a time and keeps one
reserved slot so the live tail is never starved behind snapshot work. An
unbounded merge would read every partition of an unbounded database at once,
which is an allocation a remote watcher could force.

## What the plane writes

These entries are the control plane's own records. With the SQL runtime and
journal on the same database, each commits inside the same transaction as the
state change it describes.

| Kind                                                                   | Written by                                          | Partition           |
| ---------------------------------------------------------------------- | --------------------------------------------------- | ------------------- |
| `control.plan.created`                                                 | `plan`, on creation or repair of a missing entry    | `plan:<planId>`     |
| `control.approval.approved`, `control.approval.denied`                 | `approve`, `deny`                                   | the plan or the run |
| `control.run.accepted`                                                 | `run`, once the row exists                          | the run             |
| `control.run.running`                                                  | `run`, when the executor took the launch            | the run             |
| `control.run.pending`                                                  | `run`, when it did not                              | the run             |
| `control.run.resumed`                                                  | an approval on a node target, naming the delegation | the run             |
| `control.run.resume`                                                   | `resume`, carrying the principal and the reason     | the run             |
| `control.run.cancel-requested`                                         | `cancel`, carrying the principal and the reason     | the run             |
| `control.run.cancelled`, `control.run.completed`, `control.run.failed` | `cancel` and launch settlement                      | the run             |
| `control.signal.delivered`                                             | `signal`                                            | the run             |
| `control.steer.enqueued`                                               | `steer`                                             | the run             |
| `control.steer.woke`                                                   | `steer`, when it ended a park                       | the run             |
| `control.monitor.beat`, `control.monitor.healed`                       | `Monitor.run`                                       | the run             |

`plan` commits the card, idempotency key, approval token and creation entry in
one journal transaction. A keyed retry returns the stored card and checks its
partition for the creation entry. If an older write left that entry missing,
the retry appends it once before returning.

The memory runtime publishes one card per key, including concurrent requests.
It cannot roll back its maps with a journal transaction. A keyed retry repairs
a failed creation entry while retaining the original card.

## What the plane derives

Two kinds are computed from entries other packages wrote, and are emitted
beside their source entry rather than recorded:

| Derived kind              | Derived from                                                  | Module     |
| ------------------------- | ------------------------------------------------------------- | ---------- |
| `control.run.lineage`     | `flows.engine.run-decision`, `flows.time-travel.fork-created` | `Lineage`  |
| `control.steer.delivered` | `flows/notifications/Promoted`                                | `Steering` |

Deriving rather than re-recording is what keeps the halves honest. The boundary
that delivers a steer runs in the agent process, not this one, so a control
plane that wrote its own delivery record would be asserting a fact it did not
observe.

Each derived event carries its source sequence. `watch` also assigns a
composite `cursor` that distinguishes members of an expansion. Checkpoint
`event.cursor` and resume with `afterCursor` to retain unconsumed deltas.
`afterSequence` skips the whole source entry, including its deltas. Expansion
runs after the snapshot-to-tail handoff.

`Lineage.derive`, `Lineage.expand`, `Steering.derive`, and `Steering.expand`
are exported, so a client reading the journal directly reaches the same
conclusions the server does.

The two foreign event types are named as strings rather than imported. A
control plane reads journals, not engines, and one that depended on the engine
could not project a journal a different engine wrote.

## Where to go next

- [Watch a run's events](/guides/watch-a-run/): the projection as a task.
- [Run lineage](/concepts/lineage/): what a `control.run.lineage` delta says.
- [Steer a running agent](/guides/steer-a-run/): the two moments a steer
  has, and their two writers.

## Versioned lifecycle and approval producer contract

`ControlFacts` exports the version-1 control producer contract and the shared
pure run/approval fold consumed by gateway snapshots and subscriptions. This
version is independent of the harness transcript's `journalVersion` and of
journal cursor generations. Existing event kind names and source identities
remain unchanged; old consumers can continue reading their original fields.

A lifecycle fact adds `{factVersion: 1, baseline, run}` to the usual event
payload. `run` is the complete, detached `RunSummary` returned by that fenced
control write. `control.run.accepted` starts a `created` baseline. A first
upgraded status, resume claim, pending handoff, or reconciliation starts a
`legacy` baseline at its own committed sequence. Earlier history is retained
without claiming that lost transitions have been reconstructed. Unknown or
missing lifecycle facts invalidate continuous coverage until another complete
snapshot establishes a new legacy baseline. No read fabricates migration events.

`ControlFacts.commitRun` commits a control write and its fact with
`Journal.transact`. `AgentSession` uses it for terminal/parked status and resume
claims; failure does not leave a newer status with no event. `ControlLive`'s
normal admission, resume, steer, and cancellation transactions carry the same
facts, and its exceptional launch settlement and terminal reconciliation also
join a journal transaction. Low-level `ControlRuntime` calls remain available
for ownership mechanics and legacy integrations; calling them outside these
producer boundaries does not establish event coverage.

`commitApprovalRequest` validates and captures the full request, then commits
its token registration and `control.approval.requested` event together. A
resolved token does not emit a new pending request. Decisions add
`{factVersion: 1, tokenId, approvalTarget}` to their existing payload and commit
with the decision, grant, idempotency receipt, and durable node-resume intent.
The pure fold joins current requests and decisions by run/request identity and
digest. Repeated requests do not reopen a decision. Legacy records retain their
historical read contract; only legacy requests are eligible for unnamed legacy
decision fallback.

A request a runaway guard makes carries an optional `incident`
(`ControlFacts.GuardIncident`): its `Runaway` or `Stuck` classification, the
guard `source` (`tokens`, `usd`, `latency`, `model-call`, `tool-call`, `cell`), the
triggering `message`, and the numbers frozen when it tripped (`used`,
`reserved`, `max`, `next`, the `allowance` Continue authorizes, and the
timed-out `subject`). A host that re-parks the run reuses the recorded request
and its incident rather than measuring again.

These atomic guarantees require the SQL control runtime and journal to share
the same database/writer, as the production control composition does. The
in-memory test runtime has no transactional rollback protocol. `SqlJournal`
publishes committed rows after the owning writer's COMMIT; a failed insert or
outer transaction publishes no fact. Followers also replay from disk, so a
process dying after commit and before an in-process notification does not lose
the recorded transition.

This is a control-plane boundary, not a claim that all runtime state is now a
control-event fold. Native lifecycle observations commit with their own fenced
state in the engine database. The durable engine bridge copies those facts and
an authenticated `control.engine.bound` root binding into the control journal.
Gateway snapshots and subscriptions use the shared `ExecutionFact` fold to
compare that evidence with the executor's coherent root/current-round view.
The separate `executionProvenance` reports native `events`, `legacy-observation`
or `unverified-observation`; `lifecycleProvenance` still labels the executor
overlay `engine-observed` rather than calling it control replay. Bridge lag,
missing bindings, generation gaps and unknown versions retain explicit fallback.
The two databases do not become one transaction, and operational ownership,
heartbeats and protected resolver credentials retain their native authorities.

Authorized native cell calls also commit `flows.harness.call-fact.v1` invocation
and controller-result facts in their owning action transactions. The immutable
native journal is their outbox through that same bridge. Shared call projections
prefer committed facts over matching identified telemetry while preserving
display identities. Legacy trace producer hashes remain unchanged; unidentified
calls keep their limited fallback, and low-level custom ports without these
annotations remain legacy. Model deltas, printed output and other trace records
still use the best-effort channel. Durable call facts do not reconstruct missing
trace history or promise exactly-once external effects.
