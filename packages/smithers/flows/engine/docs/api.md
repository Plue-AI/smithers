---
title: "API reference"
description: "Every public export of @smthrs/engine: the FlowEngine runtime and its Encoded seam, the FlowProxy transport derivations, the FlowProxyServer layers, and the coded refusals each one raises."
sidebar:
  order: 1
---

`@smthrs/engine` exports three namespaces from its root, each also importable
from `@smthrs/engine/<Namespace>`:

| Import                           | Source                                                                                                                             | Platform |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `@smthrs/engine`                 | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine/src/index.ts)                       | any      |
| `@smthrs/engine/FlowEngine`      | [src/FlowEngine/index.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine/src/FlowEngine/index.ts) | any      |
| `@smthrs/engine/FlowProxy`       | [src/FlowProxy.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine/src/FlowProxy.ts)               | any      |
| `@smthrs/engine/FlowProxyServer` | [src/FlowProxyServer.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine/src/FlowProxyServer.ts)   | any      |

The service tag `FlowRuntime`, the `FlowInstance` service, `annotateWaiting`,
and `FlowCycleDetected` live in [`@smthrs/flow`](/api/flow). What this package
owns is the implementation.

A composition that runs one flow looks like this:

```ts
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const Compile = Action.make("example/Compile", {
  payload: { target: Schema.String },
  success: Schema.String,
  tier: "sealed"
})

const Build = Flow.make("example/Build", {
  payload: { target: Schema.String },
  success: Schema.String,
  body: (payload) => Compile.call(payload)
})

const layer = Layer.mergeAll(
  Compile.toLayer(({ target }) => Effect.succeed(`${target}.js`)),
  Interpreter.layer(Build)
).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(FlowEngine.layerMemory))
```

For a per-export reference with field-level tables, see the
[Export reference](./reference/engine.md).

## FlowEngine

The runtime. It implements `FlowRuntime` over the `Encoded` seam a store
supplies.

Recursive admission of the same flow during registration dies with the tagged
`@smthrs/engine/RegistrationFault` defect and its `flowName`. After refusal,
a fresh registration can retry.

### Layers and constructors

