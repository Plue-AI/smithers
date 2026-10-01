---
title: "Execution identity"
description: "How the engine decides which run a submission belongs to: caller-supplied execution ids, the joins they make idempotent, the reuses it refuses, and how poll, interrupt, and resume treat an id they do not know."
sidebar:
  order: 2
---

`executionId` is caller-supplied identity, not a handle the server mints. That
one decision explains most of the engine's admission behavior.

## A repeated id joins

A submission that names an id an execution already owns joins that run and
answers with its recorded result. It does not start a second run. This is what
makes a retried submission idempotent: a client that times out, a proxy that
replays a request, and a sweep that resubmits all converge on one execution.

Joining works whether the run is finished or still going. A duplicate submit of
an in-flight id waits on the body that is already running.

When a caller supplies no id, a declared `idempotencyKey` selects intentional
reattachment. Otherwise the ambient source defaults to a fresh UUID, so equal
unkeyed payloads start independent executions. `Flow.layerExecutionIds(Flow.derived)`
explicitly restores deterministic payload identity for hosts that require it.
After a crash, use a captured execution id or an explicit key to reattach; another
unkeyed `execute` call starts new work. Historical id encodings are unchanged.

## Conflicting reuses are refused

Answering a caller with a run it did not ask for is worse than failing it, so
conflicting reuses fail from `Flow.execute` with typed `ExecutionIdentityConflict`:

| `field`     | The reuse                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `"flow"`    | The id already belongs to a different flow declaration. Answering would hand one flow's value to another flow's schemas. |
| `"payload"` | The id already belongs to a different payload. The recorded result answers the first payload's question, not this one's. |
| `"lineage"` | A durable row with the id belongs to another trampoline lineage.                                                         |
| `"round"`   | A durable row with the id belongs to another round ordinal.                                                              |
| `"parent"`  | A durable row with the id belongs to another predecessor round.                                                          |

For JSON-encodable payloads, `layerMemory` encodes both rebuilt snapshots
through `Schema.toCodecJson` of the requesting declaration's payload schema
and compares the encoded values structurally. Equal `Date` and `Schema.Class`
values therefore join even when submitted as fresh instances. Object key order
does not matter; array order and length do.

If codec construction or encoding fails, memory compares the rebuilt snapshots
instead: arrays and plain objects (including null-prototype objects accepted
by `Schema.declare`) are structural; other objects require the same reference.
Leaves use `Object.is`, with positive and negative zero also equal. In both
comparisons, reference equality is checked
first, then recursion stops at depth 64 and refuses any remaining unequal
references. Equal structures beyond that bound can therefore conflict.

The durable driver compares persisted JSON payloads structurally, without this
depth bound or an opaque-reference fallback.

Memory validates every returned settlement against the requesting declaration's
decoded success and error schemas. A same-tag declaration whose schemas reject
the recorded value raises `ExecutionIdentityConflict` with `field: "flow"`
through both `execute` and `poll`. Compatible decoded schemas may reuse the
settlement, including schemas with different encoded representations.

The same conflict guards `deferredDone`: a deferred addressed to one flow
cannot complete an execution that belongs to another.

## The id is a trust boundary

Because clients supply it, an id is only as namespaced as the server makes it.
Two tenants that both submit `report-1` are one execution unless something
separates them. A server that accepts execution ids from more than one
principal namespaces them in one place:
[Namespace execution ids per tenant](../guides/namespace-execution-ids.md).

## Unknown ids: failure, or silence

The three read-and-control operations disagree about an unknown id on purpose:

- `poll` fails with `FlowRuntime.FlowExecutionNotFound` for an id no engine
  knows. It answers `Option.none()` for a known execution that has not settled,
  and also for an execution belonging to a different flow tag: from
  this flow's view that run has no result.
- `interrupt`, `interruptUnsafe`, and `resume` treat an unknown id as a silent
  no-op. Each is a request, each is idempotent, and a reaped or mistyped run
  has nothing left to cancel or re-drive.

## Parent and child executions

A flow that opens an explicit child boundary creates a second execution with
its own id, derived from the parent, the plan node, the callee, and the
payload, so replaying the parent's body re-derives the same child id and the
child runs once.

The engine records the parent edge for every child request, including a fan-in
that joins an existing execution, and refuses a request that would close a
cycle with `FlowRuntime.FlowCycleDetected` carrying the path it walked.
Recording the edge rather than a single parent field is what catches a
second-parent cycle in which two runs would otherwise join each other forever.

## Related

- [Step identity](./step-identity.md) is the other identity in the system: it
  names one dispatch inside a run.
- [Trampoline rounds](./trampoline-rounds.md) explains why one `execute` call
  can span several execution ids.
