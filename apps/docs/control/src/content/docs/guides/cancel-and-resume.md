---
title: "Cancel a run, and restart one"
description: "Stop a run you may not own and restart one nobody is driving: what each receipt means, why both verbs read terminality first, and how a cancel reaches a run in another process."
sidebar:
  order: 6
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/control/docs/guides/cancel-and-resume.md"
---

`cancel` and `resume` are the two lifecycle verbs, and they share a shape:
a run id, a caller-stated `reason`, and an idempotency key. Both record who
asked, and both read the run's terminality before anything else.

## Cancel a run

```ts
import { Control } from "@smthrs/control/Control"
import * as Effect from "effect/Effect"

const cancel = Effect.gen(function*() {
  const control = yield* Control
  return yield* control.cancel({
    runId: "run-17",
    reason: "budget",
    idempotencyKey: "cancel:run-17"
  })
})
```

The `reason` is free text and it is recorded on the
`control.run.cancel-requested` entry the mutation writes, then projected back
onto `RunSummary.cancellation`. An operator reading a cancelled run a week
later asks "why", and a control plane that never carried the answer cannot
produce one afterwards.

### What comes back

| Receipt                          | Meaning                                                    |
| -------------------------------- | ---------------------------------------------------------- |
| `Terminal` with the run's status | The run settled, either before this call or because of it. |
| `Accepted`                       | The request is durable and a live peer will act on it.     |

A cancel that this process could interrupt answers `Terminal` naming
`cancelled`, because the run really did settle in this call. A cancel against a
run a live peer is holding answers `Accepted`: the request is on the engine
row, and the owner stops the run at its next cancel poll.

`cancel` deliberately does not replay its recorded receipt. Its answer is a
statement about a run, and the run moves on. See
[Receipts and idempotency](/concepts/receipts/).

### How a cancel reaches another process

Fibers are process-local, so an interrupt only stops a run this process is
driving. The durable half travels through the executor:

1. `ControlExecutor.requestCancel` writes `cancel_requested_at_ms` on the
   engine row, inside the mutation's transaction. An engine that refuses rolls
   the whole cancel back, because a control row that says `cancelled` over an
   engine row that is still running is the one state an operator cannot
   recover from.
2. The attribution entry is written, unless the executor answered
   `already-requested`, which means the column was already set and the record
   already exists.
3. The local fiber is interrupted. A parked run has no owner, so the cancelling
   process claims the park itself in order to end it.
4. `ControlExecutor.settleCancelledPark` runs _after_ the mutation commits, so
   the parked execution is finished before the process that asked goes away.
   Driving a run re-enters the engine, whose writes would wait on the writer
   the transaction holds.

An executor that answers with a `CancelTerminal` reports that the engine row
had already settled. Nothing was cancelled, so no attribution is written, and
the control row is reconciled onto the engine's own status instead.

## Restart a run

```ts
const resumed = yield * control.resume({
  runId: "run-17",
  reason: "operator retry",
  idempotencyKey: "resume:run-17"
})
```

`run` with a `Resume` input is the same operation:

```ts
yield * control.run({ _tag: "Resume", runId: "run-17", idempotencyKey: "resume:run-17" })
```

One resume, one implementation. The two spellings exist because RPC clients and
the CLI reach for different ones.

### What comes back

| Receipt          | Meaning                                                                     |
| ---------------- | --------------------------------------------------------------------------- |
| `Terminal`       | The run had already settled. Nothing to restart.                            |
| `Accepted`       | The run was claimed, or the restart was recorded for the host that owns it. |
| `AlreadyApplied` | An earlier call under this key already restarted it.                        |

`ClaimLost` is the failure, and it names a real peer: a run at `running` or at
the `accepted` a claim writes is being held by a live process, so there is
nothing to restart and pretending otherwise would hide the peer.

A run the _engine_ created, a child, a fork, or a later trampoline round, keeps
its own driver. Both public resume spellings use `scope: "launched"` and journal
`control.run.resume`; they leave engine-created rows unclaimed to preserve
the continuation state. The caller or a journal subscriber must drive the
execution, even when the plane claims a control-launched run. Explicit resume
does not call `requestResume` or `ControlExecutor.resumeRun` and creates no
`pendingResumes` entry. Node-approval decisions use that durable delegation
mechanism. An `Accepted` receipt does not establish that execution started.

## What the CLI does

[`smthrs runs cancel`](https://smithers.sh/docs/reference/cli/runs/) and `smthrs runs cancel-all` both reach
`cancel`; [`smthrs runs resume`](https://smithers.sh/docs/reference/cli/runs/) reaches `resume`. Both record the
principal the CLI authenticated, so `RunSummary.cancellation.principal` names a
person rather than a process.

## Where to go next

- [Cancellation attribution](/concepts/cancellation/): what the answer to
  "who cancelled this" is built from.
- [Ownership, fences, and claims](/concepts/ownership/): why `ClaimLost` is
  the right refusal.
- [Connect an execution engine](/guides/implement-an-executor/): the four methods
  these verbs call.