| Export         | Signature                                                                                                        | Meaning                                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layerMemory`  | `Layer.Layer<FlowRuntime.FlowRuntime>`                                                                           | The volatile in-memory implementation. Keeps registrations, executions, action settlements, deferred results, and clocks for the life of the layer scope.               |
| `makeUnsafe`   | `(options: Encoded) => FlowRuntime.FlowRuntime["Service"]`                                                       | Adapts a low-level encoded implementation into the typed port. Unsafe in that it trusts the implementation to persist, resume, and encode correctly.                    |
| `makeInstance` | `(flow: Flow.Any, executionId: string) => FlowRuntime.FlowInstance["Service"] & { lineageId: JournalLineageId }` | Builds the per-execution state a runtime hands a flow run: scope, suspension and interruption flags, the run's root journal lineage, and the action coordination state. |

### The encoded seam

`Encoded` is the interface a store implements. The seam is only partly encoded,
and the split is part of the contract:

| Member                                                                | Value crossing the seam                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `actionExecute`, `deferredResult`                                     | Encoded. `makeUnsafe` decodes through the action's `exitSchemaPartial` or the deferred's `exitSchema`. |
| `deferredDone`, `deferredDoneIfWaiting`                               | Encoded. `makeUnsafe` encodes before the call.                                                         |
| `execute`, `poll`                                                     | Decoded `Flow.Result` values, produced by the implementation.                                          |
| `interrupt`, `interruptUnsafe`, `resume`, `scheduleClock`, `register` | No flow-declared payload.                                                                              |

An implementation of `execute` or `poll` decodes on its own, through
`Flow.Result({ success: flow.successSchema, error: flow.errorSchema })`, before
answering. Returning an encoded value from either one produces a silently wrong
system, because the seam types those returns as `Flow.Result<unknown, unknown>`.

The members, in full:

| Member                  | Signature                                                                                                         | Meaning                                                                                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register`              | `(flow, execute) => Effect<void, never, Scope>`                                                                   | Records a flow declaration and the execute function that drives one round of it. Registrations of one tag stack: the last still-open one serves.                                                                             |
| `execute`               | `(flow, { executionId, payload, discard, parent?, round }) => Effect<Result \| void, FlowCycleDetected>`          | Starts or joins one execution and answers with its settlement. `discard: true` answers with nothing. `round` is required: it carries the execution's trampoline position, and names the preceding execution on later rounds. |
| `poll`                  | `(flow, executionId) => Effect<Option<Result>, FlowExecutionNotFound>`                                            | The settlement of one execution, when it has one.                                                                                                                                                                            |
| `interrupt`             | `(flow, executionId) => Effect<void, CancelRequestFailed>`                                                        | Requests cancellation across the named round's logical lineage and linked child lineages. Acknowledges intent, not finished cleanup. Not a pause.                                                                            |
| `interruptUnsafe`       | `(flow, executionId) => Effect<void, CancelRequestFailed>`                                                        | Forces cancellation without guaranteeing cleanup or compensation.                                                                                                                                                            |
| `resume`                | `(flow, executionId) => Effect<void>`                                                                             | Re-drives a durably suspended execution. Does not undo cancellation.                                                                                                                                                         |
| `resumeSignal`          | optional `(flow, executionId) => Effect<void>`                                                                    | An in-process wake the engine races against its suspension backoff sleep.                                                                                                                                                    |
| `actionExecute`         | `(options: ActionExecuteOptions) => Effect<Result, never, FlowInstance \| Crypto>`                                | Dispatches one action attempt and answers with its encoded settlement.                                                                                                                                                       |
| `actionRetryOrigin`     | optional `({ key }) => Effect<Option<number>, never, FlowInstance \| Crypto>`                                     | The persisted start time of the earliest surviving attempt for `key`. `Option.none()` means no attempt row survives.                                                                                                         |
| `actionLatestAttempt`   | optional `({ key }) => Effect<Option<number>, never, FlowInstance \| Crypto>`                                     | The highest persisted attempt number for `key`.                                                                                                                                                                              |
| `actionSnapshot`        | optional `({ key }) => Effect<Option<unknown>, never, FlowInstance \| Crypto>`                                    | The earliest persisted pre-attempt handle for a compensable key.                                                                                                                                                             |
| `deferredResult`        | `(deferred) => Effect<Option<Exit>, never, FlowInstance>`                                                         | The recorded result of a durable deferred, when it has one.                                                                                                                                                                  |
| `deferredDone`          | `({ flowName, executionId, deferredName, exit }) => Effect<void>`                                                 | Completes a durable deferred and re-drives the parked execution.                                                                                                                                                             |
| `deferredDoneIfWaiting` | optional `({ flowName, executionId, deferredName, reason, token, exit }) => Effect<DeferredDoneIfWaitingOutcome>` | Completes a deferred only when the run is parked on the matching reason and token. Answers `Completed`, `Existing`, or `NotWaiting`.                                                                                         |
| `scheduleClock`         | `(flow, { executionId, clock }) => Effect<void>`                                                                  | Arms a durable clock for one execution.                                                                                                                                                                                      |
| `recordNode`            | optional `(record: NodeRecord) => Effect<void, never, FlowInstance>`                                              | Records topology and node settlements under the supplied `sourceId`.                                                                                                                                                         |
| `nodeRecordBytes`       | optional `(record: NodeRecord) => Effect<number, never, FlowInstance>`                                            | Measures the complete encoded journal envelope before pagination.                                                                                                                                                            |

`ActionExecuteOptions` is what an encoded implementation receives for one
dispatch:

