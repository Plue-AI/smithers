---
title: "Run a compensable action"
description: "Provide a SnapshotBoundary so an action declared tier compensable can run: what the engine calls and in what order, what each call receives, and what happens when the boundary is missing."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine/docs/guides/compensable-actions.md"
---

An action declared `tier: "compensable"` says its effects can be undone by
restoring the world around it. The engine enforces that claim by running every
attempt inside a snapshot boundary, and it refuses to dispatch the action when
no boundary is in context.

This package declares the service and ships no implementation, because
snapshotting a workspace is a host concern.
[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/) provides one backed by a Jujutsu
repository.

## Provide the boundary

`FlowEngine.SnapshotBoundary` has three members. `snapshot` returns an opaque
handle of your choosing, and the other two receive it back:

```ts
import { FlowEngine } from "@smthrs/engine"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

declare const takeSnapshot: (label: string) => Effect.Effect<string>
declare const restoreSnapshot: (handle: string) => Effect.Effect<void>
declare const diffSnapshot: (handle: string) => Effect.Effect<unknown>

const boundary = Layer.succeed(FlowEngine.SnapshotBoundary)(
  FlowEngine.SnapshotBoundary.of({
    snapshot: ({ key, attempt }) => takeSnapshot(`step ${key} attempt ${attempt}`),
    restore: (handle) => restoreSnapshot(handle as string),
    diff: (handle) => diffSnapshot(handle as string)
  })
)
```

The handle is typed `unknown` at the boundary because the engine never
interprets it. It keeps the earliest handle for each step key and hands that value back
on retries.

Every member receives `SnapshotBoundaryOptions`: the flow, the execution id,
the step key, the attempt number, and the action's declared metadata. Key and
attempt together name the exact dispatch, which is what a snapshot label should
carry.

## The order the engine calls them

For a compensable action that fails once and succeeds on the retry, the engine
produces exactly this sequence:

```text
snapshot:1
execute:1
diff:snap:1
restore:snap:1->attempt:2
snapshot:2
execute:2
diff:snap:2
```

Reading it in order:

1. Before each executing attempt, `snapshot` runs. The earliest handle for the
   step key remains the retry restore point.
2. The attempt runs.
3. `diff` runs after the attempt settles, on every path, including failure.
4. Before a retry, `restore` runs with the earliest handle, so every retry
   starts from the world the first attempt started from.

`restore` runs only when a stored handle for that key exists. A new first
attempt is never preceded by one.

## Across a process restart

A durable driver opts in by implementing `Encoded.actionSnapshot({ key })`.
It returns the earliest persisted pre-attempt handle as `Option.some(handle)`,
or `Option.none()` when none survives. The driver must evaluate the supplied
`ActionExecuteOptions.snapshot` effect only after ruling out journal replay
and joining another dispatch, and persist its returned handle with the attempt
before executing the action. Keep the first handle until the retry sequence
ends, including when an attempt is interrupted before recording an outcome.
The host must keep that handle usable across restarts.

With this contract, a restarted retry restores the original pre-attempt world.
A journal hit invokes none of `restore`, `snapshot`, or `diff`. An unfinished
attempt that executes again restores its persisted handle before taking a new
snapshot, even if its attempt number is still 1. `diff` describes only the
attempt that actually executed.

Without `actionSnapshot`, handles remain in the execution's in-process map.
Restore does not survive a restart, and replay still invokes snapshot and diff.
`layerMemory` uses this fallback; a boundary implementation alone does not make
the handle durable. `@smthrs/engine-store` persists the handle in the attempt
row, so its handles must be JSON values. If stored handles are pruned, the
engine cannot recover the original world.

## The refusal

A compensable action dispatched with no boundary in context dies with
`FlowEngine.SnapshotBoundaryRequired`, carrying the action name and the
message `Compensable action "<name>" requires SnapshotBoundary`. The action body
never runs, which is the point: the engine will not perform an effect it has
promised it can undo when it has no way to undo it.

The fix is to provide the boundary, or to change the tier if the action is
genuinely sealed.

## Related

- [Retries and attempts](/concepts/retries/): the retry decision that turns
  a failed attempt into the `restore` call above.
- [Step identity](/concepts/step-identity/): where the `key` in the
  boundary options comes from.
