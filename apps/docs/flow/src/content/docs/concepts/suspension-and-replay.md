---
title: "Suspension and replay"
description: "The three results a flow settles with, what parking on a durable wait actually does, and what a re-driven round replays."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/flow/docs/concepts/suspension-and-replay.md"
---

A flow round settles with one of three results, and the difference between them
is the whole durability story.

| Result           | Meaning                                                                           |
| ---------------- | --------------------------------------------------------------------------------- |
| `Flow.Complete`  | The round finished. It carries an `Exit`, so a typed failure is a completion too. |
| `Flow.Suspended` | The round parked on a durable wait and will be re-driven.                         |
| `Flow.Handoff`   | The round ended by handing off to the next round of a trampoline lineage.         |

`Flow.isResult` is the guard, `Flow.Result({ success, error })` builds the schema,
and `Flow.ResultEncoded` is the stored form.

## What parking does

A durable wait is not a held fiber. When a body reaches `Sleep.action`,
`WaitFor.action`, `HumanTask.action`, or an unresolved `DurableDeferred`, the
implementation declares how it is about to wait through
`FlowRuntime.annotateWaiting` and then suspends. The engine records a waiting row
carrying that annotation and releases the run. The process can exit.

A `WaitingAnnotation` is `{ reason, wakeAt?, token? }`, and the reason is what an
operator reads off the run:

| Reason     | Declared by                                                         |
| ---------- | ------------------------------------------------------------------- |
| `timer`    | `Sleep`, with the deadline as `wakeAt`.                             |
| `event`    | `WaitFor`, carrying the wake token a completion is matched against. |
| `approval` | `HumanTask`, carrying the current attempt's token.                  |

`execute(payload, { discard: true })`, `start(payload)`, and
`ensure(payload, { key })` acknowledge admission without awaiting the result;
the run can stay parked after the caller receives its execution id.
Ordinary `execute` follows the run instead: a parked run keeps its caller waiting.
`flow.poll(executionId)` answers `Option.none` for a run that is known and has
not settled. An id the
runtime never recorded is `FlowRuntime.FlowExecutionNotFound` instead, which is a
different fact and a different failure.

## What a re-drive replays

`flow.resume(executionId)` re-drives a suspended execution. The round starts over
from the top of the body, which is safe precisely because the body is a plan:

1. The graph is rebuilt. Same declarations, same payload, same node addresses.
2. Every node whose result the engine already recorded settles from that record.
   No dispatch happens.
3. The walk reaches the node that was unsettled and drives it. If its wait is now
   resolved, the recorded completion is what it reads.

Nothing about a resume collects the flow's requirements. The runtime captures the
context a flow was registered under and merges it beneath whatever the run
supplies, so the implementations that made the first round possible are the ones
a re-driven round reaches. A party holding an execution id is not the party
holding the layers.

Completion is first-writer-wins. A `DurableDeferred` records the first exit
submitted against it, and every later read replays that exit. A second completion
does not overwrite the first.

## The caller's polling budget

Ordinary `execute` follows a suspended run, polling and re-driving it instead
of returning a suspended result. Its default `suspendedRetryPolicy` has no
attempt or expiry bound, so the caller can keep waiting while the run is parked.
A bounded `Flow.make` `suspendedRetryPolicy` limits **one caller**: if its
schedule is spent, `execute` fails with a `SuspendedResumeGaveUp` defect, but
the execution stays parked. The next caller starts a budget of its own. This
budget is not durable and does not cancel the run.

What bounds work durably is an action's own `RetryPolicy`. The engine restores
`maxAttempts` from the persisted attempt sequence and the `expirationMs` origin
from the first attempt's start time, so those survive park, resume, and process
death. See [Retry a failing action](/guides/retry-a-failing-action/).

## Failures, defects, and parking on either

Two annotations on the flow decide what a round does with something that went
wrong:

```ts
import { Flow } from "@smthrs/flow"

const Hardened = Review
  .annotate(Flow.CaptureDefects, true)
  .annotate(Flow.SuspendOnFailure, true)
```

- `Flow.CaptureDefects` defaults to `true`. It includes defects in the result of
  the flow and its actions instead of letting them escape the execution.
- `Flow.SuspendOnFailure` defaults to `false`. Set it when a round should park on
  any error rather than fail, so an operator can fix the cause and resume.

`Flow.intoResult` is what turns a handler effect into a `Result` under those two
annotations, and it closes the round's flow scope on completion or handoff.

## Scope and cleanup

Each round has its own flow scope. Suspension keeps that scope open for a
re-drive of the same instance. Terminal completion closes it with the round's
success or failure exit. Handoff closes it with a success exit; the next round
has a fresh scope.

A handoff completes the round successfully and discards its `withRollback` registrations.
A later round's failure cannot invoke an earlier round's rollback. The engine
does not provide lineage-scoped compensation. Compensation across rounds
requires an explicit durable design, not an in-memory scope finalizer. Open
scopes and their resources do not survive process death.

- `Flow.scope` is the scope itself.
- `Flow.provideScope(effect)` runs an effect against it.
- `Flow.addFinalizer(f)` registers an exit finalizer, preserving the services
  available where it was registered.
- `Flow.withRollback(effect, rollback)` registers how to undo a successful effect
  if the current round later exits unsuccessfully. See
  [Cancel a run and undo its effects](/guides/cancel-and-roll-back/).

## Related pages

- [Wait for a deadline](/guides/wait-for-a-deadline/) and
  [wait for an external signal](/guides/wait-for-an-external-signal/): the
  two ways a body parks on purpose.
- [Trampoline rounds](/concepts/trampoline-rounds/): the third result, and the loops it
  makes possible.
