---
title: "Troubleshooting"
description: "The failures @smthrs/notifications reports and the silent ones it does not: what each symptom means, what causes it, and what to change."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/notifications/docs/troubleshooting.md"
---

## A notification never reaches the run, and nothing failed

**Symptom.** `admit` returned successfully. The run drains and never sees the
notification, and no error was raised anywhere.

**Cause.** `AdmissionReceipt.decision` was `rejected-full`. The run already held
its capacity of pending notifications, so the queue retained nothing and wrote
no journal entry. `admit` does not fail on a full queue.

**Fix.** Read `receipt.decision` on every call. Retry the identical notification
once a boundary has drained: the id was never burned. See
[Handle a full queue](/guides/handle-a-full-queue/).

## notification_id_reused: already admitted with different content

**Symptom.** `NotificationError` with `code: "notification_id_reused"` and a
message naming the id.

**Cause.** The same `id` was admitted earlier with different content. The
comparison is on a canonical rendering, with keys sorted and absent values
dropped, so field order is not the difference; something in the payload,
provenance, delivery, or lineage changed.

**Fix.** Decide which one you mean. A retry of the same instruction sends the
identical value. A different instruction gets a different id.

The common source is a value that varies with time. An alert stamped with the
reading clock instead of journal time changes between ticks, and becomes
permanently undeliverable the moment one tick is refused. Every field of an
`Alerts.Alert` is derived from the journal for exactly this reason; keep your own
notifications the same way.

## notification_id_reused: the journal identity holds an event this queue did not write

**Symptom.** The message says the journal identity for a notification holds an
event this queue did not write.

**Cause.** Something else committed under the source id
`/notifications/admission/<id>` for that run. The emit deduplicated against it,
so nothing of yours was written and there is no admission to report.

**Fix.** Find the other writer. A second component journaling under this
package's source-id namespace is the defect; the queue refuses to invent an
admission rather than reporting one that does not exist.

## notification_invalid, with a path

**Symptom.** `NotificationError` with `code: "notification_invalid"` and a
`path` such as `provenance.sourceTurn` or `id`.

**Cause.** The value is not a `Notification.Notification`. `admit` decodes at the
durability boundary, before anything is journaled, because a structurally invalid
notification that reached the journal would be acknowledged at a real sequence
and then skipped by every replay.

Common failures:

| Field                   | What is wrong                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `id`                    | Empty, or not a string. The id is the idempotency key and must be a non-empty string. |
| `targetLineageId`       | Empty, or not a string.                                                               |
| `provenance.sourceTurn` | Not an integer, or below zero. Reported as `path: "provenance.sourceTurn"`.           |
| `payload`               | Not JSON. A function or a symbol anywhere inside it fails with `path: "payload"`.     |

**Fix.** Correct the field `path` names. Neither the message nor `path` carries
the offending value, on purpose: a refusal is logged and journaled in places the
value must not reach.

Two fields can be absent from the error. `path` is absent when the value did not
match any member of the union closely enough to name one field, and
`notificationId` is absent when the value carries no readable string `id`, which
is the honest answer rather than an invented one.

## notification_invalid: nests deeper than the 256 level bound

**Symptom.** The message names a depth bound.

**Cause.** The payload nests past 256 levels, or contains a cycle. A cycle has no
finite depth, so it trips the same bound rather than looping forever.

**Fix.** Flatten the payload. The bound exists because the value is walked and
serialized on the way to the journal, and an unbounded walk turns a hostile
payload into an untyped `RangeError` instead of a refusal a caller can read.

## notification_invalid: larger than the 1048576 code unit bound

**Symptom.** The message names a code unit bound.

**Cause.** The notification is larger than 1,048,576 UTF-16 code units, counting
every string and object key at its length and every other value as one.

**Fix.** Store the large content elsewhere and put a reference in the payload.
The bound is checked before the notification is copied, decoded, fingerprinted,
or journaled, so an oversized payload costs the notifying process no more than
the bound.

## notification_unavailable

**Symptom.** Every call fails with `code: "notification_unavailable"` and a
message like `admit is unavailable`.

**Cause.** The composition provided `NotificationQueue.layerNoop()` or
`makeNoop()`. That is the explicit absence: a seam that is present and serves
nothing.

**Fix.** Provide `NotificationQueue.layer` and a `Journal.Journal`. If the noop
is deliberate, handle the failure: a run listing that annotates pending counts
should catch `/notifications/NotificationError` and leave the field absent
rather than reporting zero. See
[Report what a run is waiting on](/guides/report-pending-notifications/).

The same code also reports that the journal identity for a drain boundary holds
an event this queue did not write, which has the same cause and fix as the
admission case above.

## A steer stays pending across several boundaries

**Symptom.** `pending` keeps returning the notification; `drain` keeps returning
nothing.

**Causes, in the order worth checking:**

1. **The lineage does not match.** `drain` promotes only notifications whose
   `targetLineageId` equals `DrainInput.targetLineageId`. A child lineage
   draining under the parent's id leaves its own notifications untouched.
