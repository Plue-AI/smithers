---
title: "How alerting decides"
description: "Why an alert is a function of journal time rather than wall time, how a detector opens and closes a condition, and why delivery is at-least-once rather than exactly-once."
sidebar:
  order: 3
---

The queue answers "tell this run something". An alert answers the question
nobody is around to ask: a run has been waiting an hour for an approval, and the
person who could grant it does not know.

The two are the same machinery. An alert is admitted as a coalesced system event
on the same durable queue, under the same idempotency and the same bound. They
differ only in who decides to write one.

## A condition is a payload field with a value

`Alerts.Detector` names a payload key, the value that means the condition holds,
and optionally the event types worth consulting at all:

```ts
import { Alerts } from "@smthrs/notifications"

const detector: Alerts.Detector = { field: "status", value: "waiting-approval" }
```

An entry that carries the field with the matching value **opens** the condition,
if it is not open already. An entry that carries the field with any other value
**closes** it. That symmetry is why a resume clears an approval alert without a
second vocabulary for "cleared": the run's next status entry says something
else, and the condition is gone.

An entry that does not carry the field at all is ignored entirely, which is what
stops a health report from closing an approval wait. `eventTypes` narrows
further, for a field two different producers write under different meanings. An
item ending in `.*`, such as `control.*`, names every event type with that
prefix.

`Alerts.defaultDetectors` ships four conditions, each of them one field and one
value: `waiting-approval` and `failed` read `status`, `stalled` reads `health`,
and `quota-parked` reads `waitingReason` for `quota`. Those are the fields
[`@smthrs/control`](/api/control) writes, and each default consults only the
`control.*` event types: a flow step or agent trace that writes a `status` field
into the same run's journal neither opens nor closes a default condition. A policy's own `detectors` are merged
over them, so a deployment that journals a different vocabulary names its own
rather than forking the module.

Only a condition the policy has a rule for is watched at all, and only own
properties count: a detector named `toString` reads no evidence off
`Object.prototype`.

## Journal time, not wall time

A condition's clock starts at `emittedAtMs` of the entry that opened it.
`Alerts.decide(policy, open, now)` compares that against the rule's `afterMs`,
and the alert it produces is stamped `firedAt: since + afterMs`.

`now` decides **whether** an alert is raised. It never appears in one. The same
journal therefore raises the same alerts in any process, at any instant past the
delay, and a tick that runs an hour late produces the byte-identical alert the
on-time tick would have.

That is not a stylistic choice. Retries re-admit the same alert id, and the
queue refuses a reused id whose content changed. An alert stamped with the
reading time would become permanently undeliverable the moment one tick was
refused and time moved on.

## The delay is the policy

`Alerts.Rule.afterMs` is how long a condition must last before it is worth
paging about. Most stalls clear themselves, and a policy that fired immediately
would page on every one of them. `afterMs` is a whole, non-negative number of
milliseconds, checked by the schema when `Alerts.layer` builds, so an impossible
delay fails the composition by name instead of mis-paging at 3am.

## Delivery is at-least-once

One tick, for each alert past its delay that has not already been delivered:

1. Admits the alert to the notification queue as a coalesced system event.
2. Calls `Alerts.SinkService.deliver`.
3. Journals `flows.alerts.delivered` once the sink accepted it.

The order is deliberate. Admission is idempotent, so a crash between steps 1 and
2 costs a duplicate admission the queue drops. Recording the delivery before the
send would turn a crash into a page nobody ever receives, which for an alert is
the worse failure.

The cost of that choice is a duplicate page: a process that dies between an
accepted send and the delivery record pages again on the next tick. So the sink
owns the last mile. `deliver` must be idempotent on `Alerts.alertId(alert)`,
which is `alert:<coalescingKey>:<since>` and stable for the life of one
condition. A condition that clears and re-opens gets a new id, because the second
approval wait is not the first one.

## Four outcomes, and only one is a failure

`Alerts.Tick` sorts every alert the tick considered:

| Field        | What it means                                                        |
| ------------ | -------------------------------------------------------------------- |
| `delivered`  | The sink accepted the page, and `flows.alerts.delivered` records it. |
| `suppressed` | A delivery record already exists. The sink was not called.           |
| `failed`     | The sink refused or could not be reached. Retried on the next tick.  |
| `refused`    | The notification queue was at capacity. The sink was not called.     |

A refused page is not a delivered page, so it is retried. A refusal from the
queue pages nobody at all: the alert has nowhere durable to sit, and paging
about something the run will never read would send an operator looking in the
wrong place.

Both non-delivery outcomes journal `flows.alerts.failed`, one record per alert
per failure code, never one per tick. A webhook that stays down for an hour
leaves one row rather than a hundred and twenty every later tick has to read
past.

## The alerter never reads its own records

`flows.alerts.delivered` and `flows.alerts.failed` are written into the same
journal the detectors read. They carry the alert's own vocabulary: a refusal
reports the answering HTTP `status`, which a detector watching the run's
`status` would read as the condition clearing. So both event types are excluded
from condition detection outright. Without that exclusion, a page would close the
condition it paged about, the next tick would re-open it, and a webhook that
answered 503 once would alert forever.

A delivery record suppresses a repeat page only under the source the alerter
writes it with, `/notifications/alerts/<alertId>/delivered`. Another writer to
the run's journal can name the same `alertId`, and its record is ignored.

## Next

- [Alert on a stuck run](../guides/alert-on-a-stuck-run.md): a policy, a tick,
  and what each field of the result means.
- [Send alerts to a webhook](../guides/send-alerts-to-a-webhook.md): the shipped
  sink, its idempotency header, and its timeout.
