---
title: "API reference"
description: "Every public export of @smthrs/notifications: the queue service and its layers, the notification and event schemas, the pure state machine, the steering vocabulary, and the alert policy."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/notifications/docs/api.md"
---

Every module is importable as a namespace from the root entry point and from its
own subpath:

```ts
import { Alerts, Notification, NotificationQueue } from "@smthrs/notifications"
import * as SteerPayload from "@smthrs/notifications/SteerPayload"
```

Types written below as `Schema` are `effect` schemas; each one exports a value
and a type of the same name, and the type is the decoded form.

## Example

```ts
import { NotificationQueue } from "@smthrs/notifications"

const deliver = Effect.gen(function*() {
  const queue = yield* NotificationQueue.NotificationQueue
  const receipt = yield* queue.drain({
    runId: "run-1",
    targetLineageId: "run-1/root",
    boundary: "turn-1",
    wouldIdle: true
  })
  return receipt.notifications
}).pipe(Effect.provide(NotificationQueue.layer))
```

## NotificationQueue

Journal-backed durable admission and turn-boundary drain. Import from
`@smthrs/notifications/NotificationQueue`.

### Service

```ts
interface Service {
  readonly admit: (
    runId: string,
    notification: Notification.Notification
  ) => Effect.Effect<AdmissionReceipt, Journal.JournalError | NotificationError>
  readonly drain: (
    input: DrainInput
  ) => Effect.Effect<DrainReceipt, Journal.JournalError | NotificationError>
  readonly pending: (
    runId: string
  ) => Effect.Effect<ReadonlyArray<Notification.Notification>, Journal.JournalError | NotificationError>
}
```

| Method                       | What it does                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `admit(runId, notification)` | Decodes the notification, snapshots it, and records one admission decision for `runId`. Idempotent on `notification.id`.     |
| `drain(input)`               | Promotes what the boundary named by `input` may deliver, and records the promotion. First writer wins on the drain identity. |
| `pending(runId)`             | Returns the run's admitted but unpromoted notifications, in admission order, across every lineage.                           |

`NotificationQueue` is the service tag, a `Context.Service` under the key
`/notifications/NotificationQueue`.

New admissions persist a SHA-256 fingerprint of the validated notification's
canonical JSON before journal redaction. Identical retries return the committed
receipt even when redaction changed the stored payload. Different content still
fails with `notification_id_reused`, including changes to redacted fields.
Legacy admissions without a fingerprint compare against their persisted content;
original values removed by redaction cannot be recovered.

The journal-backed layers deeply freeze decoded notifications, including nested
payload objects and arrays, before `pending` or `drain` exposes them. Outputs
carry the persisted, possibly redacted content. Consumer mutation cannot change
later reads or drain receipts.

`admit` and `drain` may run inside an enclosing `journal.transact` while
standalone queue calls are pending. Both acquire the journal transaction before
the queue permit. Shared folds are published only after the enclosing commit.

The fold reads only Admitted/Promoted event types through `Journal.entries` and
keeps the last matching canonical sequence as its cursor. Unrelated run events
do not require decoding or advance that cursor. A compaction floor that passes
the cursor causes a conservative `JournalError(compacted)` refusal, including
for a warm queue. Deployments that compact active notification histories need
a queue-aware retention or checkpoint policy; the current production
compositions do not enable compaction.

Admission refuses objects or arrays at depth 256 with `notification_invalid`
and writes no row. The notification envelope is depth 0; its payload is
at depth 1. Cyclic payloads receive the same typed refusal.

### AdmissionReceipt

```ts
interface AdmissionReceipt {
  readonly notificationId: string
  readonly decision: NotificationState.AdmissionDecision
  readonly seq: number | undefined
  readonly duplicate: boolean
}
```

| Field            | Meaning                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `notificationId` | The `id` of the notification this receipt answers for.                                                                       |
| `decision`       | `admitted`, `coalesced`, or `rejected-full`. A caller MUST read it: `rejected-full` means the queue retained nothing.        |
| `seq`            | The journal sequence the admission committed at. Absent exactly when nothing was written, which today means `rejected-full`. |
| `duplicate`      | The id had already been admitted. `decision` and `seq` are read back from the committed record rather than recomputed.       |

### DrainInput

```ts
interface DrainInput {
  readonly runId: string
  readonly targetLineageId: string
  readonly boundary: string
  readonly wouldIdle: boolean
  readonly cutoffSeq?: number | undefined
}
```

