---
title: "Contain child processes"
description: "Compose NodeHost.layerContained with a process ledger so every spawned process gets a kill deadline and a durable record, and a crashed host's orphans are reaped at the next boot."
---

Use this when a host spawns long-running children and must not leave them
behind if it dies. Under `NodeHost.layer` a child is signalled when its scope
closes and then waited for, forever if it ignores `SIGTERM`, and a host killed
outright abandons everything it started.

## Choose a ledger

`NodeHost.layerContained` requires a `ProcessLedger` and does not default one,
because the durable half of containment is only as good as the journal
underneath it. The choice belongs to the program that knows which it has.

| Ledger                      | Inherits a crashed incarnation's processes | Requires  |
| --------------------------- | ------------------------------------------ | --------- |
| `ProcessLedger.layer`       | yes                                        | `Journal` |
| `ProcessLedger.layerMemory` | no                                         | nothing   |

`layerMemory` still supplies the live supervisor lifecycle and kill deadline.
It simply inherits nothing, so the sweep always finds an empty orphan set.

Both take the same options: `hostId`, the durable identity two incarnations
share, and `ownerPid`, the process id of this one.

## Compose the host

```ts
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import { NodeHost } from "@smthrs/platform-node"
import * as Layer from "effect/Layer"

const host = NodeHost.layerContained({ graceMs: 2000 }).pipe(
  Layer.provide(ProcessLedger.layerMemory({ hostId: "engine-1", ownerPid: process.pid }))
)
```

`host` is a `Layer<NodeHost, JjError>`: the same five services `NodeHost.layer` hands
out, spawning through the contained spawner. Swap `layerMemory` for
`ProcessLedger.layer` to get the durable ledger, and provide a `Journal` from
[`@smthrs/journal`](/api/journal) underneath it.

To pin the repository root as well, use `layerContainedAt`:

```ts
const rooted = NodeHost.layerContainedAt("/absolute/repository", { graceMs: 2000 }).pipe(
  Layer.provide(ProcessLedger.layerMemory({ hostId: "engine-1", ownerPid: process.pid }))
)
```

## What building the layer does

Two things happen while the layer is built, in this order:

1. `ProcessReaper.reap` sweeps the records a previous incarnation of the same
   `hostId` left behind, killing the process groups it is willing to signal.
2. The contained services are handed to everything downstream.

So standing a host up is also what cleans up after the incarnation that
crashed. `jj` runs through that same spawner, so a `jj` invocation a crashed
host left running is a ledger record like any other.

Every spawn prepares a supervisor, commits its identity, and then activates
the target. Each pipeline leg is recorded. On POSIX the handle's `pid` names
the owner while `exitCode` describes the target. A natural target exit also
cleans up its owned group; use the handle's `kill`, never an external signal
to its numeric pid. Failed or unverified cleanup fails close and retains the
record.

A smaller host composition can use `ProcessReaper.layerSpawner` with a ledger
and an underlying runtime spawner. This factory includes the native adapter
whose pipe listeners remain alive through cancellation. Custom platform
authors can pass a lifecycle to `ContainedSpawner.layer` directly. Compose
the permission decorator above containment so it checks the original command
before preparation.

## Set the options

`NodeHost.ContainedOptions` has three fields, all optional:

| Field      | Default                          | What it does                                                                                                                    |
| ---------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `graceMs`  | 2000                             | most milliseconds between the `SIGTERM` that asks a child to stop and the `SIGKILL` that makes it; an emptied group ends sooner |
| `ownerPid` | `process.pid`                    | the pid the sweep must never signal, nor signal the group of                                                                    |
| `system`   | selected from `process.platform` | the operating-system seam the sweep asks its questions through                                                                  |

A command that already names its own `killSignal` or `forceKillAfter` keeps
them: a caller who set one thought about it.

`ContainedSpawner.Options.platform` is deliberately not among these. The
platform factory reads the real `process.platform`, so process-group behavior
and the recorded identity agree. A caller cannot describe a Windows record
for an owner that actually leads a POSIX group.

## Read what the sweep decided

`layerContained` runs the sweep and discards its report. To log the decisions,
call `ProcessReaper.reap` yourself:

```ts
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as ProcessReaper from "@smthrs/platform-node/ProcessReaper"
import * as Effect from "effect/Effect"

const sweep = Effect.gen(function*() {
  const decided = yield* ProcessReaper.reap()
  for (const entry of decided) {
    yield* Effect.log(
      entry.killed
        ? `killed ${entry.record.pid}`
        : `kept ${entry.record.pid}: ${entry.refusal}`
    )
  }
}).pipe(Effect.provide(ProcessLedger.layerMemory({ hostId: "engine-1", ownerPid: process.pid })))
```

Each entry carries the record, whether it was killed, and, when it was not, the
`Refusal` that says why. `Reaped` is a union discriminated by `killed`, so the
check in the branch above is what makes `entry.refusal` readable. Four refusals leave the record for a later
incarnation to try again: `owner-alive`, `identity-unverified`,
`own-group-unknown`, and `kill-failed`. The rest are final. See
[Process containment](../concepts/process-containment.md) for what each one
means and why the split falls where it does.

## Verify it

Use a UUID-marked fixture that installs its signal handler before reporting
readiness. Check both cancellation and natural target exit, including a child
that inherits stdout, and require a stopped heartbeat plus an exited process
identity. A target exit code alone is insufficient evidence.

For host-loss behavior, kill only the fixture host and verify the private
supervisor stops its owned group without requiring a new host. A subsequent
host with the same `hostId` and durable journal reconciles retained records.
Read any refusal instead of treating a skipped signal as a successful reap.
The [process containment](../concepts/process-containment.md) page describes
`detached: false`, deliberately escaped sessions, and unsupported hosts.
