---
title: "Events, signals, and cursors"
description: "Shared integration identity, deduplication, and durable acknowledgement."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/integrations/docs/concepts/events-and-signals.md"
---

`Core.ExternalEvent` normalizes a source, event name, correlation, JSON payload,
dedupe key, and receipt time. `Core.SignalName` builds and validates the
`integration:<source>:<event>` namespace. A source names its own identity;
the host chooses which flow starts or which waiting run receives a signal.

`RawInbound.idempotencyKey` identifies the delivery across redelivery. Stable
provider identities prevent duplicate dispatch. Never derive it from receipt
time or omit it when a provider may redeliver.

`Core.CursorStore` retains a source's committed position. Commit a proposed
cursor only after the batch it acknowledges has been handled. Storage and
migrations remain independent of a provider adapter.
