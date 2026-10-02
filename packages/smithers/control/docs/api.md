---
title: "API reference"
description: "Every public export of @smthrs/control, module by module: the Control service and its ten operations, the wire schemas, the typed failures, the three ports, the RPC boundary, the projections, and the credential surface."
---

Every module is importable from the root entry point as a namespace and from
its own subpath:

```ts
import { Control, ControlLive, Monitor } from "@smthrs/control"
import * as ControlSchema from "@smthrs/control/ControlSchema"
```

`@smthrs/control/internal/*`, `@smthrs/control/migrations/*`, and every nested
`*/index` are blocked in the export map. `@smthrs/control/package.json` is
exported, and so is `@smthrs/control/test/TestControl`.

Signatures in this reference use the usual shorthand: `Effect<A, E, R>` for
`Effect.Effect`, `Stream<A, E>` for `Stream.Stream`, `Layer<A, E, R>` for
`Layer.Layer`, and `Redacted<A>` for `Redacted.Redacted`.

## Example

```ts
import { Control } from "@smthrs/control/Control"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const control = yield* Control
  const card = yield* control.plan({ flowId: "quickstart/Deploy", input: { build: "v1.4.0" } })
  yield* control.approve(card.approval)
  return yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: "deploy:v1.4.0"
  })
})
```

## Control

The transport-independent control vtable. Every implementation in this package
and every client projects onto this one interface. Each operation includes
`TransportError` and `Unauthorized` in its error channel for remote transport
and authentication failures.

| Export      | Kind      | Signature                                                                                                                                              |
| ----------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Control`   | class     | `Context.Service<Control, Service>` at key `/control/Control`                                                                                          |
| `Service`   | interface | The ten operations in the following table                                                                                                              |
| `make`      | function  | `(implementation: Service) => Service`                                                                                                                 |
| `layerNoop` | layer     | `Layer<Control>`. Every operation fails `Unavailable`, naming the verb as `feature` and the constant `control-runtime-engine-integration` as `ticket`. |

### Service

| Operation | Signature                                                                                                                                                                                                                                     | Returns                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `plan`    | `(input: PlanInput) => Effect<PlanCard, FlowNotFound \| InvalidInput \| PersistenceError \| Unavailable \| TransportError \| Unauthorized>`                                                                                                   | The reviewable card, whether or not this call created it.                                            |
| `run`     | `(input: RunInput) => Effect<Receipt, RunNotFound \| PlanNotFound \| PlanDenied \| PlanDigestMismatch \| EnvelopeMismatch \| ClaimLost \| InvalidInput \| LaunchFailed \| PersistenceError \| Unavailable \| TransportError \| Unauthorized>` | `Accepted`, `AlreadyApplied`, `Conflict`, or `Parked` for a plan; a resume answers as `resume` does. |
| `approve` | `(input: ApprovalInput) => Effect<Receipt, PlanDigestMismatch \| EnvelopeMismatch \| AlreadyResolved \| PlanNotFound \| RunNotFound \| InvalidInput \| PersistenceError \| Unavailable \| TransportError \| Unauthorized>`                    | `Accepted`, `AlreadyApplied`, `Conflict`, or `Terminal`.                                             |
| `deny`    | same as `approve`                                                                                                                                                                                                                             | same as `approve`.                                                                                   |
| `steer`   | `(input: SteerInput) => Effect<Receipt, NotificationError \| RunNotFound \| InvalidInput \| PersistenceError \| Unavailable \| TransportError \| Unauthorized>`                                                                               | `Accepted`, `AlreadyApplied`, `Conflict`, or `Terminal`.                                             |
| `signal`  | `(input: SignalInput) => Effect<Receipt, RunNotFound \| NoMatchingWait \| InvalidInput \| PersistenceError \| Unavailable \| TransportError \| Unauthorized>`                                                                                 | `Accepted`, `AlreadyApplied`, `Conflict`, or `Terminal`.                                             |
| `cancel`  | `(input: RunMutationInput) => Effect<Receipt, RunNotFound \| ClaimLost \| InvalidInput \| PersistenceError \| Unavailable \| TransportError \| Unauthorized>`                                                                                 | `Accepted` or `Terminal`. Never replays its recorded receipt.                                        |
| `resume`  | same as `cancel`                                                                                                                                                                                                                              | `Accepted`, `AlreadyApplied`, `Conflict`, or `Terminal`.                                             |
| `list`    | `(input: ListRequest) => Effect<ListResponse, ControlError>`                                                                                                                                                                                  | A bounded page of flows, runs, triggers, or trigger fires.                                           |
| `watch`   | `(filter: WatchFilter) => Stream<ControlEvent, ControlError>`                                                                                                                                                                                 | Committed journal entries, plus the deltas the plane derives.                                        |

There is no `pause`. An operator park is written through
`ControlRuntime.writeStatus(runId, fence, "parked")`.

### Inputs

| Type               | Shape                                                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PlanInput`        | `{ flowId: FlowId; input: unknown; idempotencyKey?: IdempotencyKey }`. `input` is `unknown` so the runtime can decode its own flow's schema before anything crosses a transport.        |
| `RunInput`         | `ControlSchema.RunInputSchema.Type & { principal?: Principal }`, so either `{ _tag: "Plan", planId, digest, envelope, idempotencyKey }` or `{ _tag: "Resume", runId, idempotencyKey }`. |
| `ApprovalInput`    | `ApprovalPayload & { principal?: Principal }`: `{ target, scope, idempotencyKey }`.                                                                                                     |
| `SteerInput`       | `{ runId: RunId; message: SteerMessage; idempotencyKey: IdempotencyKey }`.                                                                                                              |
| `SignalInput`      | `{ runId: RunId; signal: SignalPayload; idempotencyKey: IdempotencyKey; principal?: Principal }`.                                                                                       |
| `RunMutationInput` | `{ runId: RunId; idempotencyKey: IdempotencyKey; reason?: string; principal?: Principal }`. `reason` is recorded on the journal entry the mutation writes.                              |

`ApprovalTarget` is re-exported from `ControlSchema` for convenience.

`principal` is present on the local contracts because a runtime stamps it. The
RPC schemas that exclude it do so on purpose: an authenticated server names the
identity, and a remote client cannot claim another.

## ControlSchema

The serializable values both halves of the wire decode. Every entry has a
schema constant and a type of the same name unless noted.

### Identifiers and identity

| Export                              | Shape                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `RunId`, `FlowId`, `IdempotencyKey` | `Schema.String` aliases that name what a string is.                                 |
| `Principal`                         | `{ id: string; kind: string; stampedAt: number }`. Stamped at the control boundary. |

### Authority

