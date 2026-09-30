---
title: "Capability ceilings"
description: "Authority across execution, recovery, caching, and placement."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine/docs/concepts/capability-ceilings.md"
---

Omitted capability declarations inherit authority; explicit empty declarations
deny guarded operations. The engine intersects each declaration with its callers
and persists admission authority for recovery. A join answers the result the
admitted authority produced, so a caller joins an existing execution ID only when
its ceiling covers the admitted one; otherwise both engines die with
`FlowEngine.ExecutionIdentityConflict` on field `capabilities`. Cross-run cache keys include the
effective authority for both string and object idempotency keys.

Existing durable executions without persisted authority refuse further dispatch.
Inspect their completed effects before starting replacement work; automatically
re-keying an old action could repeat it.

Remote execution, discard, and resume carry the caller's ceiling, narrowed by
the flow's own declaration, as `capabilityCeilings` on the `FlowProxy` request.
The serving engine intersects it with its own authority before admission, so a
request can only narrow what the serving host already allows. The serving engine
persists, recovers, and joins under that authority exactly as a local run does.
A request with no `capabilityCeilings` is bounded by the serving host alone.
A request carries at most `FlowProxy.maxCeilingGroups` groups of at most
`FlowProxy.maxCeilingPatterns` patterns. A refused join crosses the wire as the
serving engine's `FlowHandlerDefect`. Remote cancellation carries no ceiling: it
can only stop work.