| Field              | Type                                                      | Meaning                                                                                                                                           |
| ------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`           | `Action.Any`                                              | The declaration being dispatched.                                                                                                                 |
| `attempt`          | `number`                                                  | The attempt number, starting at 1. Above 1 marks a retry.                                                                                         |
| `key`              | `string`                                                  | The persisted step identity the attempt is recorded under.                                                                                        |
| `tier`             | `Action.Tier`                                             | `"sealed"`, `"compensable"`, or `"irreversible"`.                                                                                                 |
| `nondeterministic` | `true \| undefined`                                       | Present when a cache put race may retain the first row without failing the run.                                                                   |
| `metadata`         | `unknown`                                                 | The declaration's metadata, passed through unread.                                                                                                |
| `snapshot`         | optional `Effect<unknown, never, FlowInstance \| Crypto>` | Evaluate and persist before actual compensable execution, after ruling out a journal hit or joined dispatch. Supplied only with `actionSnapshot`. |

[The port and the seam](./concepts/port-and-seam.md) explains the design, and
[Implement the Encoded seam](./guides/implement-the-encoded-seam.md) is the
task-shaped walkthrough.

### The snapshot boundary

`SnapshotBoundary` is the host hook compensable actions run inside. This
package declares the service and ships no implementation.

| Member     | Signature                                                                  |
| ---------- | -------------------------------------------------------------------------- |
| `snapshot` | `(options: SnapshotBoundaryOptions) => Effect<unknown>`                    |
| `restore`  | `(snapshot: unknown, options: SnapshotBoundaryOptions) => Effect<void>`    |
| `diff`     | `(snapshot: unknown, options: SnapshotBoundaryOptions) => Effect<unknown>` |

`SnapshotBoundaryOptions` carries `flow`, `executionId`, `key`, `attempt`, and
the action's `metadata`. The engine snapshots before execution, diffs after it,
and restores the earliest handle before a retry. Durable snapshot hooks skip
boundary work on journal hits; without them handles are process-local. See
[Run a compensable action](./guides/compensable-actions.md).

### Journal lineage

`Lineage` mints the journal address every durable record carries as
`meta.lineageId`: a versioned encoded tuple of the run id and the node path
from the run root.

| Export                     | Signature                             | Meaning                                         |
| -------------------------- | ------------------------------------- | ----------------------------------------------- |
| `Lineage.JournalLineageId` | `type JournalLineageId`               | An injective journal address. A branded string. |
| `Lineage.root`             | `(runId: string) => JournalLineageId` | The lineage id of a run's root node.            |

### Trampoline rounds

`Round` carries the trampoline lineage: round zero's execution id, naming the
chain of round executions one `Flow.execute` call follows across handoffs.

| Export                  | Signature                                                                                                                           | Meaning                                                                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Round.RootExecutionId` | `type RootExecutionId`                                                                                                              | Round zero's execution id, naming the trampoline lineage. A branded string.                                                                                    |
| `Round.Round`           | `interface Round { rootExecutionId: RootExecutionId; ordinal: number }`                                                             | Where one execution sits in its lineage.                                                                                                                       |
| `Round.initial`         | `(executionId: string) => Round`                                                                                                    | Ordinal zero, with the caller's execution id as the root execution id. Throws `InvalidRound` on an ill-formed id. A `JournalLineageId` does not compile.       |
| `Round.executionId`     | `(round: Round) => Effect<string, InvalidRound, Crypto>`                                                                            | The execution id a round runs under, derived from `(rootExecutionId, ordinal)` through SHA-256, so it is the same id in every process and after every restart. |
| `Round.next`            | `(round, { flowName, maxRounds }) => Effect<{ round: Round; executionId: string }, Flow.MaxRoundsExceeded \| InvalidRound, Crypto>` | The round that follows this one. Fails when the lineage has spent its budget. An absent budget is unbounded.                                                   |
| `Round.InvalidRound`    | `class InvalidRound`                                                                                                                | A malformed trampoline identity or resource bound. Fields: `code`, `message`.                                                                                  |

The budget counts rounds, so a lineage bounded at `n` may open ordinals 0
through `n - 1`. See [Trampoline rounds](./concepts/trampoline-rounds.md).

### Refusals

| Export                      | Fields                                                                         | Raised when                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `FlowNotRegistered`         | `code`, `flowName`, `message`                                                  | A flow executes, or a handoff names a target, that no registration covers.                                                                    |
| `ExecutionIdentityConflict` | `code`, `executionId`, `field`, `expected`, `actual`, `status`, `message`                | A reused execution id disagrees with persisted flow, payload, lineage, round, or parent identity, or a deferred is addressed to another flow. |
| `SuspendedResumeGaveUp`     | `code`, `flowName`, `executionId`, `attempt`, `elapsedMs`, `reason`, `message` | A caller polling a suspended lineage spends its `suspendedRetryPolicy`. `reason` is `"expired"` or `"exhausted"`.                             |
| `SnapshotBoundaryRequired`  | `code`, `actionName`, `message`                                                | A compensable action runs with no `SnapshotBoundary` in context.                                                                              |

All four are `Schema.TaggedError` classes tagged `@smthrs/engine/<Name>`, and
the engine raises them as defects. Their `code` values are
`flow_not_registered`, `execution_identity_conflict`,
`suspended_resume_gave_up`, and `snapshot_boundary_required`.

## FlowProxy

Derives RPC and HTTP definitions from flow declarations. Each flow owns four
wire operations.

