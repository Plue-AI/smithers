---
title: "Execution Facts"
description: "Effect services for durable engine action persistence and replay boundaries"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine-store/docs/concepts/execution-facts.md"
---

The native driver records `executionFact: { version: 1, baseline, observation }`
in its authoritative `flows.engine.run-decision` and `flows.engine.interrupted`
records. This is a producer contract implemented by `RunDriver`, separate from
the generic `EngineEvent` schema vocabulary. Adding a schema alone does not
migrate a writer.

An observation contains the execution ID, flow name, lifecycle status, creation,
start and finish timestamps, effective parent, trampoline lineage and ordinal,
actual cancellation-request timestamp, and waiting reason/deadline/token digest.
Ownership, claims, heartbeats and cancellation acknowledger identity remain
operational store state; a heartbeat does not invalidate a semantic observation.
The existing encoded `state` on run decisions remains unchanged.

A wait's `tokenDigest` is SHA-256 of the exact opaque token, or null when absent.
The protected native waiting row remains execution authority for resolving the
wait. The event contains a comparison commitment, **not a replayable resolver
credential**. The journal redactor is not bypassed. Other application strings
that the redactor changes cannot establish exact replay equality and correctly
remain observations rather than verified event state.

## Commit boundary

Creation, parent admission, activation, resume clearing, suspension, release,
handoff and terminal settlement capture their fact in the transaction that
changes the row. Parking and the guarded status CAS are one transaction. A lost
CAS rolls the park back, preserving an earlier committed waiting row. Resume
clears the waiting row before capturing the running fact and before executing
work. Engine-state is the outer transaction and the journal write transaction
is inside it, matching deferred completion's state-first lock order. The memory
state adapter holds its own gate: taking the journal writer first can deadlock against a
state-first fiber waiting for that writer. The memory state gate is released
at SQL commit before post-commit journal work; publication failures after
commit cannot undo either committed boundary.

Cancellation records the actual `cancel_requested_at_ms` only when a guarded
request changes a live row. Repeat requests, missing rows and terminal rows
invent no new intent. Lineage cancellation reads membership, updates live rounds
and records each changed round in one native transaction. Descendant and inherited
requests use the same producer. A completed predecessor does not acquire a fake
request timestamp just because its successor is cancelled.

The Node and Bun host capture the native journal, run store and engine state
before `AgentSession` selects the separate control journal. Its direct
cancellation callback executes in the captured host context, outside any caller's
control SQL transaction. The native commit precedes the control receipt; the two
databases are not one distributed transaction. A later control write failure
cannot undo already accepted native intent, which remains visible in the native
observation and copied facts. Low-level `RunStore` calls and standalone legacy
`AgentSession.requestCancel` do not promise this event contract.

## Replay and migration

`ExecutionFact.fold` in `@smthrs/journal` is browser safe and pure. New creation
facts establish a `created` baseline. A first fact for an older row, an unknown
producer version, an explicit omission, or a generation boundary cannot invent
the missing prefix. A later complete fact establishes a `legacy` baseline.
If a low-level/corrupt row cannot encode a valid observation, the writer records
`{ version: 1, unavailable: "invalid-observation" }`. Existing invalid-round or
corruption handling can still settle the execution; this marker never creates
verified coverage and does not normalize malformed ancestry into invented facts.
The exposed sequence/generation range names the current round's native stream;
root and current are both compared, and either legacy baseline makes the logical
view's baseline legacy. Numeric sequence holes alone are not omissions: rolled-back SQL journal
reservations can leave them without losing a committed event.

The native supervisor authenticates a wrapper through its native flow, approved
plan and root ancestry, then the bridge writes a separate `control.engine.bound`
fact. It never binds a control run by trusting an input `runId` field. Existing
`control.engine.event` payloads and producer identities are unchanged. The bridge
walks both durable spawn edges and native trampoline membership; a handoff is not
a spawn edge. A legacy adapter without the lineage port cannot establish coverage
for a missing latest round.

Gateway run reads and subscriptions use the same control fold and native fold.
`lifecycleProvenance` continues to describe control replay and whether lifecycle
was engine observed. The additive `executionProvenance` separately identifies
native `events`, `legacy-observation` or `unverified-observation`. Native facts are
compared against a coherent observation of both the requested root and latest
round. The root retains ancestry and round identity; the current round supplies
status and waiting. A missing binding, gap, unsupported version or mismatch keeps
an honest observed fallback. Bridge lag is possible because this is a read-side
copy between databases, not a distributed snapshot.

This stream verifies the semantic run/approval view. It does not rebuild every
execution table: action outcomes, clocks, deferred values and resolver credentials
retain their existing native authorities. [Native call facts](/concepts/call-facts/)
now use the owning action transaction and durable journal as their outbox.
Other agent trace records still use a best-effort channel.
