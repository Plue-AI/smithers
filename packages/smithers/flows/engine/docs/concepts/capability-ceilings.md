---
title: "Capability ceilings"
description: "Authority across execution, recovery, caching, and placement."
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

Remote execution and resume under restricted authority fail before connecting
with `FlowEngine.RemoteCapabilityCeilingUnsupported`, a defect carrying
`flowName` and `message`. The current remote protocol cannot preserve caller
ceilings. Run locally when either caller or flow is restricted. Remote execution
requires unrestricted caller authority and an omitted or `["*"]` flow ceiling. Remote
cancellation remains available under restricted authority.
