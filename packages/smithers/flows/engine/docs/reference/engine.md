---
title: "Export reference"
description: "Every export of @smthrs/engine one at a time: FlowEngine, FlowProxy, and FlowProxyServer, each with its full type, its defaults, and its field tables."
area: api
order: 20
---

The package implements `FlowRuntime`, the port `@smthrs/flow` declares, over a low-level `Encoded` seam, and derives RPC and HTTP transports from flow declarations.

This page is the long form: one entry per export, with the full type and every field. [API reference](../api.md) is the short tour of the same surface, grouped by what each export is for.

## Install

Install the engine beside the flow package it runs. Not on npm yet; see [Installation](/docs/installation/#use-the-libraries).

## Entry points

Each subpath in the package `exports` map resolves to one source module:

| Import                           | Source                    | Platform |
| -------------------------------- | ------------------------- | -------- |
| `@smthrs/engine`                 | `src/index.ts`            | any      |
| `@smthrs/engine/FlowEngine`      | `src/FlowEngine/index.ts` | any      |
| `@smthrs/engine/FlowProxy`       | `src/FlowProxy.ts`        | any      |
| `@smthrs/engine/FlowProxyServer` | `src/FlowProxyServer.ts`  | any      |

`./FlowEngine/*`, `./internal/*`, and `./*/index` are `null` in the `exports` map, so no deeper subpath resolves.

## Namespaces

The root re-exports three namespaces, in this order:

| Namespace         | Summary                          |
| ----------------- | -------------------------------- |
| `FlowEngine`      | Flow execution services.         |
| `FlowProxy`       | Client-side flow proxies.        |
| `FlowProxyServer` | Server-side flow proxy handling. |

## FlowEngine

### `FlowEngine.ActionExecuteOptions`

- **Type:** `interface ActionExecuteOptions`
- **Since:** `0.1.0`
- **Related:** `FlowEngine.Encoded`

The identity and boundary information an `Encoded` implementation receives for one action dispatch.

The fields:

| Field              | Type                                                      | Description                                                                                                                                                           |
| ------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`           | `Action.Any`                                              | The action declaration being dispatched.                                                                                                                              |
| `attempt`          | `number`                                                  | The attempt number, starting at `1`. A value above `1` marks a retry.                                                                                                 |
| `key`              | `string`                                                  | The persisted step identity the attempt is recorded under.                                                                                                            |
| `tier`             | `Action.Tier`                                             | The action's durability tier, copied from the declaration.                                                                                                            |
| `nondeterministic` | `true \| undefined`                                       | Optional. Present when a cache put race may retain the first row without failing the run.                                                                             |
| `metadata`         | `unknown`                                                 | The action declaration's metadata, passed through unread.                                                                                                             |
| `snapshot`         | optional `Effect<unknown, never, FlowInstance \| Crypto>` | Supplied only when the driver implements `actionSnapshot`. Evaluate and persist the handle before actual execution, after journal lookup and in-flight deduplication. |

### `FlowEngine.Encoded`

- **Type:** `interface Encoded`
- **Since:** `0.1.0`
- **Related:** `FlowEngine.makeUnsafe`, `FlowEngine.ActionExecuteOptions`

The low-level flow engine contract a durable store implements. A store implements this interface, never the typed `FlowRuntime` port directly. The name is narrower than it looks: only some members carry encoded values. An implementation that encodes the rest produces a silently wrong system. Those members are typed `Flow.Result<unknown, unknown>`, and nothing decodes them on the way out.

The members and the value each one carries across the seam:

| Member                  | Optional | Value crossing the seam                                                                                                                    |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `register`              | no       | None.                                                                                                                                      |
| `execute`               | no       | A decoded `Flow.Result`, which the implementation decodes through `Flow.Result({ success: flow.successSchema, error: flow.errorSchema })`. |
| `poll`                  | no       | A decoded `Flow.Result`, decoded the same way.                                                                                             |
| `interrupt`             | no       | None.                                                                                                                                      |
| `interruptUnsafe`       | no       | None.                                                                                                                                      |
| `resume`                | no       | None.                                                                                                                                      |
| `resumeSignal`          | yes      | None.                                                                                                                                      |
| `actionExecute`         | no       | Encoded. `makeUnsafe` decodes it through the action's `exitSchemaPartial`.                                                                 |
| `actionReplayKey`       | yes      | None.                                                                                                                                      |
| `actionRetryOrigin`     | yes      | None.                                                                                                                                      |
| `actionLatestAttempt`   | yes      | None.                                                                                                                                      |
| `actionSnapshot`        | yes      | None.                                                                                                                                      |
| `deferredResult`        | no       | Encoded. `makeUnsafe` decodes it through the deferred's `exitSchema`.                                                                      |
| `deferredDone`          | no       | Encoded. `makeUnsafe` encodes the exit before the call.                                                                                    |
| `deferredDoneIfWaiting` | yes      | Encoded, encoded before the call the same way.                                                                                             |
| `scheduleClock`         | no       | None.                                                                                                                                      |
| `nodeRecordBytes`       | yes      | None.                                                                                                                                      |
| `recordNode`            | yes      | None.                                                                                                                                      |

`executionId` on `execute` is caller-supplied identity. A repeated id joins the run that already owns it, which is what makes a retried submission idempotent. `round` on `execute` is required: `makeUnsafe` supplies round zero for a fresh execution and the advanced round after a handoff, with `previousExecutionId` naming the round it continues. `poll` answers `Option.none` for a known unsettled execution, and for an execution that belongs to a different flow declaration. Only an execution id no engine knows fails, with `FlowRuntime.FlowExecutionNotFound`. `interrupt`, `interruptUnsafe`, and `resume` treat an unknown execution id as a silent no-op.

`recordNode` takes the records a driven graph makes about itself: the plan it was built from, and every node it scheduled and settled. It is optional because a store that keeps no history has nothing to record and skips journal preflight; a recording store can refuse oversized topology before the walk starts. A store that implements it MUST address the entry by the `sourceId` the record carries, never a minted one: a resumed walk re-derives the same ids, and that is what makes a journal keyed by `(run, source, sequence)` hold one row per node across a resume instead of one per observation.

`nodeRecordBytes` measures the complete encoded UTF-8 journal envelope before the
interpreter pages the graph. It must reserve allocated sequence/time fields
deterministically, so a resume keeps exactly the same page identities. The
interpreter refuses a node that cannot fit alone before recording any page.

`actionRetryOrigin` returns the persisted start time of the first surviving attempt for `key`, so a `RetryPolicy.expirationMs` bound survives park, resume, and process death. `Option.none()` means no attempt row survives, and the engine then falls back to the current clock and logs a warning. `actionLatestAttempt` returns the highest persisted attempt number for `key`, so the attempt counter resumes from the persisted sequence rather than from `1`.

`actionSnapshot` returns the earliest persisted pre-attempt handle for a compensable key. A present handle may itself be null or undefined. Keep it across unfinished attempts and process restarts. The associated `ActionExecuteOptions.snapshot` effect must run only for actual execution, never for a journal hit or joined dispatch.

### `FlowEngine.SuspendedResumeGaveUp`

- **Type:** `class SuspendedResumeGaveUp extends Schema.TaggedError<SuspendedResumeGaveUp>()("@smthrs/engine/SuspendedResumeGaveUp", { code, flowName, executionId, attempt, elapsedMs, reason, message })`
- **Since:** `1.0.0`

The refusal a suspended execution raises when it spends the caller's resume retry policy. `reason` is `"expired"` when only the elapsed-time bound closed the window, and `"exhausted"` when the attempt count ran out. `makeUnsafe` raises it as a defect through `Effect.die`.

### `FlowEngine.SnapshotBoundaryRequired`

- **Type:** `class SnapshotBoundaryRequired extends Schema.TaggedError<SnapshotBoundaryRequired>()("@smthrs/engine/SnapshotBoundaryRequired", { code, actionName, message })`
- **Since:** `1.0.0`
- **Related:** `FlowEngine.SnapshotBoundary`

The refusal a compensable action raises when it is admitted with no snapshot boundary in context. `makeUnsafe` raises it as a defect through `Effect.die`.

### `FlowEngine.FlowNotRegistered`

- **Type:** `class FlowNotRegistered extends Schema.TaggedError<FlowNotRegistered>()("@smthrs/engine/FlowNotRegistered", { code, flowName, message })`
- **Since:** `1.0.0`

The refusal raised when a flow operation names a declaration this engine has not registered. Both `layerMemory` on `execute` and `makeUnsafe` on an unresolvable handoff target raise it as a defect.

### `FlowEngine.ExecutionIdentityConflict`

- **Type:** `class ExecutionIdentityConflict extends Schema.TaggedError<ExecutionIdentityConflict>()("@smthrs/engine/ExecutionIdentityConflict", { code, executionId, field, expected, actual, status, message })`
- **Since:** `1.0.0`

The refusal raised when a caller reuses an execution id for different persisted run identity. `field` is `"flow"`, `"payload"`, `"lineage"`, `"round"`, or `"parent"`. Answering would attach the caller to a run or trampoline round it did not name. `layerMemory` raises it as a defect on `execute` and on a `deferredDone` addressed to the wrong flow; the durable driver also raises it when an existing run row disagrees with the requested flow, encoded payload, lineage, round, or predecessor.

### `FlowEngine.makeInstance`

- **Signature:** `makeInstance(flow: Flow.Any, executionId: string): FlowRuntime.FlowInstance["Service"] & { readonly lineageId: JournalLineageId }`
- **Since:** `0.1.0`

Creates the initial `FlowInstance` state for one flow execution. A runtime calls it when it starts a flow run, or restarts one on resume. The state it returns is what suspension, interruption, and action coordination are tracked in. The instance's `lineageId` is the run's own root journal lineage, because a subflow is a separate run with a separate journal. It keeps its `JournalLineageId` brand, so it cannot pass for a trampoline root execution id. Action ordinals are counted per allocation scope, so a permuted fiber interleaving cannot renumber distinguishable dispatches across a replay.

### `FlowEngine.layerMemory`

- **Type:** `Layer.Layer<FlowRuntime.FlowRuntime>`
- **Since:** `0.1.0`
- **Related:** `FlowEngine.makeUnsafe`

The volatile in-memory implementation of the `FlowRuntime` port, for tests and local development where durability is not needed. It retains completed executions, action settlements, deferred results, and clocks until the layer scope closes, and it has no eviction option. It rebuilds a submitted payload through the flow's own payload schema constructor at admission and again on every re-drive: structs, arrays, and records the schema declares are copied, and values the schema declares opaque are shared by reference. Same-key in-flight actions share one settlement, so a concurrent duplicate dispatch waits instead of executing twice. Registrations of one flow tag stack, and the last still-open one serves.

### `FlowEngine.Lineage`

- **Type:** `namespace Lineage`
- **Since:** `0.1.0`
- **Related:** `FlowEngine.Round`

The journal lineage identity every durable record a run writes carries as `meta.lineageId`. A journal lineage id is a versioned encoded tuple of the run id and the node-id path from the run root. It is a different identity from the trampoline lineage `FlowEngine.Round` carries as `rootExecutionId`, which is a bare execution id. A value from one space is not an address in the other, and each space carries its own brand so the compiler refuses a swap.

#### `FlowEngine.Lineage.JournalLineageId`

- **Type:** `type JournalLineageId = string & { readonly [JournalLineageIdTypeId]: typeof JournalLineageIdTypeId }`
- **Since:** `1.0.0`

An injective journal address minted from one run and node path. `JournalLineageIdTypeId` is a declared unique symbol with no runtime value, so the brand exists only in the type.

#### `FlowEngine.Lineage.root`

- **Signature:** `root(runId: string): JournalLineageId`
- **Since:** `0.1.0`

Returns the lineage id of a run's root node. `FlowEngine.makeInstance` calls it for every instance it builds. No engine node contributes a path segment today, so the namespace exports no path constructor.

### `FlowEngine.makeUnsafe`

- **Signature:** `makeUnsafe(options: Encoded): FlowRuntime.FlowRuntime["Service"]`
- **Since:** `0.1.0`
- **Related:** `FlowEngine.Encoded`, `FlowEngine.layerMemory`

Builds a typed `FlowRuntime` service from a low-level encoded implementation. The name carries the `Unsafe` suffix because the implementation must persist, resume, and encode flow state correctly; nothing checks that it does.

The returned service follows a trampoline for the caller: one `execute` answers with the lineage's value, and each round keeps its own execution id and journal underneath. `maxRounds` belongs to the lineage originator, so a multi-flow handoff cannot reset the budget by naming a target with a different declaration. `execute` accepts an optional `suspendedRetryPolicy` and falls back to `RetryPolicy.defaultRetryPolicy`; that policy caps how long the caller keeps polling a suspended execution.

### `FlowEngine.Round`

- **Type:** `namespace Round`
- **Since:** `0.1.0`
- **Related:** `FlowEngine.Lineage`

The trampoline round identity one lineage of executions is chained by. Every round is its own execution with its own journal, and the lineage is the unit a UI, a budget, and time travel attach to. Round 0 is the execution the caller asked for, and its id is also the root execution id every later round derives from.

#### `FlowEngine.Round.RootExecutionId`

- **Type:** `type RootExecutionId = string & { readonly [RootExecutionIdTypeId]: typeof RootExecutionIdTypeId }`
- **Since:** `1.0.0`

Round zero's execution id, which names the trampoline lineage. `Round.initial` mints one from an execution id, and a store rehydrates one from the id it persisted. `RootExecutionIdTypeId` is a declared unique symbol with no runtime value, so the brand exists only in the type.

#### `FlowEngine.Round.Round`

- **Type:** `interface Round { readonly rootExecutionId: RootExecutionId; readonly ordinal: number }`
- **Since:** `0.1.0`

The position of one execution in its lineage: the root execution id the lineage derives from, and which round of it this is, counted from zero.

#### `FlowEngine.Round.InvalidRound`

- **Type:** `class InvalidRound extends Schema.TaggedError<InvalidRound>()("@smthrs/engine/InvalidRound", { code, message })`
- **Since:** `1.0.0`

The refusal raised for a malformed trampoline identity or resource bound. A `rootExecutionId` must be non-empty well-formed UTF-16, and an `ordinal` must be a non-negative safe integer.

#### `FlowEngine.Round.initial`

- **Signature:** `initial<Id extends string>(executionId: Id extends JournalLineageId ? never : Id): Round`
- **Since:** `0.1.0`

Returns the round a lineage starts at: ordinal zero, under the caller's execution id. A `JournalLineageId` argument does not compile, because a journal address is not an execution id. It throws `InvalidRound` synchronously when `executionId` is empty or ill-formed UTF-16, including a trailing unpaired high surrogate.

#### `FlowEngine.Round.executionId`

- **Signature:** `executionId(round: Round): Effect.Effect<string, InvalidRound, Crypto.Crypto>`
- **Since:** `0.1.0`

Returns `rootExecutionId` unchanged for ordinal zero after validation, so `executionId(initial(id))` returns `id`. For later rounds, derives the execution id from `(rootExecutionId, ordinal)` alone through the injected SHA-256. It is therefore the same id in every process and after every restart, which is what makes a handoff at-most-once. The preimage is `["flow-round/v2", rootExecutionId, ordinal]`, and it is part of the package's durable contract: a lineage opened under one release derives the same round ids under the next.

#### `FlowEngine.Round.next`

- **Signature:** `next(round: Round, options: { readonly flowName: string; readonly maxRounds: number \| undefined }): Effect.Effect<{ readonly round: Round; readonly executionId: string }, Flow.MaxRoundsExceeded \| InvalidRound, Crypto.Crypto>`
- **Since:** `0.1.0`

Advances a round and derives the execution id the next one runs under. The budget counts rounds, not handoffs: a lineage bounded at `n` may open ordinals `0` through `n - 1`, and the request for ordinal `n` fails with `Flow.MaxRoundsExceeded`. An absent `maxRounds` is unbounded. A `maxRounds` that is not a positive safe integer, and an ordinal already at `Number.MAX_SAFE_INTEGER`, fail with `InvalidRound`.

### `FlowEngine.SnapshotBoundaryOptions`

- **Type:** `interface SnapshotBoundaryOptions { readonly flow: Flow.Any; readonly executionId: string; readonly key: string; readonly attempt: number; readonly metadata: unknown }`
- **Since:** `0.1.0`
- **Related:** `FlowEngine.SnapshotBoundary`

The context a compensable action snapshot boundary receives for one dispatch.

### `FlowEngine.SnapshotBoundary`

- **Type:** `class SnapshotBoundary extends Context.Service<SnapshotBoundary, { readonly snapshot: (options: SnapshotBoundaryOptions) => Effect.Effect<unknown>; readonly restore: (snapshot: unknown, options: SnapshotBoundaryOptions) => Effect.Effect<void>; readonly diff: (snapshot: unknown, options: SnapshotBoundaryOptions) => Effect.Effect<unknown> }>()("@smthrs/engine/FlowEngine/SnapshotBoundary")`
- **Since:** `0.1.0`
- **Related:** `FlowEngine.SnapshotBoundaryRequired`

The minimal host snapshot boundary compensable actions execute against. The engine restores the earliest handle before a retry. With `actionSnapshot`, an unfinished first attempt also restores its persisted handle, and journal hits perform no boundary work. Without that hook, handles are process-local and replay still snapshots and diffs. `diff` runs in an ensuring finalizer for every captured attempt. A compensable action dispatched with this service absent dies with `SnapshotBoundaryRequired`.

## FlowProxy

### `FlowProxy.FlowProxyCollision`

- **Type:** `class FlowProxyCollision extends Schema.TaggedError<FlowProxyCollision>()("@smthrs/engine/FlowProxyCollision", { operation })`
- **Since:** `1.0.0`
- **Related:** `FlowProxy.assertNoCollisions`

The refusal thrown before proxy construction when two flow operations share one wire name. `code` is `"flow_proxy_collision"`, `name` is `"FlowProxyCollision"`, and `operation` is the duplicated name. The message template is `` `Flow proxy operation ${JSON.stringify(operation)} is not unique` ``.

### `FlowProxy.InvalidFlowTag`

- **Type:** `class InvalidFlowTag extends Schema.TaggedError<InvalidFlowTag>()("@smthrs/engine/InvalidFlowTag", { tag })`
- **Since:** `1.0.0`
- **Related:** `FlowProxy.toHttpApiGroup`

The refusal thrown before HTTP proxy construction when a flow tag is ill-formed UTF-16, so it has no route encoding. `code` is `"invalid_flow_tag"`, `name` is `"InvalidFlowTag"`, and `tag` is the offending tag. Only the HTTP path validates the tag, because only it encodes one into a URL segment.

### `FlowProxy.OperationAddresses`

- **Type:** `interface OperationAddresses { readonly execute: string; readonly discard: string; readonly resume: string }`
- **Since:** `1.0.0`

The three wire operation names one flow owns.

### `FlowProxy.operationAddresses`

- **Signature:** `operationAddresses(tag: string, prefix = ""): OperationAddresses`
- **Default:** `prefix` is `""`.
- **Since:** `1.0.0`

Derives the operation names shared by proxy definitions and server handlers. The names are `` `${prefix}${tag}` ``, `` `${prefix}${tag}Discard` ``, and `` `${prefix}${tag}Resume` ``. Every group builder and server layer in the package derives from this function, so the client and server sides cannot disagree on a name.

### `FlowProxy.assertNoCollisions`

- **Signature:** `assertNoCollisions(flows: ReadonlyArray<Flow.Any>, prefix = ""): void`
- **Default:** `prefix` is `""`.
- **Since:** `1.0.0`
- **Related:** `FlowProxy.FlowProxyCollision`

Refuses a flow set whose generated operation names are ambiguous. It throws `FlowProxyCollision` on the first duplicate, which includes a suffix collision such as a flow named `Review` beside one named `ReviewDiscard`. `toRpcGroup`, `toHttpApiGroup`, `layerHttpApi`, and `layerRpcHandlers` all call it before they build anything.

### `FlowProxy.toRpcGroup`

- **Signature:** `toRpcGroup<const Flows extends NonEmptyReadonlyArray<Flow.Any>, const Prefix extends string = "">(flows: Flows, options?: { readonly prefix?: Prefix \| undefined }): RpcGroup.RpcGroup<ConvertRpcs<Flows[number], Prefix>>`
- **Default:** `options.prefix` is `""`.
- **Since:** `0.1.0`
- **Related:** `FlowProxyServer.layerRpcHandlers`, `FlowProxy.ConvertRpcs`

Derives an `RpcGroup` from a list of flows, giving every flow execute, discard, and resume operations. The execute RPC carries the flow's `successSchema` and `errorSchema`; the discard and resume RPCs carry neither. Each RPC merges the flow's own annotations.

### `FlowProxy.ConvertRpcs`

- **Type:** ``type ConvertRpcs<Flows extends Flow.Any, Prefix extends string> = Flows extends Flow.Flow<infer _Name, infer _Payload, infer _Success, infer _Error, infer _Requires> ? Rpc.Rpc<`${Prefix}${_Name}`, ExecutePayload<_Payload>, _Success, _Error> | Rpc.Rpc<`${Prefix}${_Name}Discard`, ExecutePayload<_Payload>> | Rpc.Rpc<`${Prefix}${_Name}Resume`, typeof ResumePayload> : never``
- **Since:** `0.1.0`

The RPC definitions generated for one flow's execute, discard, and resume operations. The internal payload schemas require `executionId` to contain 1 to 4,096 well-formed UTF-16 code units; execute and discard also carry the flow payload.

### `FlowProxy.toHttpApiGroup`

- **Signature:** `toHttpApiGroup<const Name extends string, const Flows extends NonEmptyReadonlyArray<Flow.Any>>(name: Name, flows: Flows): HttpApiGroup.HttpApiGroup<Name, ConvertHttpApi<Flows[number]>>`
- **Since:** `0.1.0`
- **Related:** `FlowProxyServer.layerHttpApi`, `FlowProxy.ConvertHttpApi`

Derives an `HttpApiGroup` from a list of flows. Each flow gets three POST endpoints, at `/<encoded tag>`, `/<encoded tag>/discard`, and `/<encoded tag>/resume`. The tag encoding is the literal `flow-` followed by each UTF-16 code unit of the tag as four lowercase hex digits. One flow is therefore one URL-safe segment that preserves case, reserved characters, and Unicode normalization. This function takes no `prefix`, unlike `toRpcGroup`.

### `FlowProxy.ConvertHttpApi`

- **Type:** ``type ConvertHttpApi<Flows extends Flow.Any> = Flows extends Flow.Flow<infer _Name, infer _Payload, infer _Success, infer _Error, infer _Requires> ? HttpApiEndpoint.HttpApiEndpoint<_Name, "POST", `/${string}`, never, never, ExecutePayload<_Payload>, never, _Success, _Error> | HttpApiEndpoint.HttpApiEndpoint<`${_Name}Discard`, "POST", `/${string}/discard`, never, never, ExecutePayload<_Payload>> | HttpApiEndpoint.HttpApiEndpoint<`${_Name}Resume`, "POST", `/${string}/resume`, never, never, typeof ResumePayload> : never``
- **Since:** `0.1.0`

The HTTP endpoints generated for one flow's execute, discard, and resume operations. The path is typed as `` `/${string}` `` because the concrete segment is derived from the flow tag at run time.

## FlowProxyServer

### `FlowProxyServer.FlowHandlerDefect`

- **Type:** `class FlowHandlerDefect extends Schema.TaggedError<FlowHandlerDefect>()("@smthrs/engine/FlowHandlerDefect", { code, flowName, diagnostic, message })`
- **Since:** `1.0.0`

A defect leaving a proxy handler is replaced with this refusal. `code` is `"flow_handler_defect"`; `diagnostic` is bounded and redacted, including sensitive fields with object or array values. The guard also covers synchronous identity callback failures.

### `FlowProxyServer.ExecutionIdScope`

- **Type:** `interface ExecutionIdScope { (input: { readonly flow: Flow.Any; readonly operation: "execute" \| "discard" \| "resume"; readonly clientValue: string \| undefined; readonly payload: unknown }): string \| undefined }`
- **Since:** `1.0.0`

The hook that rewrites a caller-supplied execution id before it reaches the engine, so a multi-tenant server namespaces client identity in one place. The server calls it once inside each execute, discard, or resume handler. Execute and discard inputs include the decoded flow payload; resume inputs use `undefined`, because a resume request carries only an execution id. Returning `undefined` for execute or discard selects the flow's idempotency key or ambient execution-id source. Returning `undefined` for resume refuses the request with a `Flow.ExecutionIdRequired` defect, because passing the client value through would let a client resume across the namespace the scope confines it to. Without the option, every client value passes through unchanged. An implementation must be pure, must return for every input, and must return a string for every resume, and it receives no request-scoped service.

### `FlowProxyServer.layerHttpApi`

- **Signature:** `layerHttpApi<ApiId extends string, Groups extends HttpApiGroup.Constraint, Identifier extends HttpApiGroup.Identifier<Groups>, const Flows extends NonEmptyReadonlyArray<Flow.Any>>(api: HttpApi.HttpApi<ApiId, Groups>, identifier: Identifier, flows: Flows, options?: { readonly executionId?: ExecutionIdScope }): Layer.Layer<HttpApiGroup.Service<ApiId, Identifier>, never, FlowRuntime.FlowRuntime \| Flow.Requirements<Flows[number]> \| Flow.RequirementsHandler<Flows[number]>>`
- **Since:** `0.1.0`
- **Related:** `FlowProxy.toHttpApiGroup`, `FlowProxyServer.ExecutionIdScope`

Creates handlers for a flow HTTP API group, wiring execute, discard, and resume endpoints to the supplied flows. The layer drives the served bodies, so it requires what those bodies require: `Flow.Requirements` of every flow, on top of the schema services `Flow.RequirementsHandler` names. A forgotten `Action.toLayer` is a compile error here. Each handler logs a defect from a served body through `Effect.logError`, annotated with `module: "FlowProxyServer"` and the wire operation name.

### `FlowProxyServer.layerRpcHandlers`

- **Signature:** `layerRpcHandlers<const Flows extends NonEmptyReadonlyArray<Flow.Any>, const Prefix extends string = "">(flows: Flows, options?: { readonly prefix?: Prefix; readonly executionId?: ExecutionIdScope }): Layer.Layer<RpcHandlers<Flows[number], Prefix>, never, FlowRuntime.FlowRuntime \| Flow.Requirements<Flows[number]> \| Flow.RequirementsHandler<Flows[number]>>`
- **Default:** `options.prefix` is `""`.
- **Since:** `0.1.0`
- **Related:** `FlowProxy.toRpcGroup`, `FlowProxyServer.ExecutionIdScope`

Creates RPC handlers for the supplied flows, wiring execute, discard, and resume RPCs to flow operations. Pass the same `prefix` given to `FlowProxy.toRpcGroup`, because the handler keys are derived from it. The requirements and the defect logging match `layerHttpApi`.

### `FlowProxyServer.RpcHandlers`

- **Type:** ``type RpcHandlers<Flows extends Flow.Any, Prefix extends string> = Flows extends Flow.Flow<infer _Name, infer _Payload, infer _Success, infer _Error, infer _Requires> ? Rpc.Handler<`${Prefix}${_Name}`> | Rpc.Handler<`${Prefix}${_Name}Discard`> | Rpc.Handler<`${Prefix}${_Name}Resume`> : never``
- **Since:** `0.1.0`

The union of RPC handler services required to serve one flow's generated execute, discard, and resume RPCs.

## Errors

The package defines eight coded refusals, six as `Schema.TaggedError` values raised as defects and two as `Error` subclasses thrown before proxy construction:

| Tag                                        | Raised when                                                                                                                           | Fields                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `@smthrs/engine/SuspendedResumeGaveUp`     | A caller polling a suspended execution spends its `suspendedRetryPolicy`, by elapsed time or by attempt count.                        | `code`, `flowName`, `executionId`, `attempt`, `elapsedMs`, `reason`, `message` |
| `@smthrs/engine/SnapshotBoundaryRequired`  | A compensable action dispatches with no `SnapshotBoundary` in context.                                                                | `code`, `actionName`, `message`                                                |
| `@smthrs/engine/FlowNotRegistered`         | A flow executes, or a handoff names a target, that this engine holds no registration for.                                             | `code`, `flowName`, `message`                                                  |
| `@smthrs/engine/ExecutionIdentityConflict` | A reused execution id names a different flow declaration, arrives with a different payload, or completes a deferred for another flow. | `code`, `executionId`, `field`, `expected`, `actual`, `message`                |
| `@smthrs/engine/InvalidRound`              | A round carries a malformed lineage id or ordinal, or `Round.next` receives a `maxRounds` that is not a positive safe integer.        | `code`, `message`                                                              |
| `@smthrs/engine/FlowHandlerDefect`         | A proxy handler dies; the raw defect is replaced by a bounded redacted diagnostic.                                                    | `code`, `flowName`, `diagnostic`, `message`                                    |
| `FlowProxyCollision`                       | Two operations derived from a flow set share one wire name.                                                                           | `code`, `operation`, `message`                                                 |
| `InvalidFlowTag`                           | `FlowProxy.toHttpApiGroup` encodes a route for a flow tag that is not well-formed UTF-16.                                             | `code`, `tag`, `message`                                                       |

The six tagged errors declare `code` as a `Schema.Literal` with a constructor default, and the two `Error` subclasses declare it as a readonly field. The codes, in table order, are `suspended_resume_gave_up`, `snapshot_boundary_required`, `flow_not_registered`, `execution_identity_conflict`, `invalid_round`, `flow_handler_defect`, `flow_proxy_collision`, and `invalid_flow_tag`. The engine also propagates refusals defined in `@smthrs/flow`, including round-budget, action-identity, irreversible-retry, missing-execution-id, cancellation, and execution-cycle errors.

## Example

This program runs one flow on the in-memory engine, with the action implementation and the interpreter layered under it:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const Compile = Action.make("deploy/Compile", {
  payload: { target: Schema.String },
  success: Schema.String,
  tier: "sealed"
})

const Build = Flow.make("deploy/Build", {
  payload: { target: Schema.String },
  success: Schema.String,
  body: (payload) => Compile.call(payload)
})

// layerMemory is the volatile implementation of the FlowRuntime port.
const layer = Layer.mergeAll(
  Compile.toLayer(({ target }) => Effect.succeed(`${target}.js`)),
  Interpreter.layer(Build)
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer)
)

// A repeated executionId joins the run that already owns it.
const program: Effect.Effect<string> = Build.execute(
  { target: "deploy/status" },
  { executionId: "deploy-status-1" }
).pipe(Effect.provide(layer), Effect.orDie)
```

## See also

- [API reference](../api.md) covers the same exports grouped by purpose, with the design notes each group needs.
- [`@smthrs/flow`](/api/flow) declares `Flow`, `Action`, `RetryPolicy`, and the `FlowRuntime` port this package implements.
- [`@smthrs/engine-store`](/api/engine-store) supplies the durable implementation of the `Encoded` seam.
- [Durable execution](/docs/concepts/durable-execution/) and [Retries](/docs/concepts/retries/) on smithers.sh own the cross-package journal, replay, and attempt-numbering model.
