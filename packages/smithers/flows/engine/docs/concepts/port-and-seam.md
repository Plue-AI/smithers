---
title: "The port and the seam"
description: "Why the engine is two layers: the FlowRuntime port that flows talk to, the low-level Encoded contract a store implements, and the makeUnsafe adapter that holds every policy in between."
sidebar:
  order: 1
---

`@smthrs/flow` declares a port and no implementation. `FlowRuntime` is that
port: the service `Flow.execute`, `Action.call`, `DurableDeferred`, and
`DurableClock` all resolve through. This package implements it, and it does so
in two pieces with a seam between them.

```text
@smthrs/flow                @smthrs/engine
  Flow, Action,   port      makeUnsafe(encoded)
  DurableDeferred, ──────▶    step identity, retries,
  DurableClock,               rounds, suspension
  RetryPolicy                        │
                                     ▼
                               Encoded seam
                          layerMemory here,
                          @smthrs/engine-store durable
```

## Why the seam exists

Everything that decides behavior lives above the seam, in `makeUnsafe`:

- which persisted key an action dispatch is recorded under,
- whether a failed attempt retries, waits, or gives up,
- how a handoff opens the next trampoline round,
- how a caller polls a suspended execution and when it stops.

Everything below the seam decides only where bytes live. That is what makes
the in-memory engine a real engine rather than a mock: it answers the same
questions the durable one answers, because it does not answer them at all. A
test that passes against `layerMemory` is testing the production decision
points.

The cost of the split is that a store implements a slightly awkward interface
instead of the clean typed one, which is the next section.

## What crosses the seam encoded

`Encoded` is named for a property only some of its members have. An
implementation that encodes the rest produces a silently wrong system, because
those members are typed `Flow.Result<unknown, unknown>` and nothing decodes
them on the way out.

| Member                                                                | Value crossing the seam                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `actionExecute`, `deferredResult`                                     | Encoded. `makeUnsafe` decodes through the action's `exitSchemaPartial` or the deferred's `exitSchema`. |
| `deferredDone`, `deferredDoneIfWaiting`                               | Encoded. `makeUnsafe` encodes the exit before the call.                                                |
| `execute`, `poll`                                                     | Decoded `Flow.Result` values the implementation produced itself.                                       |
| `register`, `interrupt`, `interruptUnsafe`, `resume`, `scheduleClock` | No flow-declared payload at all.                                                                       |

An implementation of `execute` or `poll` therefore decodes on its own, through
`Flow.Result({ success: flow.successSchema, error: flow.errorSchema })`, before
it answers.

## What a store buys by implementing an optional member

Seven members are optional. A store implements the guarantees it supports:

| Optional member         | What implementing it buys                                                                                                                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actionRetryOrigin`     | A `RetryPolicy.expirationMs` budget measured from the first attempt's persisted start time, so a schedule-to-close bound survives park, resume, and process death. Without it the budget restarts on each process.                            |
| `actionLatestAttempt`   | An attempt counter that resumes from the persisted sequence, so a replayed failed attempt keeps its number, the backoff ladder is not re-slept from attempt 1, and a persisted non-retryable failure is decided against the original attempt. |
| `resumeSignal`          | An in-process wake the engine races against its suspension backoff sleep, so a completed deferred resumes the waiting caller at once instead of at the next poll.                                                                             |
| `deferredDoneIfWaiting` | Conditional completion: a deferred completes only when the run is parked on the matching reason and token. Absent, the engine answers `NotWaiting` for every such request.                                                                    |
| `actionSnapshot`        | Recovers the earliest pre-attempt snapshot and opts into persisting `ActionExecuteOptions.snapshot` before execution. Replay skips snapshot work.                                                                                             |
| `recordNode`            | Records interpreter topology and settlements using their stable `sourceId` values.                                                                                                                                                            |
| `nodeRecordBytes`       | Measures the full encoded journal envelope for deterministic topology pagination.                                                                                                                                                             |

Nothing else changes when a member is absent. The engine falls back, logs where
the fallback is observable, and keeps running.

## The two implementations

`FlowEngine.layerMemory` keeps registrations, executions, action settlements,
deferred results, and clocks in maps for the life of the layer scope. It is a
deterministic runtime for tests and local development, not a bounded store:
there is no eviction option, and nothing survives the process.

It is still strict where strictness is the contract. It rebuilds a submitted
payload through the flow's own payload schema constructor at admission and
again on every re-drive, so neither the caller that submitted the payload nor a
handler that mutated the value it received can reach the value a later drive
runs on. The constructor is the copier because it is the only description of
the payload the engine has: it rebuilds each struct, array, and record the
schema declares, and hands back by reference the values the schema declares
opaque. Same-key in-flight actions share one settlement, so a concurrent
duplicate dispatch waits rather than executing twice.

[`@smthrs/engine-store`](/api/engine-store) implements the same seam over a
durable journal. Its adapter supplies the retry, wake, conditional completion,
snapshot, and node-record hooks, so a compensable retry restores its original
pre-image after a restart. Swapping the layer supplies
persistence without changing the authored flow.

## Related

- [Implement the Encoded seam](../guides/implement-the-encoded-seam.md) walks
  the contract member by member.
- [The API reference](../api.md) carries the signatures.