| Export            | Shape                                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Envelope`        | `{ capabilities: string[]; flows: string[]; budget: { tokens?: number; milliseconds?: number; usd?: number; onExceeded?: BudgetOnExceeded }; host?: string }`. |
| `GrantScope`      | `"once" \| "run" \| "remembered"`.                                                                                                                             |
| `ApprovalTarget`  | `{ _tag: "Plan", planId, digest, envelope }` or `{ _tag: "Node", runId, requestId, digest, envelope }`.                                                        |
| `ApprovalPayload` | `{ target: ApprovalTarget; scope: GrantScope; idempotencyKey: IdempotencyKey }`.                                                                               |

### Plans

| Export           | Shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PlanNodeStatus` | `"cached" \| "run"`. The two outcomes a step key already decides: reuse the cached result, or run the step. A card reports nothing else.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `PlanNode`       | The persisted plan node's fields plus `status`. `key` is the step key [`@smthrs/plan`](/api/plan) compiled, so a node named here and a node in the persisted plan are the same node.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PlanCard`       | `{ planId, flowId, digest, inputSummary, warnings?: DiscoveryWarning[], envelope, deployClass, executionDigest?, plan?, nodes, graph?, approval }`. `approval` is the complete payload a reviewer resubmits unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `PlanEdgeReason` | `"value" \| "continuation" \| "failure" \| "conflict" \| "lane-merge"`. Why one node waits for another, in the vocabulary of whichever graph builder the host planned with.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PlanEdge`       | `{ from, to, reason: PlanEdgeReason }`. One labelled edge of the graph the plan was built from.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `PlanGraphNode`  | `{ id, declaredAt?: { path, line } }`. Where one node was declared, repo-relative under `@smthrs/journal`'s own rule, which refuses an absolute path. A host that cannot make a path relative to its root omits it.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PlanGraph`      | `{ edges: PlanEdge[], nodes?: PlanGraphNode[], sourceRevision?: string }`. A `PlanNode` carries `dependsOn`, one unlabelled edge set that cannot tell a value dependency from a recovery arm or from an ordering edge a write conflict added; a host that graphs a flow reports the reasons here instead, and the declaration sites the key material deliberately does not carry. `sourceRevision` is the immutable name of the tree those sites were read out of: a jj working-copy commit id, or a git commit for a tree that still matches one, so a reader can ask for the file AT that revision instead of whatever is on disk now. A host that cannot name one omits it. |

`graph` sits deliberately OUTSIDE the digest an approval binds to. The edges
and the declaration sites describe the plan a reader draws, and nothing in
them changes what will run,
so a host that starts reporting them re-plans to the digest it planned to
before and every parked approval still validates. A host that graphs nothing
omits the field, and a card stored before the field existed still decodes.

`warnings` carries discovery diagnostics for the selected flow, including source
locations for conservative authority fallbacks. Like `graph`, it is outside the
approval digest and does not change the approval payload. Generic hosts and
cards stored before the field existed may omit it.

`executionDigest` binds a discovery-based host's measured source and metadata
to the approved card digest. It is optional for generic control-plane hosts,
but `AgentSession` requires it for prompt execution and checks it again at
launch and on every drive or resume. Changing prompt bytes, model, parameters,
or other discovered metadata requires a new plan and approval.

### Runs

| Export         | Shape                                                                                                                                                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunStatus`    | `"accepted" \| "running" \| "parked" \| "waiting-approval" \| "cancelled" \| "completed" \| "failed"`.                                                                                                                                                                              |
| `RunOrigin`    | `Lineage.Origin`, re-exported so a serializable projection needs one import.                                                                                                                                                                                                        |
| `CancelSource` | `"control" \| "engine" \| "cascade"`.                                                                                                                                                                                                                                               |
| `Cancellation` | `{ requestedAt; source; principal?; reason?; cascadedFrom? }`. See [cancellation attribution](./concepts/cancellation.md).                                                                                                                                                          |
| `RunSummary`   | The projection every listing returns. Required: `runId`, `flowId`, `status`, `createdAt`, `updatedAt`. Optional: `planId`, `planDigest`, `ownerId`, `parentRunId`, `lineageId`, `roundOrdinal`, `origin`, `waitingReason`, `steering`, `pendingResume`, `parkedBy`, `cancellation`. |

`waitingReason` is the run row's own column, written by the engine and only
read here. The CLI's `runs list` and `runs show` also render `executor` in that
position for a run that has sat at `accepted` with no owner past the launch
handoff window; that value is computed at render time and never stored, so a
reader going through the RPC, the gateway, or a plugin sees the field absent on
the same run.

### Steering

| Export          | Shape                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `MessageSteer`  | The envelope plus `kind?: "Message"` and `body: string`.                                                            |
| `SeatSteer`     | The envelope plus the notification package's seat payload fields.                                                   |
| `ThinkingSteer` | The envelope plus its thinking payload fields.                                                                      |
| `ToolsSteer`    | The envelope plus its tools payload fields.                                                                         |
| `SteerMessage`  | The union of those four. The shared envelope is `{ messageId, runId, principal, createdAt }`.                       |
| `steerItem`     | `(message: SteerMessage) => SteerPayload`. Strips the control envelope and returns the item the harness reads back. |

### Signals and events

| Export          | Shape                                                                                                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SignalPayload` | `{ name: string; payload: Json }`.                                                                                                                                                                                          |
| `WatchCursor`   | `{ sequence: number; offset?: number }`. A present offset is the last consumed expansion index; absent means the source entry is fully consumed.                                                                            |
| `WatchFilter`   | `{ runId?: RunId; afterSequence?: number; afterCursor?: WatchCursor; follow?: boolean }`. Either cursor requires `runId`; do not combine them. Omitting `follow` keeps the live stream; `false` requests a finite snapshot. |
| `ControlEvent`  | `{ cursor?: WatchCursor; sequence: number; kind: string; runId?: RunId; occurredAt: number; payload: Json }`.                                                                                                               |

### Listing

| Export            | Shape                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultPageSize` | `100`.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `maxPageSize`     | `500`.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `PageLimit`       | An integer between 1 and `maxPageSize`.                                                                                                                                                                                                                                                                                                                                                                                 |
| `ListRequest`     | `{ _tag: "flows", filters?, cursor?, limit? }`, `{ _tag: "runs", filters?: { runId?, flowId?, status?, principalId?, parentRunId?, lineageId? }, cursor?, limit? }`, `{ _tag: "triggers", filters?: { triggerId?, flowId?, enabled? }, cursor?, limit? }`, `{ _tag: "fires", filters?: { triggerId?, runId?, outcome? }, cursor?, limit? }`, or `{ _tag: "plans", filters?: { flowId?, decision? }, cursor?, limit? }`. |
| `ListResponse`    | `{ _tag: "flows", items, warnings?, nextCursor? }`, `{ _tag: "runs", items: RunSummary[], nextCursor? }`, `{ _tag: "triggers", items: TriggerSummary[], nextCursor? }`, `{ _tag: "fires", items: FireSummary[], nextCursor? }`, or `{ _tag: "plans", items: PlanSummary[], nextCursor? }`.                                                                                                                              |
| `TriggerSummary`  | `{ triggerId, flowId, input: Json, cron, timezone?, overlap: "skip" \| "buffer-one" \| "supersede", catchUp: "none" \| "one" \| "all", maxCatchUp?, enabled, revision, lastFiredAtMs?, pendingAtMs?, activeRunId?, nextOccurrencesMs: number[], schedulerLastTickMs? }`. One registered trigger. `schedulerLastTickMs` absent means no scheduler has ticked on this host.                                               |
| `FireOutcome`     | `"launched" \| "completed" \| "skipped" \| "buffered" \| "superseded" \| "failed"`. The same words the triggers package records in its fire ledger.                                                                                                                                                                                                                                                                     |
| `FireSummary`     | `{ triggerId, occurrenceAtMs, outcome: FireOutcome \| null, runId?, error?, waiting?: "approval" }`. One claimed occurrence; `outcome: null` is the window between the claim and its result.                                                                                                                                                                                                                            |
| `PlanDecision`    | `"pending" \| "approved" \| "denied"`.                                                                                                                                                                                                                                                                                                                                                                                  |
| `PlanSummary`     | `{ card: PlanCard, input: Json, decision: PlanDecision }`. One stored plan; `card.approval` is the payload `approve` or `deny` takes.                                                                                                                                                                                                                                                                                   |

`plans` lists stored plans oldest first, narrowed by `flowId` and `decision`.
A build target that declares `approval: "required"` leaves a pending
`system/target` plan whose `input` is `{ label, digest }`; list them with
`{ _tag: "plans", filters: { flowId: "system/target", decision: "pending" } }`
and submit `card.approval` to `approve` or `deny`. A page returns at most
`limit` plans and `nextCursor` while later plans may match. Plans are an
operator's to read: a reader restricted to its own runs lists none.

Run listings default to 100 items and accept limits from 1 through 500. Pass
`nextCursor` back unchanged with the same filters. Run cursors contain stable
ordering keys, not numeric offsets. Control-launched runs retain launch order;
engine-created runs follow in creation-time and run-id order. Removing a prior
row does not skip the next row. Listings are live, not a fixed snapshot.

A run page returns at most `limit` rows; `limit` does not bound the work done
to fill it. Without a `status` or `terminal` filter, the runtime selects at most
`limit` rows on durable summary fields before decoding summaries, reading their
ancestry, or observing execution, and executor observations enrich only those
rows. When the executor reports observed status, a `status` or `terminal`
filter applies to that observed status instead: the runtime selects on the
remaining filters, observes each selected row, and keeps walking the source
until the page is full or no runs remain. One page can therefore observe many
more runs than `limit`, so a host cannot treat the page size as a bound on
`readExecution` calls. Pending steering counts enrich only the returned rows.
An exact `runId` filter keeps the direct lookup and applies the remaining
filters to that observation.