2. **The cutoff excludes it.** `cutoffSeq` is the sequence that opened the turn.
   A steer admitted after it is held until the next boundary. That is correct
   behavior once; if it repeats, the caller is passing a stale cutoff.
3. **The boundary name repeats.** The drain identity is
   `(runId, targetLineageId, boundary)`, and the first record committed for it is
   the delivery. Draining the same boundary name again reports that record with
   `duplicate: true` and promotes nothing new. Give each boundary its own name.

## A follow-up is never delivered

**Symptom.** A `human-followup` or a `system-event` stays pending while steers
flow through.

**Cause.** A queued notification is promoted only when `DrainInput.wouldIdle` is
true and the same boundary promoted no steer. A run that always has work, or a
caller that always passes `wouldIdle: false`, never reaches that case.

**Fix.** Pass the run's real idleness. If the notification must not wait for
idleness, admit it as a `human-steer` instead.

## Two system events became one

**Symptom.** An earlier event's payload was replaced, and the receipt said
`coalesced`.

**Cause.** Both are `system-event` values sharing a `coalescingKey`, and the
first is still pending. That is the design: ten updates about one condition are
one pending notification carrying the latest of them.

**Fix.** Drop the `coalescingKey` for events that must not collapse. A
`human-followup` never coalesces, whatever it carries.

## A drain returns the same notifications twice

**Symptom.** `drain` answers with notifications the run already handled, and
`duplicate` is true.

**Cause.** The boundary had already drained. The receipt is read back from the
committed promotion record, so two processes draining one boundary report the
same delivery rather than two divergent guesses.

**Fix.** Branch on `DrainReceipt.duplicate`. A resumed run walks its boundaries
until one answers `duplicate: false`, which is the first it has not consulted.

## An alert never fires

**Symptom.** The condition is visibly true in the journal, and `tick` returns
empty arrays.

**Causes, in the order worth checking:**

1. **No rule.** Only conditions named in `Policy.rules` are watched at all.
2. **No detector.** A rule whose condition is in neither `defaultDetectors` nor
   the policy's own `detectors` raises nothing.
3. **`eventTypes` excludes the entry.** A detector that names event types
   consults no others. Every default detector consults only `control.*`.
4. **The payload is not a record.** An entry whose payload is a string, an array,
   or `null` is skipped.
5. **The delay has not elapsed.** `decide` compares `now` against
   `since + afterMs`, both in journal time.
6. **It already fired.** A delivered alert comes back in `Tick.suppressed`, not
   `Tick.delivered`.

## An alert pages twice about one condition

**Symptom.** The receiving system shows two pages with the same `alertId`.

**Cause.** Delivery is at-least-once. A process that dies between an accepted
send and the `flows.alerts.delivered` record pages again on the next tick. The
alternative, recording the delivery first, turns the same crash into a page
nobody receives.

**Fix.** Deduplicate in the sink on `Alerts.alertId(alert)`. The webhook sink
sends it as an `Idempotency-Key` header and in the body for exactly this. See
[Send alerts to a webhook](/guides/send-alerts-to-a-webhook/).

## An alert re-fires after the condition cleared and came back

**Symptom.** A second page about the same run and condition.

**Cause.** This is correct. `alertId` includes the opening time, so a condition
that clears and re-opens is a new alert. The second approval wait is not the
first one, and an id without the time would suppress it forever.

## The alert runtime dies when the layer builds

**Symptom.** Building `Alerts.layer(policy)` fails the composition rather than
returning a runtime.

**Cause.** The policy did not decode. `afterMs` must be a whole number at or
above zero: a `NaN` delay would fire on the first tick and stamp a `firedAt`
that JSON writes as `null`, and a negative one would fire with a `firedAt`
earlier than the condition it describes.

**Fix.** Correct the rule. Failing at composition time is deliberate: the
alternative is mis-paging at 3am.

## The projection reports a capacity the run was not built at

**Symptom.** A composition built with `NotificationQueue.layerWith({ capacity:
512 })` projects a state whose `capacity` is 128.

**Cause.** `Projection.derive` starts at
`NotificationState.empty(NotificationState.defaultCapacity)`, and no journal
record carries the bound the layer was built at, so replay has nothing to
restore it from.

**Fix.** Read `items` rather than `capacity`. Replay never re-decides: an
admitted record is retained whatever the projected bound says, so the projection
reports every pending notification a raised-capacity run holds. See
[the journal records](/concepts/journal-records/).

## Mutating a notification after admitting it changes nothing

**Symptom.** A field edited on the object after the call does not appear in the
journal or in a later drain.

**Cause.** `admit` decodes and structurally copies its argument at the durability
boundary, and journals the snapshot. `SteerPayload.encode` does the same for the
record it returns.

**Fix.** Nothing to fix. Build the value fully before admitting it; a queue whose
durable record could change after the call returned would be a queue that cannot
promise what it wrote.
