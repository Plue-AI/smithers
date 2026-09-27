---
title: "Events, signals, and cursors"
description: "The normalized ExternalEvent, the reserved integration: signal namespace, name and correlation ladders, dedupe keys, and the polling cursor contract."
sidebar:
  order: 2
---

A webhook delivery and a long-poll update arrive in different shapes from
different providers. Both are decoded into one `Core.ExternalEvent` before
anything downstream sees them, so the control-plane binding is written once
rather than once per provider. This page explains that event, the namespace
it is named in, and the cursor contract that makes polling safe.

## The normalized event

One delivery decodes to one event:

| Field           | What it is                                                                    |
| --------------- | ----------------------------------------------------------------------------- |
| `source`        | The channel or source id that produced it, not the provider.                  |
| `eventName`     | `integration:<service>:<event>`, the most specific form the payload supports. |
| `correlationId` | What the event is about, or `null` when it addresses nothing narrower.        |
| `payload`       | The provider payload, as delivered.                                           |
| `dedupeKey`     | The provider's stable delivery identity, so a redelivery is recognizable.     |
| `receivedAtMs`  | When the event was received, in Unix milliseconds.                            |

`source` is the id of the channel or polling source, and every provider
follows that rule. A channel or source that is not named takes the provider
name, so one Linear channel produces `linear` and a second one named
`linear-secondary` produces `linear-secondary`. `Linear.Webhook.channel` and
`Telegram.Source.make` both stamp their own id,
so a listener can tell two installations or two bots apart without reading
the payload.

The schema refuses a name `Core.SignalName.eventName` could not have built,
such as one whose event segment carries a second colon. A name that reaches
persistence but that nothing can rebuild is a routing identity with no owner,
so it is rejected at the boundary instead.

## The reserved namespace

Every delivered event is named `integration:<service>:<event>`. Reserving the
`integration:` prefix keeps a workflow's own signal names from colliding with
delivered ones, and makes the origin of a signal readable in the journal
without a lookup.

The constructor and the parser are symmetric by design:
`Core.SignalName.eventName` builds a name from two segments it trims and
validates, and `Core.SignalName.parse` splits one back into its parts or
returns `null`. A name the constructor refuses to build parses as `null`
rather than becoming an identity nothing can reproduce. The `event` segment
may contain dots, which is how per-action variants are spelled
(`pull_request.opened`). `Core.SignalName.receivedBy` stamps the attribution
on a delivered signal: `integration:<service>`.

From the event, two outbound forms are derived. `toSignalPayload` produces
the control-plane signal, the name plus the payload. `toNotification`
produces a queued `system-event` notification: machine-originated events
queue rather than steer, so they reach the model when the run would
otherwise idle. Consecutive events about the same thing coalesce on
`<eventName>:<correlationId>`, so a burst of edits to one issue leaves one
pending notification carrying the newest payload. For the queue itself, see
[the notifications API](/api/notifications).

## Name and correlation ladders

Each provider also exposes the full ordered ladder its payload answers to,
most specific first, for a caller that routes on a broader form:

| Provider | Names                                                              | Correlations             |
| -------- | ------------------------------------------------------------------ | ------------------------ |
| Linear   | `integration:linear:issue.update`, then `integration:linear:issue` | `ENG-123`, `ENG`, `null` |

The decoded event carries the first rung of each ladder: the most specific
name and correlation the payload supports. The ladders are routing inputs,
not duplicate signals; 1.0 has no broadcast that would fan one delivery out
into every pair.

Telegram correlations name chats and threads directly: `chat:<id>` and
`chat:<id>:thread:<id>`. A message in a forum topic emits two events, one
chat-scoped and one thread-scoped, with distinct dedupe keys, so both a chat
listener and a thread listener wake and neither is double-signaled by one
redelivery.

## Dedupe keys

The `dedupeKey` is the provider's delivery identity folded into the event, so
a redelivery downstream is recognizable as the same event. Linear builds
it from `Linear-Delivery`, falling back to the webhook id, entity, action,
and timestamp when the header is absent. One derivation feeds both the
idempotency key and the dedupe key, so the two cannot come to disagree about
what "the same delivery" means.

Telegram dedupe keys carry the source id as a length prefix, because
`update_id` is scoped per bot: two configured sources routinely produce the
same number for unrelated updates, and an unscoped key would drop the second
bot's event as a duplicate. The length prefix means a source id containing
the delimiter cannot forge another source's key.

## The cursor contract

A polling source is only as safe as its cursor. `Core.CursorStore` persists
it: `layerMemory` keeps it for the life of the process, and `layerSql` keeps
it in the control database's `smithers_integration_cursors` table, over the
migration in `Core.Migrations`.

The contract that matters is ordering. Confirming an offset is what tells
Telegram to forget those updates, so a proposed cursor is committed only
after the batch it acknowledges has been handled. A process that dies
mid-batch re-polls that batch on restart instead of skipping it, and the
redelivery is dropped downstream on the event's dedupe key. The at-least-once
semantics are deliberate: the alternative, committing first, loses events
silently.

A stored cursor that does not parse as an offset fails the poll with
`invalid-config` rather than being dropped. Dropping it would send
`getUpdates` with no offset and replay Telegram's whole retained backlog as
if it were new. Unusable durable state is a failure, not a reason to start
over.
