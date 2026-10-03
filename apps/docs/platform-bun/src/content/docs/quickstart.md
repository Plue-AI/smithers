---
title: "Quickstart"
description: "Run a file operation and a command through BunHost.layer, then turn containment on and watch a spawned child enter and leave the process ledger."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-bun/docs/quickstart.md"
---

This quickstart runs one program against the Bun host twice: first on the plain
bundle, then with process containment turned on. By the end you will have
executed a real child process through the host surface and seen its record
appear in, and disappear from, the process ledger.

## Prerequisites

- Bun 1.4.0 or later, or Node.js 26.4.0 or later.
- The `smithers-jj-export` helper. See
  [Installation](/installation/#install-the-filesystem-helper).
- [Jujutsu](https://jj-vcs.github.io) at jj 0.39.0 or later on `PATH`. Confirm
  it with `jj --version`. Neither program below touches `Jj`, but every
  complete bundle probes jj while the layer is built and fails with `JjError`
  before the program body runs when it is missing. See
  [Installation](/installation/) for `SMITHERS_JJ_PATH` and for composing
  service layers without jj.
- A package with the dependencies installed. Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

## Run a file operation and a command

Create `quickstart.ts`. The program asks for two of the five host services by
tag, and names Bun nowhere:

```ts
import { BunHost } from "@smthrs/platform-bun"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner

  yield* fs.writeFileString("report.txt", "written through the host filesystem\n")
  const readBack = yield* fs.readFileString("report.txt")
  const listed = yield* spawner.string(ChildProcess.make("ls", ["report.txt"]))

  return { listed: listed.trim(), readBack: readBack.trim() }
})

Effect.runPromise(Effect.provide(program, BunHost.layer)).then(console.log)
```

Run it:

```bash
bun run quickstart.ts
```

```text
{
  listed: "report.txt",
  readBack: "written through the host filesystem",
}
```

`BunHost.layer` provided all five slots; the program used two of them. The
other three were built and never asked for, and building `Jj` is where the
jj version probe ran.

## Turn containment on

The plain bundle signals its target when the scope closes. A target that exits
first can leave background descendants holding output open, and a crashed
host cannot run that finalizer.

`BunHost.layerContained` prepares a supervisor for each command, records its
identity before target execution, and keeps a `SIGTERM`-then-`SIGKILL` deadline
for the owned process group even after the target exits. The supervisor's
private host connection also initiates cleanup on host loss. The required
`ProcessLedger` lets a later host reconcile cleanup that was not confirmed;
the memory ledger below deliberately has no persistence across restarts.

Create `contained.ts`:

```ts
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import { BunHost } from "@smthrs/platform-bun"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const ledger = yield* ProcessLedger.makeMemory({
    hostId: "quickstart",
    ownerPid: process.pid
  })

  const host = BunHost.layerContained({ graceMs: 500 }).pipe(
    Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(ledger))
  )

  const duringScope = yield* Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    yield* spawner.spawn(ChildProcess.make("sleep", ["30"]))
    return yield* ledger.live
  }).pipe(Effect.provide(host), Effect.scoped)

  return { afterScope: yield* ledger.live, duringScope }
})

Effect.runPromise(program).then((result) => console.log(JSON.stringify(result, null, 2)))
```

Run it:

```bash
bun run contained.ts
```

```text
{
  "afterScope": [],
  "duringScope": [
    {
      "pid": 51234,
      "pgid": 51234,
      "hostId": "quickstart",
      "ownerPid": 51230,
      "startedAtMs": 1756900000000,
      "commandDigest": "sleep"
    }
  ]
}
```

The recorded pid is the live supervisor, which leads the owned process group;
it is not the native `sleep` target's pid. `commandDigest` names the executable
and never its arguments: journal entries are permanent, and arguments carry
credentials. A returned handle's `exitCode`
describes the target. The record also names the host incarnation that started
it, and it is gone after verified scope cleanup. See
[Contain and reap child processes](/guides/contain-child-processes/) for
the `detached: false`, escaped-session, and unsupported-platform boundaries.

Give it a durable half by swapping `ProcessLedger.makeMemory` for
`ProcessLedger.layer`, which writes through a [`@smthrs/journal`](https://journal.smithers.sh/reference/api/)
`Journal`. Then a crashed host's records survive, and the next incarnation
kills what the last one abandoned while its layer is built.

## Where to go next

- [Contain and reap child processes](/guides/contain-child-processes/):
  the escalation deadline, the reaper, and the options both contained
  factories take.
- [Bind the host to a repository root](/guides/bind-a-repository-root/):
  `layerAt` and `layerContainedAt`, so `Jj` does not inherit the process
  working directory.
- [The Host surface on Bun](/concepts/host-surface/): what each of the five
  slots is, and how to take one service without the other four.
