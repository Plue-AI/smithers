---
title: "Troubleshooting"
description: "Every refusal @smthrs/time-travel raises, the warnings it logs, and what to change: bad addresses, live runs, blocked rewinds, lost fences, history caps, and forks that re-execute."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/time-travel/docs/troubleshooting.md"
---

Every failure here is a `TimeTravelError` carrying a `code` from a closed list,
so the code is the fastest way into this page. The full code table is in the
[API reference](/reference/api/).

## not_found: "lineage ... is not present in ..."

**What happened.** The fold read the run's journal at or below the frame and
found no record on the lineage the frame names.

**What to change.** Two causes, in order of likelihood. The lineage id was
assembled by hand: it is a versioned encoding, not a path, and the encoding has
already changed once, so a hand-written string addresses no record. Mint it
with `FlowEngine.Lineage.root(runId)` from [`@smthrs/engine`](https://engine.smithers.sh/reference/api/), or
read `meta.lineageId` off any entry the run committed. Or the frame's sequence
sits below the lineage's first record, in which case raise the sequence. See
[Frames and lineage](/concepts/frames-and-lineage/).

## not_found: "frame ... is not a record of ..."

**What happened.** A fork was asked for a frame that addresses no record of
that parent run, usually a sequence past the journal tail.

**What to change.** Read the run's tail first and fork at a sequence that
exists:

```ts
const page = yield * journal.entries({ runId, limit: 200 })
const seq = page.entries.at(-1)?.seq ?? 0
```

## live_parent: "parent run ... is live" or "ancestor run ... is live"

**What happened.** A fork needs a settled prefix to copy, and the parent or one
of its ancestors is running, claimed, or owned.

**What to change.** Wait for the run to finish or park, then fork. A flow
parked at a durable wait has released ownership with its history committed,
which is the state fork and rewind both want.

## live_child: "live ... child ... blocks rewind"

**What happened.** A descendant would have had history cut out from under it.
An attached child always blocks. A detached child blocks under the default
`detachedChildren: "block"` policy.

**What to change.** Let the child finish, or pass
`detachedChildren: "cancel"` if the child is detached and you accept the
cancellation. This applies to idle (`pending` or `suspended`) children and
running children whose owner lease has expired. A live owner still refuses
with `live_child`; `Options.isAlive` may veto cancellation after lease expiry.
There is no option that cancels an attached child, because
truncating history the child still depends on is not a policy choice. See
[Rewind a run to a frame](/guides/rewind-a-run/).

## busy: "run ... is not available for rewind"

**What happened.** Another owner holds the run, or the claim or activation was
lost while the rewind was taking it.

**What to change.** Retry. This is a contention answer, not a verdict.

## busy: "journal tail moved for ..."

**What happened.** Validation ran before the run was claimed, and another
executor claimed the idle row, appended records, and released it inside that
window. The rewind refused rather than truncate records validation never saw.

**What to change.** Re-read the tail and rewind again against the new frame.
The refusal is the protocol working: the alternative was a silent truncation.

## irreversible: "rewind is blocked by N effect(s)"

**What happened.** At least one crossed effect cannot be undone. The cause
carries each blocking assessment's identity and verdict, and the full records
are on the audit row's `detail`.

**What to change.** Read the reason on each assessment. Three are common:

- _No compensation handler is registered for ..._: provide one through
  [`CompensationHandlers`](/guides/compensate-an-effect/). With no handlers
  at all, every crossed irreversible effect blocks, which is the safe default.
- _Sealed cache entry ... is missing_: the recorded result is gone, so the
  sealed step can no longer be re-derived. Rewind to a frame below the effect,
  or restore the cache entry.
- _The target frame has no recorded jj snapshot pointer_: a compensable effect
  mutated the workspace and there is nowhere honest to restore to. Pick a frame
  that has an anchor.

A resolved handler can still block: a tier mismatch, an effect whose terminal
status is not `succeeded`, a compensation descriptor the handler does not
declare, or a missing idempotency key a handler requires. See
[Effect tiers](/concepts/effect-tiers/).

## compensation_failed

**What happened.** A rollback handler or the workspace restore failed, so the
rewind stopped rather than leave the world half reverted. Every earlier receipt
was rolled back before the failure escaped.

**What to change.** Fix the handler or the workspace, then rewind again. The
audit row records the phase it reached and the receipts it had collected.

When the rollback itself fails, the audit closes `failed` at phase
`terminal_failure`, records the rollback error in `rollbackFailure`, and keeps
its `compensation` receipts. Those compensations are still applied to the
outside world. Undo them from the receipts before rewinding the same frame
again, or the next rewind compensates the same effects a second time. A
`rolled_back` audit is the opposite case: its receipts were undone, so the
detail no longer carries them.

## fence_lost

**What happened.** Ownership of the run, or of an attached child, was
superseded before the truncation committed, so the mutation was refused rather
than written behind the live owner.

**What to change.** Retry the rewind. Something else took the run, which is the
same class of answer as `busy`, raised at the commit rather than at the claim.

## already_crossed

**What happened.** `EffectBoundary.guard` tried to write the `intended` record
and got a duplicate back: this effect already crossed its durable boundary, so
executing it a second time was refused.

**What to change.** This is a re-armed effect, not a contended run, which is
why it is not `busy`. Give the retry a fresh effect id, or read the recorded
outcome instead of re-running the action.

## rate_limited

**What happened.** The rate limiter supplied as `Options.rateLimit` rejected
the attempt. The decision is recorded on the audit row.

**What to change.** Back off and retry, or raise the limit in the
`TimeTravel.layerWith({ rateLimit })` the composition builds the service with.
Nothing durable was compensated or truncated. A build that supplies no limiter
never raises this code.

## limit_exceeded

**What happened.** The operation would read more journal entries than
`maxHistoryEntries` allows: the prefix a replay folds, or the suffix a fork or
rewind assesses. A rewind refuses before it claims the run, so nothing was
taken.

**What to change.** Raise the cap for the call, or for the service:

```ts
const layer = TimeTravel.layerWith({ maxHistoryEntries: 500_000 })
```

The default is 100,000 entries. Lower it deliberately when the caller is
untrusted; raise it when a legitimately long run needs reading.

## invalid

**What happened.** Something malformed was refused before the operation touched
anything, or a durable payload did not decode. The message names it. The
recurring ones:

- A `pageSize` or `maxHistoryEntries` that is not a positive integer.
- `detachedChildren` misspelled. It is decoded before anything durable happens
  precisely so `"blcok"` is refused rather than selecting the destructive
  branch.
- An audit patch carrying a key other than `status`, `rateLimit`, or `detail`.
  An audit's identity is fixed when it is written.
- An irreversible effect boundary declared with no idempotency key.
- Conflicting boundary evidence for one effect: two terminal records, a
  terminal followed by an `intended`, or two records whose identity fields
  differ.
- A journal page that returned a sequence the fold had already passed.

## unknown

**What happened.** The store, the journal, the cache, or an unmapped host
failure. The original cause is attached.

**What to change.** Read the cause. One specific case is worth naming: the
durable store supports SQLite and PostgreSQL clients only, so pointing it at
another dialect, such as MySQL, fails on the DDL. Archive writes use strict
`INSERT` keyed by `(run_id, generation, seq)`; a collision rolls back the
archive transaction.

## A fork re-executed a sealed step

**What happened.** The child dispatched an action the parent had already
sealed, instead of replaying the recorded result.

**What to change.** Declare the cache environment in both compositions. A
sealed action's cache key is computed under the ambient environment, and with
no declaration the engine scopes the key to the execution that produced it, so
the child addresses a different key:

```ts
const environment = Action.layerCacheEnvironment({ layers: [], capabilities: {} })
```

## A fork warns about the lane default

**What happened.** The fork succeeded and reported that the frame has no
recorded Jujutsu pointer, so the child's workspace starts from the lane default
rather than from the frame's tree.

**What to change.** Nothing, if the child does not depend on the tree. If it
does, the frame has no anchor because no snapshot record reached the anchor
projection for that lineage. Check that the run was driven by a composition
that journals snapshots.

## Warnings in the log

Three log lines come from this package's own recovery paths:

- `time-travel: startup recovery closed an audit as failed` is logged at error
  level with the audit id, code, and reason. A rewind a crash interrupted could
  not be finished, and the audit is now closed terminally. Read the audit's
  `detail` for the phase it reached.
- `time-travel: could not refresh frame anchors` means the anchor projection
  could not run, so the anchors were left as they were. The verbs already say
  what that costs: a fork reports the lane-default warning, and a rewind
  restores no pointer rather than a wrong one.
- `time-travel: could not forget an abandoned fork workspace` names a lane left
  behind by a fork that reserved an id and never committed. The reserved
  ordinal is never handed out again, so the lane blocks nothing; remove it by
  hand if the disk space matters.

## An audit stays in_progress across restarts

**What happened.** Startup recovery declined it, because the run it names is
still held by a process the liveness check considers alive. The row keeps its
`in_progress` status, stays in `pendingAudits`, and nothing is written, so a
later build finishes it.

**What to change.** Usually nothing: this is how a rewind a living process
still owns is protected from being stolen. If the holder is genuinely gone and
the default lease check is too patient, supply a check that can say more:

```ts
const layer = TimeTravel.layerWith({ isAlive })
```

A supplied check can only refuse a takeover, never widen one, because the
evidence recovery hands the run store is always `lease-expired` and the store
re-verifies that claim inside the same write. See
[The rewind protocol](/concepts/rewind-protocol/).
