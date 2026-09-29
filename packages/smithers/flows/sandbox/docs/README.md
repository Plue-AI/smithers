---
title: "@smthrs/sandbox"
description: "Run an Effect program's files and child processes on a machine you provision: a container, a microVM, a Kubernetes Pod, a cloud sandbox, or a scratch directory, all behind one contract."
---

`@smthrs/sandbox` runs part of an Effect program somewhere other than the
process that started it. You hand it a provider that owns a machine, and it
serves Effect's ordinary `FileSystem`, `Path`, and `ChildProcessSpawner` from
one session on that machine. Code written against those services runs unchanged
whether the machine is a scratch directory on your laptop, a container, a
microVM, or an AWS Fargate task.

## What it solves

Code that writes files and runs commands on behalf of a model, a build, or a
customer's script needs a boundary, and the boundary you want in production is
rarely the one you want in a test. Reaching for a vendor SDK directly puts that
choice in every call site: the SDK's own exec API, its own file API, its own
error type, its own idea of what happens when you cancel.

This package moves the choice to one place. A backend implements one of two
provider contracts, and everything else derives from it:

- The **machine** is acquired once per session key and torn down when the scope
  closes. There is no `destroy` method to forget, and an interruption tears the
  machine down like any other finalizer.
- The **body** asks for Effect's ordinary host services. It never names a
  provider, and a relative path resolves against the session's working
  directory, so the same code lands in the right place on every backend.
- What a backend **cannot** do is refused rather than silently dropped. A
  command that supplies standard input to a transport with no input channel,
  `stdin: "inherit"`, extra file descriptors, or `kill` on a provider that
  declares none each fail before anything starts.

Nine providers ship with the package: `DirectorySandbox`, `JustBashSandbox`,
`ContainerSandbox`, `KubernetesSandbox`, `MicrosandboxSandbox`,
`VercelSandbox`, `DaytonaSandbox`, `AwsSandbox`, and `CloudflareSandbox`. None
of them costs the package a vendor dependency: an SDK arrives as an injected
structural slice and a command-line tool arrives as an injected spawner, so you
install only what the backend you picked needs.

The package is not an isolation mechanism. It adapts whatever boundary the
backend already provides, and that ranges from a microVM down to a directory on
the machine you are sitting at. Read
[What a sandbox does and does not prevent](./concepts/isolation.md) before you
place code you do not trust.

## Install

Not on npm yet; see [Installation](/docs/installation/#use-the-libraries).

Node.js 26.4.0 or later. `@smthrs/platform-node` supplies the contained host
services `DirectorySandbox` requires. A raw spawner or a wrapper with only a
kill deadline is refused before a workspace is created.

## Place one body on a machine

This program writes a file and measures it with a process. Both operations come
from one session, which is why `wc` finds a file that `writeFileString` wrote
without either call naming a provider or an absolute remote path:

```ts
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import { DirectorySandbox, Sandbox } from "@smthrs/sandbox"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

/** Nothing in this effect knows which machine it runs on. */
const countBytes = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner
  yield* fs.writeFileString("report.txt", "placed on the machine\n")
  const printed = yield* spawner.string(ChildProcess.make("wc", ["-c", "report.txt"]))
  return Number.parseInt(printed.trim(), 10)
})

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner
  const provider = DirectorySandbox.make({ fs, spawner, root: "/var/tmp/smithers" })
  return yield* countBytes.pipe(
    Effect.provide(Sandbox.layerHost(provider, { session: "demo:01J" })),
    Effect.scoped
  )
})

const host = NodeHost.layerContained().pipe(
  Layer.provide(ProcessLedger.layerMemory({ hostId: "directory-quickstart", ownerPid: process.pid }))
)

console.log(
  await Effect.runPromise(program.pipe(Effect.provide(host), Effect.orDie))
)
```

```text
22
```

`DirectorySandbox` requires a lifecycle-backed spawner. The memory ledger
contains this process's commands; use a durable `ProcessLedger.layer` when a
later host must reconcile retained process records.

`Effect.scoped` is what ends the machine: closing the scope runs the provider's
teardown finalizer, which removes the directory and the file in it. Swap
`DirectorySandbox.make` for `ContainerSandbox.make` or
`MicrosandboxSandbox.make` and `countBytes` does not change.

## How this relates to @smthrs/flows

`@smthrs/sandbox` stands alone: it shares its `effect` peer with the host and
depends on [`@smthrs/kernel`](/api/kernel) for command-line rendering and the containment contract, and you
can use it in any Effect program without adopting anything else.

It also supplies the machines that Smithers flows run on.
[`@smthrs/flows`](/api/flows) is the durable flow engine: it records each step
of a long-running job in a journal so a crashed run resumes where it stopped.
Its `SandboxedFlow` module runs a child flow's own code inside a provisioned
machine, and the provider it runs that code on is one of the providers
documented here. The seam between them is `Sandbox.Provider`, so a flow author
chooses a backend by name and never writes against a vendor SDK.

Two package names are one letter apart. [`@smthrs/flows`](/api/flows), plural,
is the whole engine in one install; [`@smthrs/flow`](/api/flow), singular, is
the authoring model inside it, which is where `Action`, `Flow`, and
`Interpreter` are defined. `@smthrs/flows` re-exports those names, so
installing the plural package is enough for the guides here.

Both packages sit under the `smithers` command-line tool, which is where you
start a run, watch it, and resume it: see the
[CLI reference](/api/cli). If you came here to place a flow's work on another
machine, read
[Place a flow body on a machine](./guides/place-a-flow-body-on-a-machine.md)
next.

## Where to go next

- [Installation](./installation.md): import forms, and what each of the ten
  providers expects you to supply.
- [Quickstart](./quickstart.md): the walkthrough behind the example above,
  including what the health verdict does and does not mean.
- [The two provider seams](./concepts/seams.md): the contract a backend
  implements, and why there are two of them.
- [Choose a provider](./guides/choose-a-provider.md): the ten side by side, by
  boundary, byte exactness, and cost to run.
- [Write a provider](./guides/write-a-provider.md) and
  [Prove a provider](./guides/prove-a-provider.md): adapt your own backend and
  hold it to the conformance suites.
- [API reference](./api.md): every export, with the per-provider mechanics and
  honest limits.
- [Troubleshooting](./troubleshooting.md): what each refusal means and what to
  change.