`principalId` selects the runs whose `RunSummary.launchedBy.id` it names. A
run the control plane launched records its launcher; one the engine created
(a child, a fork, a later round) records none. Over RPC the server restricts a
reader that `ControlRpcs.RunVisibility` does not make an operator to the runs
its own principal launched: `List` sets `ListInput.reader` and `Watch` sets
`WatchInput.reader`, neither of which is on the wire. Such a reader lists and
watches only those runs, sees only the fires that started them and no
triggers, receives nothing from a plan partition, and gets `RunNotFound` for
any other run. A lost-tail watch failure reaches it without partition names.
`steer`, `signal`, `cancel` and `resume` take the same `reader`: over RPC the
server sets it, and such a reader mutates only those runs and gets
`RunNotFound` for any other.

The `triggers` and `fires` variants are answered through the `DispatchReader`
port. A host without one refuses both with `InvalidInput` whose issue is
`this host serves no trigger store`, never with an empty page.

### Receipts

`Receipt` is the union every mutation answers:

| Member           | Fields                                                              |
| ---------------- | ------------------------------------------------------------------- |
| `Accepted`       | `{ receiptId: string; runId?: RunId; handedTo?: RunHost }`          |
| `AlreadyApplied` | `{ receiptId: string; runId?: RunId }`                              |
| `Parked`         | `{ receiptId: string; planId: string; status: "waiting-approval" }` |
| `Conflict`       | `{ message: string }`                                               |
| `Terminal`       | `{ runId: RunId; status: RunStatus }`                               |

`RunHost` is `{ hostId: string; pid: number }`. An `Accepted` resume with
`handedTo` names the live host that parked the run and now drives it.

### RPC request schemas

`PlanInputSchema`, `RunInputSchema`, `ApprovalInputSchema`,
`SteerInputSchema`, `SignalInputSchema`, `RunMutationInputSchema`,
`ReasonedMutationInputSchema`, and `CancelInputSchema` are the wire forms.
`PlanInputSchema` takes `Schema.Json` where the local contract takes `unknown`.
`ReasonedMutationInputSchema` adds `reason` and omits `principal`, because the
server stamps the identity it authenticated. `CancelInputSchema` is a named
alias of it, so cancellation's public contract stays explicit.

## ControlError

Every stable failure the plane emits. Each class carries a constant `code` a
client may branch on.

| Class                | `code`                                                                      | Fields                                   | Meaning                                                                                  |
| -------------------- | --------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `RunNotFound`        | `run_not_found`                                                             | `runId`                                  | No run with this id exists.                                                              |
| `PlanNotFound`       | `plan_not_found`                                                            | `planId`                                 | No plan with this id. Carries an operator-facing `message`.                              |
| `PlanDenied`         | `plan_denied`                                                               | `planId`                                 | The plan was denied. Carries an operator-facing `message`.                               |
| `FlowNotFound`       | `flow_not_found`                                                            | `flowId`                                 | No flow with this id is registered.                                                      |
| `PlanDigestMismatch` | `plan_digest_mismatch`                                                      | `planId`, `expected`, `actual`           | The submitted plan does not hash to the declared digest.                                 |
| `EnvelopeMismatch`   | `envelope_mismatch`                                                         | `planId`, `expected`, `actual`           | The plan's effect envelope differs from the declared one.                                |
| `ClaimLost`          | `claim_lost`                                                                | `runId`, `reason?`, `parkedBy?`          | The caller's claim lapsed or was fenced by a newer owner, or a live host parked the run. |
| `AlreadyResolved`    | `already_resolved`                                                          | `requestId`                              | This request was already answered.                                                       |
| `InvalidInput`       | `invalid_input`                                                             | `issue`                                  | The request missed its schema or a stated precondition.                                  |
| `Unauthorized`       | `unauthorized`                                                              | `message`                                | No usable credential for this operation.                                                 |
| `Unavailable`        | `unavailable`                                                               | `feature`, `ticket`                      | Not implemented in this deployment.                                                      |
| `TransportError`     | `transport_error`                                                           | `message`, `retryable`, `cause?`         | The request failed before a declared response arrived.                                   |
| `PersistenceError`   | `persistence_failed`                                                        | `operation`, `message`, `cause?`         | A store operation failed.                                                                |
| `LaunchFailed`       | `launch_failed`                                                             | `runId`, `message`, `cause?`             | The executor refused or could not start the run.                                         |
| `NoMatchingWait`     | `no_matching_wait`                                                          | `runId`, `waitName`                      | A signal named a wait point the run does not have open.                                  |
| `CredentialConflict` | `credential_conflict`                                                       | `id`, `expectedVersion`, `actualVersion` | A credential write lost a compare-and-set race.                                          |
| `NotificationError`  | `notification_closed`, `notification_full`, and existing notification codes | `message`, `notificationId?`, `path?`    | Existing notification error class, now preserved by steering locally and through RPC.    |

| Export               | Kind   | Meaning                                                                                                              |
| -------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| `ControlErrorSchema` | schema | The single membership list. `ControlClient.isControlError` is `Schema.is` of it, so a class added here reaches both. |
| `ControlError`       | type   | `typeof ControlErrorSchema.Type`.                                                                                    |

`NoMatchingWait` spells its field `waitName` rather than `name`, because a
field named `name` on an `Error` subclass shadows `Error.prototype.name`, which
every renderer in the tree reads.

`TransportError.retryable` classifies the transport phase alone. Resend a
retryable mutation only when its idempotency key makes replay safe; a keyless
request can have reached the server even when its response was lost.

### New public steering refusal channel

`Control.steer` now preserves the existing notifications package's
`NotificationError`, including new `notification_closed` and `notification_full`
codes. This is an extension to the public error union and the Steer RPC schema;
it does not introduce a new error class or change successful receipts.
Existing `notification_unavailable`, `notification_id_reused`, and
`notification_invalid` failures also now retain this tag, replacing their former
`PersistenceError` wrapper with operation `control.steer.notification`. Update
callers that matched that wrapper to handle `NotificationError` directly.

```ts
import { Effect } from "effect"

const outcome = yield* control.steer(input).pipe(
  Effect.map(receipt => ({ kind: "receipt" as const, receipt })),
  Effect.catchTag("/notifications/NotificationError", error => Effect.gen(function*() {
    if (error.code === "notification_closed") return { kind: "start-new-request" as const }
    if (error.code === "notification_full") return { kind: "retry-after-drain" as const }
    return yield* Effect.fail(error)
  }))
)
```

A closed receiver cannot accept a new message, even if its surrounding run is
still finishing. A full queue has retained nothing; after a boundary drains it,
the caller can retry the same notification and idempotency key. Control records
no accepted mutation for a capacity refusal. Duplicate accepted messages retain
the existing `AlreadyApplied` behavior. Journal I/O failures still become
`PersistenceError`; their diagnostic cause is retained separately from the fixed
operator-facing message.

Deploy updated clients/UI and server together. Older RPC decoders do not know
this error variant and may report a decode or transport failure instead of the
closed/full reason. The change is additive in the source API but is **not fully
wire-compatible with older exhaustive error decoders**. Do not retry an unknown
decode failure as if it proved the request was never admitted. Existing error
codes, successful response shapes, and notification events are unchanged.

## ControlLive

| Export  | Signature                                                                           |
| ------- | ----------------------------------------------------------------------------------- |
| `layer` | `Layer<Control, never, ControlRuntime \| Journal \| NotificationQueue \| Registry>` |

Writes delegate to `ControlRuntime`; journal events are observational records
committed with the state they describe. `watch` only replays and follows
committed entries. `ControlExecutor` is read optionally, so a composition
without one records but starts nothing. `DispatchReader` is read optionally
too: without one, `list` still answers `flows` and `runs`, and refuses
`triggers` and `fires` with the typed issue `this host serves no trigger store`.

## ControlRuntime

The persistence port `ControlLive` writes through, and its deterministic
in-memory implementation. A production adapter fences every owner-sensitive
write, implements resume as join-or-claim, releases claims on every waiting or
terminal transition, and translates conflicts into typed failures.

