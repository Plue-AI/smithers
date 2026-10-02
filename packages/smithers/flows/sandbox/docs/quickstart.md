---
title: "Quickstart"
description: "Place one body on a provisioned machine: acquire a session, write a file through Effect's FileSystem, count its bytes with a process, and read the liveness verdict."
sidebar:
  order: 2
---

This quickstart runs one body on a machine held by a `Sandbox.Provider`. The
body asks for Effect's ordinary `FileSystem` and `ChildProcessSpawner`, writes
a relative path, and runs `wc -c` against that path. Both services come from
one session, which is why the process finds the file without either operation
naming a provider or a remote path.

`DirectorySandbox` makes the machine a real scratch directory on this host, so
the walkthrough needs no container runtime and no credentials. It is also not
an isolation boundary; see
[What a sandbox does and does not prevent](./concepts/isolation.md) before you
run anything you do not trust.

## Prerequisites

- Node.js 26.4.0 or later.
- A package with the dependencies installed. Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/apps/site/docs/installation.mdx).

## Write the body

Create `quickstart.ts`. Nothing in this effect knows where it runs:

```ts
import { SandboxHealth } from "@smthrs/sandbox"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

/** Writes a file, measures it with a process, and asks whether the machine is alive. */
const countBytes = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner
  yield* fs.writeFileString("report.txt", "placed on the machine\n")
  const printed = yield* spawner.string(ChildProcess.make("wc", ["-c", "report.txt"]))
  const health = yield* SandboxHealth.SandboxHealth
  const state = yield* health.check
  return { bytes: Number.parseInt(printed.trim(), 10), health: state._tag }
})
```

`report.txt` is relative. `Sandbox.fileSystem` resolves a relative path against
the session's `workdir` before it reaches the machine, so the same body lands
in the workspace on every backend.

## Provide the machine

`Sandbox.layerHost` acquires one session and serves `ChildProcessSpawner`,
`FileSystem`, `Path`, and `SandboxHealth` from it. `DirectorySandbox.make`
takes the host services it provisions with as values, so the package never
reaches for an ambient host:

```ts
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import { DirectorySandbox, Sandbox } from "@smthrs/sandbox"
import * as Layer from "effect/Layer"

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner
  const provider = DirectorySandbox.make({
    fs,
    spawner,
    root: "/var/tmp/smithers-quickstart"
  })
  return yield* countBytes.pipe(
    Effect.provide(Sandbox.layerHost(provider, { session: "quickstart:01J" })),
    Effect.scoped
  )
})
```

`DirectorySandbox` requires a lifecycle-backed spawner, such as
`NodeHost.layerContained()` below. The memory ledger contains this process's
commands; use a durable `ProcessLedger.layer` when a later host must reconcile
retained process records.

`Effect.scoped` is what ends the machine. Acquisition registers teardown as a
finalizer of the acquiring scope, and closing the scope is the only lifecycle
end the caller has: there is no `destroy` method to forget.

## Run it

```ts
const host = NodeHost.layerContained().pipe(
  Layer.provide(ProcessLedger.layerMemory({ hostId: "directory-quickstart", ownerPid: process.pid }))
)

console.log(
  await Effect.runPromise(program.pipe(Effect.provide(host), Effect.orDie))
)
```

Run the file with your TypeScript runner. The output is:

```text
{
  bytes: 22,
  health: "Healthy",
}
```

## What just happened

`layerHost` called `provider.acquire("quickstart:01J")`, which created a
scratch directory named from that key, and served three views of the one
session: a spawner adapted from `Session.spawn`, a `FileSystem` derived from
`Session.readFile`, `Session.writeFile`, and POSIX probes, and a health probe
over `Session.ping`. The write and the process therefore saw one tree.
Returning from `Effect.scoped` closed the layer scope, ran the provider's
finalizer, and removed the directory with the file in it.

Read `health: "Healthy"` narrowly. It means this provider's ping answered
within the probe deadline, and `DirectorySandbox`'s ping is a constant, because
the machine is this process's own host. A provider that declares no `ping` at
all gets a probe that always answers `Healthy`, which says nothing is watching
the machine rather than that it is alive.

## Next steps

- [Place a flow body on a machine](./guides/place-a-flow-body-on-a-machine.md):
  the same layer inside a durable flow, with the engine staying local.
- [Choose a provider](./guides/choose-a-provider.md): what changes and what
  does not when you swap `DirectorySandbox` for a container, a microVM, or a
  cloud runner.
- [Sessions and their keys](./concepts/sessions.md): why the key is an
  exclusive claim, and what reattachment gives you after a crash.
