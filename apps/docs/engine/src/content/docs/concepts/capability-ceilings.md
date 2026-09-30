---
title: "Capability ceilings"
description: "Authority across execution, recovery, caching, and placement."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine/docs/concepts/capability-ceilings.md"
---

Omitted capability declarations inherit authority; explicit empty declarations
deny guarded operations. The engine intersects each declaration with its callers
and persists admission authority for recovery. Joining, polling, or
resuming an existing execution ID answers or drives what the admitted authority
produced, so each requires the caller's ceiling, narrowed by the flow's current
declaration, to provably cover the authority the execution recorded
(`FlowEngine.joinable`). A declaration narrowed since admission does not reopen
a wider result. Otherwise both engines die with
`FlowEngine.ExecutionIdentityConflict` on field `capabilities`. A handoff
successor records its own declaration when this process registers it. Cross-run cache keys include the
effective authority for both string and object idempotency keys.

The ceiling current where an engine is built (`FlowEngine.layerMemory` or
`EngineStore.make`) is its host ceiling. Every execute, poll, and resume the
engine answers runs under it, so admission records it with the caller's ceiling
and the declaration, and each join compares under it. A caller in a wider
context cannot record wider authority than the host allows, and a replacement
engine built under a narrower host refuses a wider execution recorded earlier.

Existing durable executions without persisted authority refuse further dispatch;
only an unrestricted caller of an unrestricted engine joins or polls them.
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