| Export                              | Kind          | Signature                                                                                                   |
| ----------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| `ControlRuntime`                    | class         | `Context.Service<ControlRuntime, Service>` at key `/control/ControlRuntime`                                 |
| `make`                              | function      | `(implementation: Service) => Service`                                                                      |
| `layerMemory`                       | layer         | `(options?: MemoryOptions) => Layer<ControlRuntime, never, Crypto>`                                         |
| `requireApproved`                   | function      | `(token: ApprovalToken) => Effect<ApprovalToken & { _tag: "Approved" }, ApprovalPending \| ApprovalDenied>` |
| `ApprovalDecision`                  | schema        | Tagged `Pending \| Approved \| Denied` decision                                                             |
| `ApprovalPending`, `ApprovalDenied` | error schemas | Fail-closed gate outcomes; include them in action/flow error schemas                                        |

### Service

| Group             | Members                                                                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plans             | `plan(input: PlanInput) => Effect<PlanOutcome, FlowNotFound \| InvalidInput \| PersistenceError>`, `getPlan(planId)`, `listPlanIds`                                                                 |
| Approvals         | `authorizeApproval(request)`, `lookupApproval(target)`, `registerApproval(nodeTarget)`, `resolveApproval(token, decision, principal, scope?)`, `installBulkGrant(token, envelope, scope)`, `grants` |
| Runs              | `launch(planId, digest, envelope) => Effect<LaunchResult, ...>`, `getRun(runId)`, `queryRuns({ filters?, cursor?, limit })`, `listRuns`, `listFlows`                                                |
| Signal history    | `deliverSignal(runId, signal)`, `deliveredSignals(runId)`                                                                                                                                           |
| Resume delegation | `requestResume(runId) => Effect<number, ...>`, `pendingResumes`, `clearResume(runId, sequence)`                                                                                                     |
| Ownership         | `registerFiber(runId, fiber)`, `interrupt(runId, settle?)`, `resume(runId, options?)`, `claimFence(runId)`, `releasePending(runId, fence)`, `writeStatus(runId, fence, status)`                     |
| Identity          | `stampPrincipal(submitted?)`, `lookupMutation(key, fingerprint)`, `recordMutation(key, fingerprint, receipt)`                                                                                       |

`queryRuns` accepts `RunQuery`: optional `flowId`, `status`, `terminal`,
`parentRunId`, `lineageId`, `since` (inclusive creation epoch ms), `until`
(exclusive), and `runIds` filters, an optional `order` (`newest` or `oldest`
creation time), an optional `RunCursor`, and a required integer `limit` from 1
through 500. `Control.list` resolves a `runs` request's `triggerId` filter to
`runIds` from the trigger's recorded fires. It returns `RunPage` with `items` and optional `nextCursor`.
`RunCursor` contains `source` (0 for control launches, 1 for engine runs),
`sequence`, `createdAt`, and `runId`. Adapters must select the page before
summary decoding and ancestry projection. SQL reads one extra ordering key to
determine continuation. `listRuns` remains the full inventory for recovery and
journal partition discovery; interactive listings use `queryRuns`.

Steering uses `NotificationQueue.enqueue` and `NotificationQueue.drain`.
`enqueueSteer` and `drainSteering` have been removed from the runtime port and
both adapters. The legacy signal-history reader and database migrations remain;
old steering rows are not drained or delivered by the runtime.

`interrupt` must be called without mutation locks. Its optional `settle` wrapper
runs only after the fiber's finalizers finish and wraps the fenced status
reconciliation. `ControlLive` uses it to commit the terminal event alongside
the status. Direct callers may omit it.

`resume` takes `{ scope?: "launched" \| "any" }`. `scope: "launched"`
restricts claims to the shared `control_runs` launch index. Both public
spellings, `Control.resume` and `Control.run` with a Resume input, and every
steer wake pass it. `scope: "any"`, also the default, is a trusted low-level
runtime capability for hosts that can drive the claimed execution.
An owned non-terminal run is joined without replacing its fence, including
`accepted`; a run released by `releasePending` can be claimed again.

Explicit resume journals `control.run.resume` and never calls
`ControlExecutor.resumeRun`. A caller or journal subscriber must drive the
execution; polling `pendingResumes` does not take up a resume the caller
claimed. A run a live host parked fails the claim with `ClaimLost` naming the
host in `parkedBy`. `Control.resume` then hands it to that host: it records
`requestResume(runId, { consent })`, where `consent` is the journal sequence of
its `control.run.resume`, and answers `Accepted` with `handedTo`.
`pendingResumes` reports that `consent`, and the parking host records the
per-release retry permission under it before it re-drives the run.
A suspended engine-created run stays unclaimed and receives an `Accepted`
receipt for the journal intent. A live peer's owned run fails with `ClaimLost`.
A running engine-created run outside the launch index also fails with
`ClaimLost` when its owner is dead; its persisted execution state is preserved.
Node-approval decisions use the durable resume delegation instead.

`registerApproval` is idempotent and returns the token with its current
tagged decision. `Pending` parks, `Approved` opens a gate, and `Denied` fails it.
Use `requireApproved` to enforce this distinction. A registration that disagrees
with the stored digest or envelope is refused exactly as `lookupApproval`
refuses it. Terminal decisions carry `decisionPrincipal` and `decidedAt`;
`Approved` also carries `scope`. The low-level `resolveApproval` defaults scope
to `once`; when installing a wider grant, pass that same scope explicitly.
`Control.approve` does this automatically. Resolution checks the owning
`ApprovalAuthority` again and may fail with `Unauthorized`; it does not install
a grant. `installBulkGrant` is a trusted storage port, not an authorization API.

For a new decision, authenticate the principal and call `authorizeApproval`
before target reads or receipt replay. Then call `lookupApproval`,
`resolveApproval` exactly once with an authority recheck, `installBulkGrant` only
on approval, and journal the decision. Commit the decision, grant, journal entry,
receipt, and any node resume delegation atomically. Resolution must not require
an installed grant or a flushed journal decision.

Migration 6004 preserves legacy rows. Unknown old terminal decisions are
refused with `PersistenceError`; pending rows remain pending. Preserve the old
database and start a new run/request instead of inferring approval from a grant.

`requestResume` returns the durable sequence `clearResume` checks, so a resume
requested while one is being taken up is not lost with it.

### Models

