---
title: "The runtime port"
description: "FlowRuntime is the service the authoring APIs are written against, what it must provide, and why this package depends on nothing that implements it."
sidebar:
  order: 6
---

`FlowRuntime` is the smallest service a `Flow`, an `Action`, a `DurableDeferred`,
or a `DurableClock` needs in order to be executed, polled, suspended, and
resumed. This package declares that port and depends on nothing that implements
it. The dependency runs one way:

```text
@smthrs/flow          declares FlowRuntime
      ↓
@smthrs/engine        implements it
      ↓
@smthrs/engine-store  makes the implementation durable
```

There is deliberately no dependency, type-only or otherwise, from
`@smthrs/flow` back to `@smthrs/engine`. That is what lets the authoring model
bundle for a browser, and what lets a test swap a whole engine for a fixture
without touching a declaration.

## What the port provides

| Method                                                    | What it does                                                                                    |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `register`                                                | Binds a flow tag to the behavior that drives it. `Interpreter.layer` is the only public caller. |
| `execute`                                                 | Starts or joins an execution under a given id, optionally discarding the result.                |
| `poll`                                                    | Answers the current `Result` of an execution, or nothing when it is known and unsettled.        |
| `interrupt`, `interruptUnsafe`                            | Requests cancellation. A durable engine records the request before interrupting anything.       |
| `resume`                                                  | Re-drives a suspended execution.                                                                |
| `actionExecute`                                           | Dispatches one action attempt and records its exit.                                             |
| `deferredResult`, `deferredDone`, `deferredDoneIfWaiting` | Reads and writes durable deferred completions.                                                  |
| `scheduleClock`                                           | Arms a durable timer.                                                                           |
| `recordNode`                                              | Optional. Records the graph a run was driven from, and how each node settled.                   |

Every method takes a flow whatever its requirement channel says and demands none
of it. The channel is a compile-time statement about which action implementations
a body names, and the port sits below where that statement is settled: a runtime
resolves each call by the tag the node carries, which is the only thing left of a
plan read back out of a journal. `Flow.execute`, one level up, is where the
requirements are collected.

`deferredDoneIfWaiting` answers a `DeferredDoneIfWaitingOutcome` of `Completed`,
`Existing`, or `NotWaiting`. It exists so a completion can be admitted as one
mutation only while its run is actually parked on that wait, which is what stops
a guessed or stale token from pre-answering a run. It does not authorize the
caller: a token is an unsigned address, so the host authorizes whoever
completes an open wait.

`recordNode` is the one optional method, and optional in the strong sense: a
runtime that keeps no history leaves it absent and the walk is unchanged, so no
interpreter behavior may depend on whether one is there. An engine with a
journal implements it by writing the record. Each record carries its own
replay-stable `sourceId`, and an implementation must use that as the record's
producer identity rather than minting one per observation: that is what makes a
resumed walk collapse onto the rows the first walk wrote instead of recording
every node twice. It is separate from `actionExecute` because a node is not an
action, and three of the four records describe nodes no action ever dispatched.

## The per-execution instance

`FlowRuntime.FlowInstance` is one execution's frontier state: its `executionId`,
`lineageId`, `flow`, a `scope` closed only when the execution fully completes,
the mutable `suspended`, `interrupted`, `waiting`, `handoff`, and `cause` fields,
and `actionState`. This package declares the contract; a runtime constructs the
value. A completion wakes a parked run through `FlowRuntime.resume`.

## Declaring a wait

`FlowRuntime.annotateWaiting(annotation)` is how an implementation tells a
durable driver what kind of wait is about to happen, so the run parks under that
reason and token rather than a derived default. A `WaitingAnnotation` is
`{ reason, wakeAt?, token? }`. `Sleep` declares `timer` with the deadline,
`WaitFor` declares `event` with the wake token, and `HumanTask` declares
`approval` with the current attempt's token.

## Failures the port defines

| Failure                 | Raised when                                                                                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FlowCycleDetected`     | Executing a flow would close a cycle in the persisted parent-execution chain. `path` holds the ordered execution ids from the cycle's target back to itself.                                                   |
| `FlowExecutionNotFound` | `poll` or `resume` names an execution id the runtime never recorded.                                                                                                                                           |
| `CancelRequestFailed`   | A durable runtime could not record a cancellation. `cancel_request_failed` is a storage failure; `unsafe_interrupt_unsupported` is the durable engine refusing `interruptUnsafe`, which it does not implement. |

`CancelRequestFailed` is the reason `interrupt` is not fire and forget: the
request is recorded before anything is interrupted, so a caller that cannot
record it learns the run is still going instead of being told it stopped.

## Implementing the port

Two implementations ship:

- `FlowEngine.layerMemory` from [`@smthrs/engine`](/api/engine) keeps every
  recorded step in the process. Use it for tests and local development.
- The durable engine from [`@smthrs/engine-store`](/api/engine-store) backs the
  same port with SQLite, which is what turns a suspended run into one a later
  process resumes.

A third implementation is an ordinary exercise: satisfy the port and every
declaration in this package runs against it unchanged.

## Related pages

- [Suspension and replay](./suspension-and-replay.md): what the port's park and
  resume mean to a body.
- [Testing](../testing.md): running flows against the in-memory implementation.
