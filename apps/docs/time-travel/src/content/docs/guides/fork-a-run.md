---
title: "Fork a run at a frame"
description: "Branch a child run off a parent's frame: what the child inherits, how its workspace is named and pinned, and how completed prefix actions are reused."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/time-travel/docs/guides/fork-a-run.md"
---

A fork copies a run's history up to a frame into a new run and leaves the
parent untouched. Use it to explore an alternative from a point that already
happened: retry a step under different inputs, branch a review, or drive a
finished run forward again without losing the original.

Driving a durable fork reuses the completed prefix without repeating its side
effects. Only work without a completion at the frame executes in the child.

## Fork the run

```ts
import { FlowEngine } from "@smthrs/engine"
import { TimeTravel } from "@smthrs/time-travel"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const timeTravel = yield* TimeTravel
  return yield* timeTravel.fork({
    runId: "analyse-1",
    frame: { lineageId: FlowEngine.Lineage.root("analyse-1"), seq: 12 }
  })
})
```

The result names the child run, the lineage edge back to the parent frame, and
everything the boundary assessment disclosed:

```ts
interface ForkResult {
  readonly runId: string
  readonly edge: Frame.LineageEdge
  readonly warnings: ReadonlyArray<string>
}
```

## What the child inherits

The fork copies the journal prefix at or below the frame, the frame's
anchors, and attempts whose completion receipts are in that prefix. An attempt
that finished after the frame is not inherited, even if it started before it.
The child's past is the selected prefix, not the parent's latest state.

The child also records its own origin on its journal, under
`Frame.forkCreatedEventType`, carrying the parent run id and the parent
sequence the fork was taken at. A forensic walk can start from the child and go
back without consulting the edge table.

The parent is never mutated and keeps running.

## The workspace is derived, not supplied

The fork mints the child run id first and names the Jujutsu lane after it:
`smithers-fork-`, the sanitized child id capped at 64 characters, then a short
digest of the raw id. The lane and the run it holds therefore carry one
identity, and a frame forked twice gets two lanes rather than a collision.

The child's worktree is checked out at the frame's recorded pointer, not at the
parent's current tree.

`ForkOptions.workspaceRoot` only moves which directory the derived name lands
in. It defaults to `.flows/forks`:

```ts
yield * timeTravel.fork(position, { workspaceRoot: ".worktrees/forks" })
```

By default, the lane is forgotten when the time-travel service's scope is released,
not when the call returns. Set `retainWorkspace: true` to keep the lane registered
for a later process; the caller then owns its cleanup. `forkWorkspaceName(childRunId)`
from `@smthrs/time-travel/TimeTravel` returns the derived workspace name.
If the frame has no recorded anchor, the fork still
succeeds and reports a warning naming the workspace it could not restore.

## Warnings are disclosure, not refusal

A fork never compensates anything. Its suffix assessment reports warnings when
an effect may execute again on the child. A frame inside an unfinished
irreversible crossing is refused before the child is created.

A fork with a non-empty `warnings` is a successful fork. Read the warnings and
decide whether to drive the child; the copy already exists either way.

## Keep completed steps from re-executing

The durable engine resolves copied attempts using their original action
identities. This includes sealed, compensable, and irreversible actions, with
or without a shared cache environment. A fork of a fork also retains results
produced by its ancestors, but only when their completion is in its copied
prefix.

Actions first reached after the frame use the child's own identity. A shared
cache entry from the parent's future cannot answer them, and sibling forks
have distinct keys for these actions. Retries of a copied failed attempt retain
its original identity so an external provider can deduplicate that same effect.
Resume uses the child's recorded results after a process restart.

A frame inside an irreversible action that has crossed its boundary but has no
completion receipt fails with `already_crossed`. Choose a frame before that
boundary or after the action completes.

Execute the same declarations and inputs to replay their results. Changing an
action's identity intentionally creates new work. A fork does not undo external
effects: its suffix may repeat effects that the parent already performed.

## Drive the child

The child is an ordinary run. Execute the same flow with the forked run id as
its execution id. Completed prefix actions return their recorded results and
the remaining actions execute:

```ts
const driven = Effect.gen(function*() {
  const timeTravel = yield* TimeTravel
  const fork = yield* timeTravel.fork(position)
  return yield* Analyse.execute({}, { executionId: fork.runId })
})
```

A runnable version of this walkthrough is
[`05-time-travel-fork.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/05-time-travel-fork.ts)
in the Smithers examples on GitHub.

## Edit a step result

Pass `override` to fork with one step's recorded result replaced. The child
replays every step up to the frame, serves that step with the edited value,
and runs everything after the frame again against it:

```ts
const fork = yield * timeTravel.fork(position, {
  override: { stepKeyDigest, result: "edited draft" }
})
```

`stepKeyDigest` is the key the step's attempts are recorded under; `smthrs
runs verify` lists it for each recorded step. `result` is the step's encoded
success value. The child decodes it under the step's declared success schema
when it replays the step, so a value the schema refuses fails the child there.
Pick a frame at or after the step's completion: a step with no successful
attempt at the frame refuses `not_found` before anything is written. A step the
shared step cache holds refuses `invalid`, because a cache hit is served ahead
of the attempt row and would hide the edit.

## Bound what the fork reads

`ForkOptions.maxHistoryEntries` caps the suffix the fork assesses for this one
call, overriding the service default. A suffix past the cap fails
`limit_exceeded`.

## Failures

| Code              | Cause                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `already_crossed` | The frame lies inside an irreversible action after its boundary and before its completion receipt.        |
| `live_parent`     | The parent run, or an ancestor of it, is running, claimed, or owned, so it has no settled prefix to copy. |
| `not_found`       | The frame addresses no record of that run, or `override` names a step with no success at the frame.       |
| `invalid`         | A malformed option, a durable payload that does not decode, or an override the step cache would hide.     |
| `limit_exceeded`  | The suffix the fork would assess is longer than the cap allows.                                           |
| `unknown`         | The store, the journal, or Jujutsu failed. The cause is attached.                                         |

If the process dies after the lane is provisioned and before the store commits
the fork, the next build of `TimeTravel.layer` forgets the lane and the
reserved ordinal is never handed out again, so a retry lands under a fresh
name.

## Where to go next

- [Frames and lineage](/concepts/frames-and-lineage/): the edge a fork
  records, and what `attached` means for a later rewind.
- [Effect tiers](/concepts/effect-tiers/): how each warning was reached.
- [Rewind a run to a frame](/guides/rewind-a-run/): the destructive counterpart.