| Type             | Shape                                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StoredPlan`     | `{ card: PlanCard; decodedInput: unknown; decision: "pending" \| "approved" \| "denied" }`                                                                                                                                                                                |
| `ApprovalToken`  | `{ tokenId: string; target: ApprovalTarget } & ApprovalDecision`; `_tag: "Pending"`, or `_tag: "Approved"` with principal/time/scope, or `_tag: "Denied"` with principal/time                                                                                             |
| `BulkGrant`      | `{ tokenId: string; envelope: Envelope; scope: GrantScope; installedAt: number }`                                                                                                                                                                                         |
| `LaunchResult`   | `{ _tag: "Started"; receipt; run }` or `{ _tag: "Parked"; receipt }`                                                                                                                                                                                                      |
| `PlanOutcome`    | `{ card: PlanCard; created: boolean }`. `created` is what lets `plan` journal one creation per plan rather than one per retry.                                                                                                                                            |
| `MutationRecord` | `{ fingerprint: string; receipt: Receipt }`                                                                                                                                                                                                                               |
| `PendingResume`  | `{ runId: RunId; sequence: number; requestedAtMs: number }`                                                                                                                                                                                                               |
| `MemoryFlow`     | `{ flowId; description; deployClass; envelope; executionDigest?; decode?; plan? }`. The optional execution identity is included in the approved card; `decode` validates input and `plan` projects it into the keyed node graph, answering `{ plan, statuses?, graph? }`. |
| `MemoryOptions`  | `{ flows?: MemoryFlow[]; now?: () => number; principal?: Omit<Principal, "stampedAt">; approvalAuthority?: ApprovalAuthority.Service }`                                                                                                                                   |

`layerMemory` models the production fence and approval ordering seams but keeps
everything in a `Map`. Nothing it decides survives the process.

## ApprovalAuthority

Host-owned approval policy, separate from authentication and granted workflow
capabilities. Import `@smthrs/control/ApprovalAuthority` or its root namespace.

- `Request`: `{ principal, target, decision: "approved" | "denied", scope }`.
- `Service.authorize(request)`: `Effect<void, Unauthorized | PersistenceError>`.
- `Delegation`: schema/type for `{ principal: { id, kind }, scopes, targets }`.
  Exact scopes are `once`, `run`, `remembered`; target kinds are `Plan`, `Node`.
- `make(delegations)`: validates and snapshots up to 1,024 explicit delegations;
  returns `Effect<Service, InvalidInput>`. Empty configuration denies everyone.
- `local`: default policy for the fixed `local/operator` identity only. Custom
  identities, including bearer and agent identities, need explicit delegation.
  A principal's `kind` is not itself a role grant. The memory adapter's own
  default also delegates its `memory/test` identity; `local` never does.

`Control.approve` and `deny` check before reads and receipt replay. Both runtime
adapters check again at resolution. Denial requires a delegated target kind but
does not require a grant scope because it grants nothing. See the
[approval guide](./guides/approvals.md#who-may-decide) for host composition.

## SqlControlRuntime

The durable `ControlRuntime` over a SQL database and the fenced run store from
[`@smthrs/run-store`](/api/run-store).

| Export           | Kind      | Signature                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DurableFlow`    | type      | `MemoryFlow`, so one catalog serves either runtime.                                                                                                                                                                                                                                                                                                                   |
| `Options`        | interface | `{ flows?: ReadonlyArray<DurableFlow>; loadFlows?: () => Effect<ReadonlyArray<DurableFlow>, PersistenceError>; owner?: Ownership.OwnerId; isAlive?: Ownership.LivenessCheck; principal?: Omit<Principal, "stampedAt">; approvalAuthority?: ApprovalAuthority.Service }`; with `isAlive`, `resume` takes over a running run whose owner is gone once its lease expired |
| `migrate`        | effect    | `Effect<void, PersistenceError, SqlClient>`. Creates every control-plane table, idempotently.                                                                                                                                                                                                                                                                         |
| `make`           | function  | `(options?: Options) => Effect<Service, PersistenceError, Crypto \| DurableWriter \| SqlClient \| RunStore>`                                                                                                                                                                                                                                                          |
| `layer`          | layer     | `(options?: Options) => Layer<ControlRuntime, PersistenceError, Crypto \| DurableWriter \| SqlClient \| RunStore>`                                                                                                                                                                                                                                                    |
| `layerWithStore` | layer     | The same, with `RunStore.layer` provided.                                                                                                                                                                                                                                                                                                                             |

Dead-owner takeovers with `scope: "launched"` require a launch-index entry;
unindexed engine continuations remain unchanged.

`loadFlows` replaces the static `flows` or default system catalog. It runs afresh
for each `plan` and `listFlows` operation, and one plan uses one complete catalog
snapshot. Loader failures remain typed `PersistenceError`s. A host using a
refreshable registry can therefore plan from newly discovered or edited flows
without restarting the runtime. Stored plans and approvals retain the execution
identity they originally captured; refreshing the catalog does not rewrite them.

Omitting `owner` mints one synthetic identity for this runtime only, so
separately constructed runtimes cannot cross each other's fences. Hosts that
can report a real process identity should supply it.

The run lifecycle is not reimplemented here. `RunStore` owns it, and every
ownership move is a single SQL compare-and-swap. See
[Ownership, fences, and claims](./concepts/ownership.md) for the status
mapping.

## ControlExecutor

The acceptance port from the control plane into a real run executor.

| Export            | Kind     | Signature                                                                                                                                                |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ControlExecutor` | class    | `Context.Service<ControlExecutor, Service>` at key `/control/ControlExecutor`                                                                            |
| `make`            | function | `(implementation: Service) => Service`                                                                                                                   |
| `makeNoop`        | function | `(overrides?: Partial<Service>) => Service`. Accepts every launch as `pending` and starts nothing.                                                       |
| `makeObserving`   | function | `(service: Service) => Service`. The same executor with `launch` and `resumeRun` refused as defects, for a host composed to observe runs and drive none. |
| `layer`           | layer    | `(implementation: Service) => Layer<ControlExecutor>`                                                                                                    |
| `layerNoop`       | layer    | `(overrides?: Partial<Service>) => Layer<ControlExecutor>`                                                                                               |

### Service

| Method                | Signature                                                          |
| --------------------- | ------------------------------------------------------------------ |
| `launch`              | `(input: Launch) => Effect<Acceptance, LaunchFailed>`              |
| `requestCancel`       | `(input: CancelRequest) => Effect<CancelRecord, PersistenceError>` |
| `deliverSignal`       | `(input: Signal) => Effect<SignalDelivery, PersistenceError>`      |
| `resumeRun`           | `(input: ResumeRequest) => Effect<ResumeUptake, PersistenceError>` |
| `settleCancelledPark` | `(input: CancelRequest) => Effect<void, PersistenceError>`         |

### Models

| Type                             | Shape                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Launch`                         | `{ plan: StoredPlan; run: RunSummary }`. `run.runId` is the execution id the executor must start.                                    |
| `Acceptance`                     | `"accepted"` (taken now) or `"pending"` (queued).                                                                                    |
| `CancelRequest`, `ResumeRequest` | `{ runId: RunId }`                                                                                                                   |
| `CancelTerminal`                 | `{ _tag: "Terminal"; status: "completed" \| "failed" \| "cancelled" }`. The engine's own status, which the plane cannot read itself. |
| `CancelRecord`                   | `"recorded" \| "already-requested" \| "unknown" \| CancelTerminal`                                                                   |
| `ResumeUptake`                   | `"resuming" \| "unknown"`                                                                                                            |
| `Signal`                         | `{ runId: RunId; signal: SignalPayload }`                                                                                            |
| `SignalDelivery`                 | `"delivered" \| "no-match" \| "unknown"`                                                                                             |

`settleCancelledPark` is called after the cancel mutation commits, never inside
it: driving a run re-enters the engine, whose writes would wait on the writer
the transaction holds.

## DispatchReader

The read port from the control plane into a host's trigger store. `Control.list`
answers `{ _tag: "triggers" }` and `{ _tag: "fires" }` through it. The port
lives here rather than in `@smthrs/triggers` because that package depends on
this one (its scheduler launches runs through `Control`), so the adapter over a
real `TriggerStore` is composed by the host.

| Export           | Kind     | Signature                                                                   |
| ---------------- | -------- | --------------------------------------------------------------------------- |
| `DispatchReader` | class    | `Context.Service<DispatchReader, Service>` at key `/control/DispatchReader` |
| `make`           | function | `(implementation: Service) => Service`                                      |
| `makeNone`       | function | `() => Service`. Both methods fail with `refuse()`.                         |
| `refuse`         | function | `() => InvalidInput` with code `invalid_input` and issue `noStoreIssue`.    |
| `noStoreIssue`   | constant | `"this host serves no trigger store"`.                                      |
| `layer`          | layer    | `(implementation: Service) => Layer<DispatchReader>`                        |
| `layerNone`      | layer    | `Layer<DispatchReader>` providing `makeNone()`.                             |

### Service

| Method  | Signature                                                                           |
| ------- | ----------------------------------------------------------------------------------- |
| `list`  | `(request: TriggersRequest) => Effect<ReadonlyArray<TriggerSummary>, ControlError>` |
| `fires` | `(request: FiresRequest) => Effect<ReadonlyArray<FireSummary>, ControlError>`       |

Each method receives the whole listing request and answers every row it has,
newest fire first. A reader may narrow by `filters`; `Control.list` applies the
same filters again and pages the rows with `cursor` and `limit`, so a reader
that returns every row is still correct and both variants page exactly as
`flows` and `runs` do. `TriggersRequest` and `FiresRequest` are the two
`ListRequest` members by tag.

## ControlRpcs

The schema-backed RPC projection of the service.