| Export               | Signature                                                                                                        | Meaning                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operationAddresses` | `(tag: string, prefix?: string) => OperationAddresses`                                                           | The four wire names one flow owns: `<prefix><tag>`, `<prefix><tag>Discard`, `<prefix><tag>Resume`, `<prefix><tag>Interrupt`. Every group builder and server layer derives from this one function. |
| `OperationAddresses` | `interface { execute; discard; resume; interrupt: string }`                                                      | The derived names.                                                                                                                                                                                |
| `assertNoCollisions` | `(flows: ReadonlyArray<Flow.Any>, prefix?: string) => void`                                                      | Throws `FlowProxyCollision` when two derived operations share a wire name. Runs first inside every builder and server layer.                                                                      |
| `toRpcGroup`         | `(flows: NonEmptyReadonlyArray<Flow.Any>, options?: { prefix?: string }) => RpcGroup.RpcGroup<ConvertRpcs<...>>` | Derives an Effect `RpcGroup`. Execute and discard take the flow payload plus a required `executionId`; resume and interrupt take an execution id alone.                                           |
| `ConvertRpcs`        | `type ConvertRpcs<Flows, Prefix>`                                                                                | Maps each flow to its four derived RPC definitions.                                                                                                                                               |
| `toHttpApiGroup`     | `(name: string, flows: NonEmptyReadonlyArray<Flow.Any>) => HttpApiGroup.HttpApiGroup<Name, ConvertHttpApi<...>>` | Derives an `HttpApiGroup` with four POST endpoints per flow: the flow path, `<path>/discard`, `<path>/resume`, and `<path>/interrupt`.                                                            |
| `ConvertHttpApi`     | `type ConvertHttpApi<Flows>`                                                                                     | Maps each flow to its four derived endpoints.                                                                                                                                                     |
| `FlowProxyCollision` | Tagged error `@smthrs/engine/FlowProxyCollision`                                                                 | Fields `code` (`"flow_proxy_collision"`) and `operation`. Thrown before construction.                                                                                                             |
| `InvalidFlowTag`     | Tagged error `@smthrs/engine/InvalidFlowTag`                                                                     | Fields `code` (`"invalid_flow_tag"`) and `tag`. Thrown before HTTP construction when a tag is not well-formed UTF-16.                                                                             |

HTTP routes encode a flow tag as one opaque URL-safe segment, `flow-` followed
by the tag's UTF-16 code units in hex, which preserves case, reserved
characters, Unicode normalization, and operation identity across routers that
disagree about percent-decoding.

## Hosts

The injected table that says where a placed flow runs. A flow declares a
serializable `Flow.Placement`; the host that composes the engine binds each
placement `target` to a `Binding`. With no table, everything runs here.

| Export    | Signature                                                                                    | Meaning                                                                                                                                                      |
| --------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Binding` | `{ _tag: "Here" } \| { _tag: "Proxy"; connect: (group) => Effect<RpcClient, never, Scope> }` | `Here` runs the execution on this engine. `Proxy` runs it on another engine through that engine's served `FlowProxy` group, under the caller's execution id. |
| `Hosts`   | `Context.Reference<Service>`                                                                 | The table the engine reads when it executes, resumes, or interrupts a flow. The default runs everything here.                                                |
| `layer`   | `(table: Record<string, Binding>, fallback?: Binding) => Layer`                              | A table keyed by placement `target`. `Local` and `Client` placements, an absent placement, and an unnamed target run `fallback`, which is `Here` by default. |

The engine consults the table inside `execute`, because a flow body reaches its
children through the engine itself. A `Proxy` child keeps one leaf in the
parent's plan; the remote engine keeps the plan, the attempts, and the result.
A parent interrupted while the remote child runs sends `interrupt` to the remote
engine, which has no lineage edge to the parent; the forward is best effort, and
a failed one is logged. A lost connection is asked again under the same id for
about six minutes, and the remote engine joins the run it has or answers the
result it recorded; after that it is a defect of the execution. An answer the
client cannot read, such as a proxy's error page, is a defect at once. A serving engine's own table must run
the flows it serves here. A re-driven
parent derives the same child id and joins the same way. A discard answers the
caller's own id. Provide the table to the engine's layer, never at an `execute`
call site: a body reads the table its registration was built with.
`agent/spawn` of a `Proxy` flow is not supported: the spawner reads the child's
run row on this engine, and a remote child has none. See
[Place a child flow on another engine](./guides/place-a-child-on-another-engine.md).

## PlacedAction

