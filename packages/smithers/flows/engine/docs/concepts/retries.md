---
title: "Retries and attempts"
description: "The engine holds the single retry decision point: how it numbers attempts, where the elapsed-time origin comes from, the four decisions a policy can produce, and what an irreversible action must declare before it may retry."
sidebar:
  order: 4
---

`RetryPolicy` is declared in [`@smthrs/flow`](/api/flow). Deciding what to do
with it is the engine's job, and it happens in exactly one place: after an
action dispatch settles and its recorded outcome is decoded. Nothing else
in the system classifies a failure as retryable.

## The attempt number

An attempt number starts at 1 and identifies both the attempt row and the rung
of the backoff ladder. It has to survive a process restart, or a resumed run
would sleep the ladder from the beginning and re-dispatch a failure the store
already recorded as terminal.

When the store implements `actionLatestAttempt`, the engine asks it for the
highest persisted attempt for this step key and continues from there whenever
that number is above the one the caller passed. A value that is not a safe
integer is rejected with a warning and the caller's number is used instead.

Without that member the counter is in-process, which is correct for the
in-memory engine and for any store that keeps no attempt rows.

## The elapsed-time origin

A policy's `expirationMs` is a schedule-to-close bound: the whole retry
sequence gives up after that much wall-clock time, however many attempts fit
inside it. Measuring it needs the moment the FIRST attempt started, which the
current process may never have seen.

When a policy declares `expirationMs` and the store implements
`actionRetryOrigin`, the engine asks the store for the persisted start time of
the earliest surviving attempt for this key, and measures from there. Three
answers are possible:

- A usable time. The budget is measured from the true first attempt.
- `Option.none()`, meaning no attempt row survives, usually because retention
  pruning removed them. The engine falls back to the current clock and logs a
  warning, because turning benign pruning into spurious run failures is worse
  than granting a fresh window.
- A time that is not finite, or is in the future. The engine logs a warning and
  starts the budget now.

## The four decisions

When a dispatch settles as a failure and the action declares a policy, the
engine asks the policy for a decision:

Classification uses the decoded error's tag. A corrupt recorded outcome fails
schema validation before another attempt can run. A cause containing a defect
or interruption propagates without retry, even when it also contains a declared
failure.

| Decision            | What the engine does                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| Retry after a delay | Sleeps the delay, increments the attempt, and dispatches again.                                   |
| Attempts exhausted  | Decodes and propagates the final declared failure; annotates `retry.stopReason` as `"exhausted"`. |
| Policy expired      | Decodes and propagates the final declared failure; annotates `retry.stopReason` as `"expired"`.   |
| Non-retryable       | Decodes and propagates the original failure; annotates `retry.stopReason` as `"nonRetryable"`.    |

When retries stop, the action's declared error channel is preserved, so typed
recovery, including a graph `Catch`, can handle the final business failure.
The action span records `retry.stopReason` and the one-based `retry.attempt`.
Use these annotations to distinguish an exhausted attempt budget from an
expired elapsed-time budget.

A settlement that is not a completion, which for the action path means a
suspension, returns immediately. A parked action is not a failed one.

## Irreversible actions must be addressable to retry

An action declared `tier: "irreversible"` may not be retried unless it declares
an `idempotencyKey`. Re-dispatching an irreversible effect that the engine
cannot address is how one charge becomes two, so the engine dies with
`Action.IrreversibleRetryRequiresIdempotencyKey` rather than dispatching.

The refusal is raised twice on purpose: before a dispatch whose attempt number
is already above 1, which catches a restart that resumed into a retry, and
before following a policy's retry decision.

## Compensable actions retry against a snapshot

An action declared `tier: "compensable"` runs inside a snapshot boundary. The
engine snapshots before each executing attempt, diffs afterward, and restores
the earliest snapshot before a retry. This survives a process restart only
when the driver implements `Encoded.actionSnapshot` and persists the supplied
`ActionExecuteOptions.snapshot` handle before executing the action. That
contract also skips boundary work for journal replay. Without it, restoration
is process-local; `layerMemory` uses that fallback, and `@smthrs/engine-store`
implements the durable contract. See
[Run a compensable action](../guides/compensable-actions.md).

## What is not a retry

Two other things bound work, and neither is this decision point:

- A flow's `suspendedRetryPolicy` bounds how long ONE CALLER polls a suspended
  execution. It is per-caller and not durable, and a spent budget cancels
  nothing. See [Suspension and cancellation](./suspension.md).
- A flow's `maxRounds` bounds how many trampoline rounds one lineage may open.
  See [Trampoline rounds](./trampoline-rounds.md).