| Export                | Kind      | Meaning                                                                                                                                                           |
| --------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ControlRpcs`         | group     | Ten procedures: `Plan`, `Run`, `Approve`, `Deny`, `Steer`, `Signal`, `Cancel`, `Resume`, `List`, and the streaming `Watch`. Carries the `ControlAuth` middleware. |
| `ControlPrincipal`    | class     | The authenticated principal, provided to every handler. Key `/control/ControlPrincipal`.                                                                          |
| `ControlAuth`         | class     | The middleware boundary. Key `/control/ControlAuth`, error `Unauthorized`.                                                                                        |
| `Call`                | interface | `{ rpc: string; payload: unknown }`: the frame a boundary is authenticating, absent at a transport edge.                                                          |
| `Authenticator`       | interface | `{ authenticate: (headers: Record<string, string>, call?: Call) => Effect<Principal, Unauthorized> }`                                                             |
| `BearerAuthOptions`   | interface | `{ token: string; principal: Omit<Principal, "stampedAt">; now?: () => number }`                                                                                  |
| `bearerCredential`    | function  | `(headers) => string \| undefined`. The bearer a request carries, or nothing.                                                                                     |
| `bearerAuthenticator` | function  | `(options: BearerAuthOptions) => Authenticator`. Constant-time comparison; missing, malformed, empty, and incorrect credentials all fail closed identically.      |
| `anyAuthenticator`    | function  | `(authenticators: ReadonlyArray<Authenticator>) => Authenticator`. The first to accept answers; none accepting fails with the last refusal.                       |
| `layerAuth`           | layer     | `(authenticator: Authenticator) => Layer<ControlAuth>`                                                                                                            |
| `layerBearerAuth`     | layer     | `(options: BearerAuthOptions) => Layer<ControlAuth>`                                                                                                              |
| `layerNoopAuth`       | layer     | `(principal?: Principal) => Layer<ControlAuth>`. Authenticates nothing.                                                                                           |
| `ControlDefect`       | schema    | The defect schema of every procedure. Encodes any non-string defect as `{ name: "Error", message: defectMessage }`; decodes like `Schema.Defect()`.               |
| `defectMessage`       | constant  | `"Something went wrong on our side. Not your fault."`                                                                                                             |

`List` and `Watch` declare the whole `ControlError` union rather than restating
its members.

A handler defect, an untyped failure no procedure declares, reaches a client as
a `Die` whose defect is `{ "name": "Error", "message": "Something went wrong on
our side. Not your fault." }`. Its raw message and stack never cross the wire;
the server logs them through `ControlServer.logDefect`. A string defect passes
unchanged, so a payload that fails to decode still answers with the request
decoder's own sentence. The encoded shape is the one `Schema.Defect()` decodes,
so older clients and servers read each other's defects.

## ScopedToken

Scoped, expiring tokens minted under a gateway's bearer credential: an
HMAC-SHA256 grant of named procedures, optionally confined to one run or flow,
that the gateway verifies with the credential it already holds. The wire form
is `smt1.<claims>.<signature>`. `smthrs token mint` is the command over it.

| Export            | Kind     | Meaning                                                                                                                                      |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `scopes`, `Scope` | constant | `read:runs`, `write:runs`, and `approve:runs`, each naming the procedures it grants across `ControlRpcs` and the gateway's `GatewayRpcs`.    |
| `scopeNames`      | constant | The scope names in declaration order.                                                                                                        |
| `Claims`          | schema   | `{ v: 1; id; procedures; runId?; flowId?; iat; exp }`, milliseconds since the epoch.                                                         |
| `mint`            | function | `(options: MintOptions) => Effect<Minted>`. Dies on an empty key, no scopes, or a non-positive lifetime.                                     |
| `verify`          | function | `(key, token, now) => Effect<Claims, Unauthorized>`. Signature and expiry; every malformation is the same refusal.                           |
| `authorizes`      | function | `(claims, call) => boolean`. The procedure must be named; a confined token authorizes only calls naming its run or flow.                     |
| `authenticator`   | function | `(options: AuthenticatorOptions) => Authenticator`. Signature and expiry always; procedure and confinement when the boundary knows the call. |
| `isScopedToken`   | function | `(credential) => boolean`.                                                                                                                   |
| `procedures`      | function | `(scopes) => ReadonlyArray<string>`, each once.                                                                                              |
| `prefix`          | constant | `"smt1"`.                                                                                                                                    |

## ControlServer

| Export      | Meaning                                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layer`     | The handlers, delegating to `Control`. Every mutation that records who asked reads `ControlPrincipal` and stamps it rather than forwarding what the client sent.                       |
| `layerHttp` | Mounts both protocols on the ambient `HttpRouter`: unary procedures over `POST /rpc`, and `watch` over `WebSocket /rpc/ws`.                                                            |
| `logDefect` | `(cause: Cause<unknown>) => Effect<void>`. Logs a handler's raw defect at error level and ignores typed failures. Tap it around a handler with `Effect.tapCause` or `Stream.tapCause`. |

## ControlClient

| Export           | Kind       | Signature                                                                                                     |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| `ClientConfig`   | interface  | `{ url: string; credential?: string }`. `credential` is attached as a bearer token on every HTTP RPC request. |
| `layer`          | layer      | `(config: ClientConfig) => Layer<Control, ...>`                                                               |
| `isControlError` | refinement | `(value: unknown) => value is ControlError`, derived from `ControlErrorSchema`.                               |

Unary procedures use HTTP at `url`; `watch` uses the abstract WebSocket the
platform layer supplies. Declared control failures cross the wire as
themselves; everything else becomes a `TransportError` whose `retryable` flag
classifies the transport phase.

In rc.0, `ClientConfig.credential` authenticates HTTP calls only; it does not
authenticate the `watch` WebSocket upgrade. Authenticated remote watch requires
a socket implementation that sends the Authorization header, or a trusted
proxy that authenticates the caller and supplies it. The default client fails
closed against a credentialed gateway. Tokens in URL query strings are not
supported.

## Lineage

Run ancestry as the control plane reads it. See
[Run lineage](./concepts/lineage.md).

| Export                 | Kind            | Signature                                                                                                           |
| ---------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `Origin`               | schema and type | `"child" \| "fork" \| "continuation"`                                                                               |
| `Ancestry`             | interface       | `{ parentRunId?: string; roundOrdinal?: number; forked?: boolean }`                                                 |
| `runDecisionEventType` | constant        | `"flows.engine.run-decision"`                                                                                       |
| `forkCreatedEventType` | constant        | `"flows.time-travel.fork-created"`                                                                                  |
| `lineageEventType`     | constant        | `"control.run.lineage"`                                                                                             |
| `originOf`             | function        | `(ancestry: Ancestry) => Origin \| undefined`. A fork wins over a plain child, because a fork records a parent too. |
| `derive`               | function        | `(event: ControlEvent) => ControlEvent \| undefined`. The ancestry delta one entry discloses, if it discloses one.  |
| `expand`               | function        | `(event: ControlEvent) => ReadonlyArray<ControlEvent>`. The entry plus any delta.                                   |

## Cancellation

Cancellation attribution as the plane reads it back. See
[Cancellation attribution](./concepts/cancellation.md).

| Export                 | Kind      | Signature                                                                                                                        |
| ---------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `requestedEventType`   | constant  | `"control.run.cancel-requested"`                                                                                                 |
| `interruptedEventType` | constant  | `"flows.engine.interrupted"`                                                                                                     |
| `Request`              | interface | `{ requestedAt: number; principal?: Principal; reason?: string }`                                                                |
| `Evidence`             | interface | `{ runId: string; parentRunId?: string; cancelRequestedAt?: number; cancelledAt?: number }`                                      |
| `Input`                | interface | `{ runs: ReadonlyArray<Evidence>; requests: ReadonlyMap<string, Request> }`                                                      |
| `attribute`            | function  | `(input: Input) => ReadonlyMap<string, Cancellation>`. Pure and scope-independent: it reads what it is handed and never queries. |

## Steering

The steer lifecycle as the plane reads it back. See
[Steer a running agent](./guides/steer-a-run.md).

| Export               | Kind     | Signature                                                                                                                                        |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enqueuedEventType`  | constant | `"control.steer.enqueued"`, written by `Control.steer`.                                                                                          |
| `promotedEventType`  | constant | `"flows/notifications/Promoted"`, written by the queue.                                                                                          |
| `deliveredEventType` | constant | `"control.steer.delivered"`, derived.                                                                                                            |
| `derive`             | function | `(event: ControlEvent) => ReadonlyArray<ControlEvent>`. One delta per message a promotion named. A promotion that named nothing derives nothing. |
| `expand`             | function | `(event: ControlEvent) => ReadonlyArray<ControlEvent>`                                                                                           |

## Health

Observational health for flows and native sessions. See
[Configure observational health](./guides/observe-health.md).

`HealthChecker<C>` accepts a read-only `ProbeContext` and schema-decoded config,
returning an Effect of `ProbeReport`. `makeRegistry(config, kind)` admits host
bindings and policies synchronously; `registry.resolve(key)` returns the selected
`ResolvedCheck`. `evaluate(check, context, stamp)` runs it with a timeout and safe
failure codes. The host rechecks ownership and commits the `HealthObservation`
before publication.

`rollup(input)` combines authoritative lifecycle, optional independent base
health, and the latest `{ observation, sequence }` into `StatusRollup`. The wire
axes are `state`, `activity`, `health`, `attention`, and `freshness`. Attention
is `none`, `awaiting-approval`, `needs-input`, `needs-resume`, or `unhealthy`;
`needs-resume` (reason `released`) marks a run parked over executions its owner
released, which only an explicit resume restarts. Provenance
carries checker/monitor IDs, opaque incarnation, evidence position, durable
version, observation time, and expiry. `latestObservation` compares only matching
incarnations and uses journal order for equal evidence. `runIncarnation` derives
an opaque fingerprint from current run ownership and lifecycle.

`CheckPolicy` configures interval, timeout, TTL, no-progress grace (`stallAfterMs`),
and failure backoff. `defaultPolicy` uses 5s/2s/20s/120s respectively and caps
backoff at 60s. Defaults report unknown semantic activity; no checker output grants
approval or authorizes a remedy.

## JevSessionChecker

The one registered checker that reads semantic activity, bound by the ID
`jev.session`. See [Configure observational health](./guides/observe-health.md).

`makeJevSessionChecker({ evaluator, timeoutMs })` uses the host's existing
subscription judge. `Health.makeRegistry(config, kind, evaluator)` binds it to
`jev.session`. It asks one choice question over `working`, `idle`, and
`needs-input`, plus a boolean question about waiting for a person. Evidence is
`alive`, `exitCode`, and the newest `jevStateTailCharacters` of output.
It reads no gateway key and has no separate authentication path.

An answer becomes a report only at confidence `jevConfidenceFloor` or above:
`needs-input` reports reason `prompt-detected`, `working` and `idle` report `ok`.
A reading below the floor is Jev's own answer and reports
`{ activity: "unknown", reason: "ok" }`.

There is no fallback to another model or to a healthy-looking answer. An
unexposed output tail and a session that is not alive keep the lifecycle report,
because there is nothing to ask about. Every other way the probe cannot ask
fails it with `JevProbeError`, whose `reason` is `unconfigured` (no host evaluator), `http` (with the provider's `status`), `timeout`,
`unreachable`, or `malformed` (a body that does not answer the question asked).
`Health.evaluate` records a failing probe as `outcome: "error"` with reason
`probe-error` and no report, so `rollup` reads the subject `stale`, activity
`unknown`, health `unknown`, reason `probe-error`, never healthy, and
`CheckPolicy.backoff` spaces the retries. A host that binds `jev.session` must
supply its evaluator through `Health.makeRegistry(config, kind, evaluator)`.

`jevRequestTimeoutMs` is the deadline on the call and `jevProbeTimeoutMs` the
wider probe budget this checker asks a binding for, so the typed `timeout`
failure surfaces instead of a bare `probe-timeout`.

## Monitor

Run health over the control plane. See
[Monitor a run and heal it](./guides/monitor-runs.md).

| Export                     | Kind            | Signature                                                                                                                              |
| -------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Health`                   | schema and type | `"healthy" \| "stalled" \| "wedged-node" \| "runaway-loop" \| "awaiting-human" \| "failing" \| "unknown"`                              |
| `Observation`              | interface       | `{ summary?: RunSummary; events: ReadonlyArray<ControlEvent>; beatsWithoutProgress: number; stallBeats: number; roundBound?: number }` |
| `classify`                 | function        | `(observation: Observation) => Health`. Pure.                                                                                          |
| `Remedy`                   | type            | `"resume" \| "cancel" \| "none"`                                                                                                       |
| `remedyFor`                | function        | `(health: Health) => Remedy`                                                                                                           |
| `Beat`                     | interface       | `{ beat: number; health: Health; sequence: number; healed?: Remedy; receipt?: Receipt }`                                               |
| `Report`                   | interface       | `{ runId: RunId; beats: ReadonlyArray<Beat>; health: Health }`                                                                         |
| `Options`                  | interface       | `{ runId; monitorId?; intervalMs?; maxChecks?; stallBeats?; roundBound?; autoHeal?; heal? }`                                           |
| `run`                      | function        | `(options: Options) => Effect<Report, ControlError, Control \| Journal>`                                                               |
| `attemptStartedEventType`  | constant        | `"flows.engine.attempt-started"`                                                                                                       |
| `attemptFinishedEventType` | constant        | `"flows.engine.attempt-finished"`                                                                                                      |
| `beatEventType`            | constant        | `"control.monitor.beat"`                                                                                                               |
| `healedEventType`          | constant        | `"control.monitor.healed"`                                                                                                             |

Defaults: `monitorId` is `default`, `intervalMs` is 1,000, `maxChecks` is 10,
`stallBeats` is 3, `roundBound` is 32, and `autoHeal` is empty.

## Channels

Verified ingress. A channel verifies opaque transport data before it decodes or
maps it, and dispatches the result through `Control`.

| Export               | Kind              | Signature                                                                                            |
| -------------------- | ----------------- | ---------------------------------------------------------------------------------------------------- |
| `Channels`           | interface and tag | `{ register; lookup; ingest; project }` at key `/control/Channels`                                   |
| `Channel<A>`         | interface         | `{ name; schema; fingerprintHeaders?; verify; decode; map; project }`                                |
| `RawInbound`         | interface         | `{ body: Uint8Array; headers: Record<string, string \| undefined>; idempotencyKey: IdempotencyKey }` |
| `InboundResult`      | type              | `{ _tag: "Start"; flowId; input }` or `{ _tag: "Signal"; runId; signal }`                            |
| `IngestRequest`      | interface         | `{ channel: string; raw: RawInbound }`                                                               |
| `ProjectRequest`     | interface         | `{ channel: string; run: RunSummary }`                                                               |
| `Delivery`           | interface         | `{ cursor: string; messageId?: string }`                                                             |
| `DeliveryProjection` | interface         | `{ cursor; messageId?; operation: "post" \| "edit" \| "noop"; message: unknown }`                    |
| `make`               | effect            | Builds the coordinator over `ControlRuntime`'s durable mutation store.                               |
| `makeMemory`         | effect            | Builds a process-local coordinator for adapter unit tests.                                           |
| `layer`              | layer             | `Layer<Channels, never, ControlRuntime \| Control>`                                                  |
| `layerMemory`        | layer             | `Layer<Channels, never, Control>`                                                                    |

`verify` inspects only opaque bytes and headers, and always precedes `decode`,
which is what keeps an untrusted public request from reaching planning.
`decode` and `map` must be deterministic and side-effect free; a retry may
evaluate either again. `fingerprintHeaders` names only the non-secret headers
that change the decoded command.
Outbound delivery cursors are scoped to the exact channel name and run ID,
including names and IDs containing `:`.

## WebhookChannel

| Export              | Kind      | Signature                                                                                             |
| ------------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| `SignatureVerifier` | type      | `(raw: RawInbound, credential: Redacted<CredentialRef>) => Effect<void, Unauthorized>`                |
| `Config<A>`         | interface | `{ name; schema; credential; fingerprintHeaders?; verify; map; project }`                             |
| `make`              | function  | `<A>(config: Config<A>) => Channel<A>`                                                                |
| `maximumBodyBytes`  | constant  | `1048576`, the default body ceiling for one mount.                                                    |
| `HandlerOptions`    | interface | `{ maximumBodyBytes?: number }`                                                                       |
| `handler`           | function  | `(channel: string, idempotencyKey: IdempotencyKey, options?: HandlerOptions) => Effect<Receipt, ...>` |

The body is bounded twice: a `content-length` over the limit is refused before
the body is read, and each streamed chunk is measured before it is retained.
Reading stops at the first chunk exceeding the limit, before verification.
Both refusals are `InvalidInput` naming the two byte counts and no body content.
Malformed JSON returns the fixed issue `invalid webhook JSON` without parser
messages or payload fragments.

## Credential

The credential boundary. Only a `CredentialRef` crosses it. See
[Store and resolve a credential](./guides/store-credentials.md).

| Export          | Kind              | Signature                                                                                                                                |
| --------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `CredentialRef` | interface         | `{ id: string; name: string }`                                                                                                           |
| `Operation`     | type              | `"list" \| "get" \| "create" \| "resolve" \| "rotate" \| "revoke"`                                                                       |
| `Credential`    | interface and tag | The six operations, at key `/control/Credential`                                                                                         |
| `Options`       | interface         | `{ store: CredentialStore.Service; cipher: CredentialCipher.Service; authorize?: (operation, reference) => Effect<void, Unauthorized> }` |
| `make`          | function          | `(options: Options) => Credential`                                                                                                       |
| `layer`         | layer             | `(options?: { authorize? }) => Layer<Credential, never, CredentialStore \| CredentialCipher>`                                            |
| `makeNoop`      | function          | `() => Credential`. Every operation fails `Unavailable`.                                                                                 |
| `layerNoop`     | layer             | `Layer<Credential>`                                                                                                                      |

| Operation | Signature                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`    | `() => Effect<ReadonlyArray<CredentialRef>, Unavailable \| Unauthorized>`                                                                                                       |
| `get`     | `(id: string) => Effect<CredentialRef, Unavailable \| Unauthorized>`                                                                                                            |
| `create`  | `({ id, name, secret: Redacted<string> }) => Effect<CredentialRef, Unavailable \| Unauthorized \| CredentialConflict>`                                                          |
| `resolve` | `(reference: CredentialRef) => Effect<Redacted<string>, Unavailable \| Unauthorized \| PersistenceError>`                                                                       |
| `rotate`  | `(reference: CredentialRef, secret: Redacted<string>, options?: { expected? }) => Effect<CredentialRef, Unavailable \| Unauthorized \| CredentialConflict \| PersistenceError>` |
| `revoke`  | `(reference: CredentialRef) => Effect<void, Unavailable \| Unauthorized>`                                                                                                       |

`authorize` defaults to allowing every operation, which is correct for a
single-principal local process. A reference is authenticated on every
operation, so a forged or stale one is refused.

## CredentialStore

| Export                  | Kind            | Signature                                                      |
| ----------------------- | --------------- | -------------------------------------------------------------- |
| `SealedRecord`          | interface       | `{ id; name; ciphertext; nonce; version; updatedAtMs }`        |
| `Service`               | interface       | `{ list(); read(id); write(record); remove(id) }`              |
| `CredentialStore`       | class           | Key `/control/CredentialStore`                                 |
| `make`                  | function        | `(implementation: Service) => Service`                         |
| `makeMemory`            | function        | `() => Service`. Process-local and browser-safe.               |
| `layerMemory`           | layer           | `Layer<CredentialStore>`                                       |
| `makeNoop`, `layerNoop` | function, layer | Every operation fails `Unavailable`. Accept partial overrides. |

`write` commits `record` only if the stored version is `record.version - 1`,
and fails `CredentialConflict` otherwise. Plaintext never reaches this
boundary.

## CredentialCipher

| Export                  | Kind            | Signature                                                                          |
| ----------------------- | --------------- | ---------------------------------------------------------------------------------- |
| `Sealed`                | interface       | `{ ciphertext: string; nonce: string }`, both base64.                              |
| `Context`               | interface       | `{ id: string; name: string; version: number }`, the authenticated data.           |
| `Service`               | interface       | `{ seal(plaintext, context); open(sealed, context) }`                              |
| `CredentialCipher`      | class           | Key `/control/CredentialCipher`                                                    |
| `make`                  | function        | `(implementation: Service) => Service`                                             |
| `unavailable`           | function        | `() => Unavailable`, the typed failure a host reports with no secure key material. |
| `makeNoop`, `layerNoop` | function, layer | Every operation fails `Unavailable`. Accept partial overrides.                     |

## SqlCredentialStore

| Export    | Kind   | Signature                                                                        |
| --------- | ------ | -------------------------------------------------------------------------------- |
| `migrate` | effect | `Effect<void, Unavailable, SqlClient>`. Creates `control_credentials` if absent. |
| `make`    | effect | `Effect<CredentialStore.Service, Unavailable, DurableWriter \| SqlClient>`       |
| `layer`   | layer  | `Layer<CredentialStore, Unavailable, DurableWriter \| SqlClient>`                |

The read and the compare-and-set write run in one transaction, so two
concurrent rotations serialize.

## WebCryptoCipher

| Export    | Kind      | Signature                                                                             |
| --------- | --------- | ------------------------------------------------------------------------------------- |
| `Options` | interface | `{ key: Redacted<string> }`, 32 raw bytes base64-encoded.                             |
| `make`    | effect    | `(options: Options) => Effect<CredentialCipher.Service, Unavailable \| InvalidInput>` |
| `layer`   | layer     | `(options: Options) => Layer<CredentialCipher, Unavailable \| InvalidInput>`          |

AES-256-GCM over the Web Crypto API, which serves both Node and the browser.
The key is imported as a non-extractable `CryptoKey` and never reaches
`CredentialStore`. A host without Web Crypto fails with `Unavailable` rather
than a defect, and a key that is not 32 base64-encoded bytes fails with
`InvalidInput`. `open` fails with `PersistenceError` on operation
`credential.open` when the stored nonce is malformed or the ciphertext fails
authentication under this key and context.

## Migrations

| Export  | Kind          | Signature                                                             |
| ------- | ------------- | --------------------------------------------------------------------- |
| `set`   | migration set | Namespace `control`, at the migration id block after time travel.     |
| `run`   | effect        | Creates every durable control-plane and credential table.             |
| `layer` | layer         | Runs the migrations before exposing the database to control services. |

Hosts compose this set with the journal and run-store sets before opening a
shared control database. See
[Store control state in a database](./guides/durable-storage.md).

## SystemFlows

The reserved command-line verb to flow-id map the CLI projects.

| Export            | Kind      | Signature                                                                                                                                                       |
| ----------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SystemFlowEntry` | interface | `{ verb: string; flowId: "system/" template literal; projection: "procedure" \| "systemFlow"; deployClass: boolean; planBearing: boolean; plannable: boolean }` |
| `catalog`         | constant  | Every reserved verb, including the ones a runtime may not plan.                                                                                                 |
| `plannable`       | constant  | The entries a control runtime may offer as flows.                                                                                                               |

`plannable: false` means the row is command-line metadata and nothing else: the
verb is named so the binary can refuse it by name. `system/replay` is the case
that matters. It is in `catalog` and not in `plannable`, so a runtime that
offers `plannable` as its flow catalog refuses it at `plan` rather than minting
an approval card no `run` can honor.

Both runtimes default their flow catalog to `plannable`, so a composition that
builds its own map and the runtimes' defaults cannot disagree about which
reserved ids exist.

## test/TestControl

Importable only from `@smthrs/control/test/TestControl`.

| Export  | Signature                                                                                    |
| ------- | -------------------------------------------------------------------------------------------- |
| `layer` | `(options?: ControlRuntime.MemoryOptions, executor?: ControlExecutor.Service) => Layer<...>` |

Provides `Control` together with every collaborator it built: the deterministic
runtime, the in-memory journal bundle, a notification queue over that journal,
the executor (`ControlExecutor.makeNoop()` by default), and an empty registry.
Runtime flow metadata falls back to the reserved system catalog. See
[Test against the control plane](./guides/testing.md).