| Field             | Meaning                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runId`           | The run whose journal holds the notifications.                                                                                                                |
| `targetLineageId` | The lineage this boundary belongs to. Notifications for other lineages are left pending.                                                                      |
| `boundary`        | The name of this safe point. With `runId` and `targetLineageId` it is the drain identity.                                                                     |
| `wouldIdle`       | Whether the run would have nothing to do if this boundary delivered nothing. When true and no steer was promoted, one queued notification is promoted.        |
| `cutoffSeq`       | The journal sequence that opened this turn. Steers admitted after it are held for the next boundary. Omitting it delivers everything pending for the lineage. |

### DrainReceipt

```ts
interface DrainReceipt {
  readonly notifications: ReadonlyArray<Notification.Notification>
  readonly boundary: string
  readonly duplicate: boolean
}
```

`notifications` are the ones the committed promotion record names, so two
processes draining one boundary report the same delivery. `duplicate` is true
when the boundary had already drained.

### NotificationError

```ts
class NotificationError extends Schema.TaggedError<NotificationError>()(
  "/notifications/NotificationError",
  {
    code: "notification_unavailable" | "notification_closed" | "notification_full" | "notification_id_reused" | "notification_invalid"
    message: string
    notificationId?: string
    path?: string
  }
) {}
```

| Field            | Meaning                                                                            |
| ---------------- | ---------------------------------------------------------------------------------- |
| `code`           | The stable half, and the one to branch on. Defaults to `notification_unavailable`. |
| `message`        | Human-readable detail. Never carries the offending value.                          |
| `notificationId` | The notification the failure is about, when one was readable.                      |
| `path`           | Dotted path of the offending field, for `notification_invalid`.                    |

| Code                       | Means                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `notification_unavailable` | The seam serves nothing, or the journal identity for a drain holds an event this queue did not write.                                     |
| `notification_closed`      | New public refusal code: this receiver has finished. Start a new request; retrying this message at the closed receiver cannot deliver it. |
| `notification_full`        | New public refusal code: nothing was retained. Retry the same notification after pending work drains.                                     |
| `notification_id_reused`   | A stable id was already admitted with different content. A producer bug, not a storage failure.                                           |
| `notification_invalid`     | The value is not a notification. `path` names the field that failed.                                                                      |

Storage failures surface as `Journal.JournalError` instead, so the two stay
distinguishable.

The queue's ordinary `admit` still returns its existing `rejected-full` receipt.
`Control.steer` and configured receivers expose that refusal as
`NotificationError(notification_full)` instead of acknowledging an undeliverable
message. Configured receiver policies can also emit `notification_closed`.
Existing notification error fields and older codes are unchanged. Consumers
with an exhaustive code union must add both new codes. The Control RPC error
union now carries this existing error class; update remote decoders together
with the server so they can decode these refusals.

### Constructors and layers

| Export      | Signature                                                                               | What it provides                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `make`      | `(implementation: Service) => Service`                                                  | The service, from an implementation of its three methods.                                                           |
| `makeNoop`  | `(overrides?: Partial<Service>) => Service`                                             | A service whose every method fails with `notification_unavailable`, except the ones `overrides` replaces.           |
| `layerNoop` | `(overrides?: Partial<Service>) => Layer<NotificationQueue>`                            | `makeNoop`, as a layer. Requires nothing.                                                                           |
| `layerWith` | `(options?: { capacity?: number }) => Layer<NotificationQueue, never, Journal.Journal>` | The journal-backed implementation at the given pending capacity, defaulting to `NotificationState.defaultCapacity`. |
| `layer`     | `Layer<NotificationQueue, never, Journal.Journal>`                                      | `layerWith()`: the journal-backed implementation at the default capacity.                                           |

Both journal-backed layers write through the journal's unfenced durable channel,
so `admit` and `drain` return only after the corresponding entry is committed.
The channel is unfenced on purpose: the notifying process owns no run, so there
is no ownership fence to hand over, and both records are first-writer-wins on
their own identity instead.

## Notification

The durable notification payloads and their admission classification. Import
from `@smthrs/notifications/Notification`.

### Schemas

| Export          | Shape                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `Provenance`    | `{ sourceRunId: string; sourceLineageId: string; sourceTurn: number; sourceActor: string }`. `sourceTurn` is an integer at or above zero. |
| `HumanSteer`    | Tagged `"human-steer"`. The common fields plus `delivery: "steer"`.                                                                       |
| `HumanFollowup` | Tagged `"human-followup"`. The common fields plus `delivery: "queue"`.                                                                    |
| `SystemEvent`   | Tagged `"system-event"`. The common fields plus `delivery: "queue"` and an optional `coalescingKey: string`.                              |
| `Notification`  | The union of the three.                                                                                                                   |

The common fields on every member are `id` (a non-empty string, and the caller's
idempotency key), `targetLineageId` (a non-empty string), `provenance`, and
`payload` (any JSON value).

Provenance travels with the notification because the run that receives one is
not the run that wrote it. An operator steer, a parent run's event, and a webhook
all arrive on the same queue, and only these fields say which is which after the
fact.

### Functions

| Export           | Signature                                            | Returns                                                                                                                                          |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `admissionClass` | `(notification: Notification) => "steer" \| "queue"` | How the notification is allowed to reach the model. Steers are promoted in a batch at turn close; queued notifications one at a time at idle.    |
| `coalesceKey`    | `(notification: Notification) => string \| null`     | The key the notification coalesces on, or `null` when it must never coalesce. Only a `system-event` that declares a `coalescingKey` returns one. |

## NotificationState

The pure bounded queue: the same rules with no I/O and no journal. Import from
`@smthrs/notifications/NotificationState`.

### Models

| Export              | Shape                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `defaultCapacity`   | `128`. The default maximum pending notifications per run.                                                |
| `Pending`           | `{ notification: Notification; seq: number }`. `seq` is the journal sequence the admission committed at. |
| `State`             | `{ capacity: number; items: ReadonlyArray<Pending> }`. Frozen, and every transition returns a new value. |
| `Admission`         | `{ state: State; decision: AdmissionDecision }`.                                                         |
| `Promotion`         | `{ state: State; promoted: ReadonlyArray<Pending> }`.                                                    |
| `AdmissionDecision` | Re-exported from `NotificationEvent`, which owns the single declaration.                                 |

### Operations

| Export           | Signature                                                                                           | What it does                                                                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `empty`          | `(capacity: number) => State`                                                                       | An empty queue. A capacity that is not a finite number becomes zero, so a misconfigured bound refuses everything rather than retaining an unbounded backlog.                                   |
| `admit`          | `(state: State, notification: Notification, seq: number) => Admission`                              | Admits, coalescing only pending system events with the same key, and keeping the first sequence so replay order stays stable. A queue at capacity decides `rejected-full` and retains nothing. |
| `applyAdmission` | `(state: State, notification: Notification, seq: number, decision: AdmissionDecision) => State`     | Applies a decision already committed in a journal record. Replay never re-decides.                                                                                                             |
| `pending`        | `(state: State, admission: "steer" \| "queue", targetLineageId?: string) => ReadonlyArray<Pending>` | Still-pending notifications of one admission class, in durable journal order, for one lineage or for every lineage.                                                                            |
| `promoteSteers`  | `(state: State, cutoffSeq: number, targetLineageId?: string) => Promotion`                          | Promotes every steer admitted at or before the cutoff. Notifications admitted after it remain pending.                                                                                         |
| `promoteQueued`  | `(state: State, targetLineageId?: string) => Promotion`                                             | Promotes exactly the oldest pending queued notification, or nothing.                                                                                                                           |
| `applyPromoted`  | `(state: State, ids: ReadonlyArray<string>) => State`                                               | Removes the ids a durable promotion record names, while replaying history.                                                                                                                     |

## NotificationEvent

The journal event types this package owns. Import from
`@smthrs/notifications/NotificationEvent`.

| Export              | Value or shape                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `AdmittedEventType` | `"flows/notifications/Admitted"`. Frozen: the value is already durable in every journal this package has written to. |
| `PromotedEventType` | `"flows/notifications/Promoted"`. Frozen for the same reason.                                                        |
| `AdmissionDecision` | `"admitted" \| "coalesced" \| "rejected-full"`. The one declaration of the admission vocabulary.                     |
| `Admitted`          | `{ notification: Notification; decision: AdmissionDecision; fingerprint?: string }`.                                 |
| `Promoted`          | `{ boundary: string; targetLineageId: string; ids: ReadonlyArray<string> }`.                                         |
| `Event`             | `Admitted \| Promoted`.                                                                                              |

A `rejected-full` decision is never written. The queue refuses a full queue in
the receipt alone, so the notification id stays admissible once a boundary
drains. The literal remains in `AdmissionDecision` because a reader must stay
total over a record any writer could have produced.

| Export       | Signature                                             | Returns                                                                                                                                                      |
| ------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `isAdmitted` | `(event: Event) => event is Admitted`                 | Whether the owned event is an admission record.                                                                                                              |
| `isPromoted` | `(event: Event) => event is Promoted`                 | Whether the owned event is a promotion record.                                                                                                               |
| `fromEntry`  | `(entry: JournalEvent.Entry) => Option.Option<Event>` | The owned event a journal entry carries. Foreign entries and structurally invalid payloads answer `None`, so a projection over a shared journal stays total. |

## Projection

Import from `@smthrs/notifications/Projection`.

| Export   | Signature                                     | What it does                                                                                                            |
| -------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `derive` | `Journal.Projection<NotificationState.State>` | Re-derives pending notifications from admitted and promoted journal entries. Foreign entries leave the state unchanged. |

The projection starts at `NotificationState.empty(NotificationState.defaultCapacity)`.
Capacity gates new admissions; it does not truncate replay. `applyAdmission`
applies the decision each record committed, so a composition built with
`NotificationQueue.layerWith` above the default replays every admission it
wrote. The projected `capacity` stays at the default because no journal record
carries the bound the layer was built at, so read `items` rather than
`capacity`.

## SteerPayload

The steering vocabulary carried inside a notification payload. Import from
`@smthrs/notifications/SteerPayload`.

The vocabulary lives here rather than in either package that uses it: a control
plane admits a steer and a harness drains it, and neither may depend on the
other, so the shape they have to agree on belongs beneath both.

| Export            | Shape                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Thinking`        | `"none" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh"`. A subset of `ModelRequest.ReasoningEffort` in [`@smthrs/model`](https://model.smithers.sh/reference/api/), which also admits `"max"`; this package deliberately does not depend on it. |
| `MessagePayload`  | `{ kind: "Message"; body: string }`. The body may be empty.                                                                                                                                                               |
| `SeatPayload`     | `{ kind: "Seat"; seat: string }`. `seat` is non-empty.                                                                                                                                                                    |
| `ThinkingPayload` | `{ kind: "Thinking"; thinking: Thinking }`.                                                                                                                                                                               |
| `ToolsPayload`    | `{ kind: "Tools"; toolNames: ReadonlyArray<string> }`. Non-empty, of non-empty strings. Additive only: steering can widen the active tool set and cannot narrow it.                                                       |
| `SteerPayload`    | The union of the four.                                                                                                                                                                                                    |

| Export   | Signature                                         | Returns                                                                                                                                                                                       |
| -------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decode` | `(payload: unknown) => SteerPayload \| undefined` | The steering item a stored payload carries, or `undefined` when it is not one. A record with a `body` string and no `kind` reads as a message.                                                |
| `encode` | `(item: SteerPayload) => SteerPayload`            | The record the item is stored as. Every item is written with its `kind`, including a message. The result is assignable to `Notification.payload` and shares no mutable structure with `item`. |

## Alerts

Run conditions that have lasted too long, turned into durable, coalesced,
delivered-once notifications. Import from `@smthrs/notifications/Alerts`.

### Policy

| Export             | Shape                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Severity`         | `"info" \| "warning" \| "critical"`.                                                                                                                                                                         |
| `Detector`         | `{ field: string; value: string; eventTypes?: ReadonlyArray<string> }`. `field` names a payload key, `value` the value that means the condition holds, and `eventTypes` narrows which entries are consulted. |
| `Rule`             | `{ afterMs: number; severity?: Severity; owner?: string; runbook?: string }`. `afterMs` is a whole, non-negative number of milliseconds.                                                                     |
| `Policy`           | `{ defaults?: { severity?; owner?; runbook? }; rules: Record<string, Rule>; detectors?: Record<string, Detector> }`.                                                                                         |
| `defaultDetectors` | `Readonly<Record<string, Detector>>`: `waiting-approval` and `failed` on `status`, `stalled` on `health`, `quota-parked` on `waitingReason`.                                                                 |

An entry that carries a detector's field with the matching value opens the
condition; an entry that carries it with any other value closes it. A policy's
own `detectors` are merged over `defaultDetectors`.

### Decisions

| Export  | Shape                                                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Open`  | `{ runId: string; condition: string; since: number }`. `since` is the journal time of the entry that opened the condition.                                         |
| `Alert` | `{ runId; condition; since; firedAt; severity; coalescingKey; owner?; runbook? }`. `firedAt` is `since + afterMs`, never the wall clock of whichever tick noticed. |

| Export          | Signature                                                                                            | Returns                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conditions`    | `(policy: Policy, runId: string, entries: ReadonlyArray<JournalEvent.Entry>) => ReadonlyArray<Open>` | Every condition a run's journal leaves open, with the time each opened. `entries` are oldest first.                                                                   |
| `decide`        | `(policy: Policy, open: ReadonlyArray<Open>, now: number) => ReadonlyArray<Alert>`                   | The alerts the policy raises for the conditions open at `now`. Pure: `now` decides whether an alert is raised and never appears in one.                               |
| `coalescingKey` | `(runId: string, condition: string) => string`                                                       | The key an alert coalesces on: one open condition on one run. Each component is percent-encoded, so neither can forge another pair's key.                             |
| `alertId`       | `(alert: Pick<Alert, "coalescingKey" \| "since">) => string`                                         | `alert:<coalescingKey>:<since>`. The identity a delivery is recorded under, stable for the life of one condition. A condition that clears and re-opens gets a new id. |

### Sinks

| Export                  | Signature                                                                                                  | What it is                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SinkService`           | `{ deliver: (alert: Alert) => Effect.Effect<void, AlertError> }`                                           | Where a raised alert is sent. `deliver` MUST be idempotent on `alertId(alert)`, and MUST fail when the page did not go out.                                                                                                                                                                                                                                                     |
| `Sink`                  | `Context.Service` under `/notifications/AlertSink`                                                         | The service tag.                                                                                                                                                                                                                                                                                                                                                                |
| `layerNoop`             | `Layer<Sink>`                                                                                              | Accepts every alert and sends it nowhere. The admission and the delivery record still happen.                                                                                                                                                                                                                                                                                   |
| `defaultWebhookTimeout` | `Duration.Duration`                                                                                        | Ten seconds.                                                                                                                                                                                                                                                                                                                                                                    |
| `layerWebhook`          | `(options: { url: string; headers?: Record<string, string>; timeout?: Duration.Duration }) => Layer<Sink>` | POSTs each alert to one webhook using an owned Fetch client with redirects disabled and a scope per delivery. Injected `HttpClient` layers are not used. The body is the alert plus its `alertId`, and the same id is sent as an `Idempotency-Key` header, set after the caller's headers. A non-2xx answer is a failure; an endpoint that never answers fails after `timeout`. |

| Export        | Shape                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| `FailureCode` | `"sink_rejected" \| "sink_unreachable" \| "sink_timeout" \| "sink_misconfigured"`.                              |
| `AlertError`  | Tagged `/notifications/AlertError`: `{ code: FailureCode; message: string; status?: number; reason?: string }`. |

`sink_misconfigured` is the one code no alert ever carries. `layerWebhook`
validates its `url` while the layer is built, before any alert exists, and a url
that is not an absolute `http:` or `https:` one dies there rather than failing
through the delivery channel: a scheme bound is what keeps a credential set in
`headers` from being handed to something that is not HTTP.

`AlertError` deliberately holds no request. A webhook request carries the
credential the deployment handed `layerWebhook`, and an error is logged, encoded,
and journaled in places a credential must never reach.

### Runtime

| Export           | Shape                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `Tick`           | `{ delivered; failed; refused; suppressed }`, each a `ReadonlyArray<Alert>`.                   |
| `RuntimeService` | `{ tick: (runId: string) => Effect.Effect<Tick, Journal.JournalError \| NotificationError> }`. |
| `AlertRuntime`   | `Context.Service` under `/notifications/AlertRuntime`. The service tag.                        |

| Field of `Tick` | Meaning                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `delivered`     | Raised and accepted by the sink on this tick.                                                           |
| `failed`        | The sink refused them. Retried on the next tick.                                                        |
| `refused`       | The notification queue was at capacity. The sink was not called, and they are retried on the next tick. |
| `suppressed`    | Already delivered, and not delivered again.                                                             |

| Export  | Signature                                                                                      | What it provides                                                                                                                                    |
| ------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layer` | `(policy: Policy) => Layer<AlertRuntime, never, Journal.Journal \| NotificationQueue \| Sink>` | The alert runtime over one policy. The policy is decoded when the layer is built, so a rule with an impossible delay fails the composition by name. |

| Export               | Value                                                                              |
| -------------------- | ---------------------------------------------------------------------------------- |
| `deliveredEventType` | `"flows.alerts.delivered"`. One entry per delivered alert.                         |
| `failedEventType`    | `"flows.alerts.failed"`. One entry per alert per failure code, never one per tick. |

A tick admits the alert, sends it, then journals the delivery. Admission is
idempotent and the send is not, so a crash between the first two costs a
duplicate admission the queue drops, while a crash between an accepted send and
the delivery record costs a duplicate page. That is why `deliver` is required to
deduplicate on `alertId`.

Both owned event types are excluded from condition detection: they are written
into the journal the detectors read, and they carry the alert's own vocabulary,
so reading them as evidence would let a page close the condition it paged about.

See [`@smthrs/control`](https://control.smithers.sh/reference/api/) for the run conditions the entries come
from.