Runs one action's body on the host its placement names, so a secret the body
uses lives only on that host.

| Export   | Signature                                                      | Meaning                                                                                                                                                                                                                                            |
| -------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layer`  | `(action, placement, body) => Layer`                           | Implements `action`. When `Hosts` binds `placement` here, `body` runs in this process. When it binds a `Proxy`, the holder runs `served(action)` under the action's invocation key, so a retry after a lost reply joins the holder's recorded run. |
| `served` | `(action) => Flow<"<action>/remote", Payload, Success, Error>` | The one-node flow a holder serves for `action`: the action's payload, success and error, and a body that calls it. One flow per declaration.                                                                                                       |

The holder implements `action` with its real body and serves
`FlowProxyServer.layerRpcHandlers([PlacedAction.served(action)])`. The caller
journals the call and its outcome: the success value, the declared error, or
the holder's redacted defect. The body, its environment, and any credential it
reads stay on the holder. A caller cancelled while the holder runs the body does
not cancel the holder's run. Declare retries for the holder: a caller that
retries asks again under the same key and receives the recorded outcome.
Two callers that share an execution id and payload share one holder run;
scope them with `FlowProxyServer`'s `executionId` option. Routed here on a host without the
credential, a body that reads it fails there, as `SecretUnavailable` does in
`examples/src/42-placed-deploy.ts`.

## FlowProxyServer

Binds the derived definitions to a running engine.

| Export              | Signature                                                                                                                                                                                       | Meaning                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `layerRpcHandlers`  | `(flows, options?: { prefix?: string; executionId?: ExecutionIdScope }) => Layer<RpcHandlers<...>, never, FlowRuntime \| Flow.Requirements<Flows> \| Flow.RequirementsHandler<Flows>>`          | Implements the derived RPCs. Pass the same `prefix` used to build the group.                                                       |
| `layerHttpApi`      | `(api, identifier, flows, options?: { executionId?: ExecutionIdScope }) => Layer<HttpApiGroup.Service<...>, never, FlowRuntime \| Flow.Requirements<Flows> \| Flow.RequirementsHandler<Flows>>` | Implements the derived HTTP group.                                                                                                 |
| `ExecutionIdScope`  | `(input: { flow, operation, clientValue, payload }) => string \| undefined`                                                                                                                     | Rewrites the caller-supplied execution id before it reaches the engine. Pure, called once per handler, applied to every operation. |
| `RpcHandlers`       | `type RpcHandlers<Flows, Prefix>`                                                                                                                                                               | The union of handler services required to serve the derived RPCs.                                                                  |
| `FlowHandlerDefect` | `class FlowHandlerDefect`                                                                                                                                                                       | A proxy defect containing `code`, `flowName`, bounded redacted `diagnostic`, and `message`.                                        |

Both layers drive the served bodies, so both require what those bodies require:
`Flow.Requirements` of every flow, on top of the schema services
`Flow.RequirementsHandler` names. A forgotten `Action.toLayer` is a compile
error on this side of the boundary too. The client side is unaffected: it
encodes a payload and decodes a result, and requires no implementation at all.

Both layers log a defect from a served body through `Effect.logError`,
annotated with the module and the wire operation name.

Returning `undefined` from `ExecutionIdScope` means different things per
operation: for execute and discard it selects the flow's idempotency key or ambient execution-id source; for resume and interrupt it refuses the request with a
`Flow.ExecutionIdRequired` defect, because passing the client value through would
let a client resume outside the namespace the scope confines it to. See
[Namespace execution ids per tenant](./guides/namespace-execution-ids.md).

These modules expose flow transport only. They do not ship a server, a router,
an authentication policy, or a durable engine.

## See also

- [Export reference](./reference/engine.md): every export of every namespace,
  one at a time, with field-level tables.
- [`@smthrs/flow`](/api/flow) declares `Flow`, `Action`, `RetryPolicy`, and the
  `FlowRuntime` port this package implements.
- [`@smthrs/engine-store`](/api/engine-store) supplies the durable
  implementation of the `Encoded` seam.
- [Durable execution](/docs/concepts/durable-execution/) and
  [Retries](/docs/concepts/retries/) on smithers.sh own the cross-package model.

`Flow.execute` returns identity conflicts on its typed failure channel, including
the existing execution status. The derived RPC and HTTP execute/discard error
schemas carry the same conflict value. Re-key only when `status` is
`completed`, `failed`, or `cancelled`; live and suspended executions retain
their identity.
