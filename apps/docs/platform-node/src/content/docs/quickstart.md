---
title: "Quickstart"
description: "Stand up the Node host, run a command and read a file through it, then wrap it in the capability kernel and watch a symlink escape get refused."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-node/docs/quickstart.md"
---

This quickstart runs one program against the Node host twice: once raw, and
once behind the capability kernel with a workspace root. By the end you will
have seen the bundle do real work and refuse a real escape, and you will know
which layer is responsible for each.

## Prerequisites

- Node.js 26.4.0 or later, on a POSIX host.
- The `smithers-jj-export` helper. From a source checkout, run
  `cargo build --locked --release -p smithers-ffi --bin smithers-jj-export`.
- `jj` 0.39.0 or newer on `PATH`. Check with `jj --version`. Every complete
  `NodeHost` layer checks jj at construction, including this quickstart's
  filesystem and process examples. For applications that do not need jj, see
  [Individual services without jj](/installation/#individual-services-without-jj).
- `@smthrs/platform-node`, [`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/), and their `effect`
  peers resolvable from the file you are about to write.
  [Installation](/installation/) has the workspace form.

## Run a command through the raw host

Create `quickstart.ts`. `NodeHost.layer` provides all five host tags, so a
program that asks for `ChildProcessSpawner` gets Effect's Node spawner:

```ts
import { NodeHost } from "@smthrs/platform-node"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const runCommand = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("printf", ["hello from node"]))
})

console.log(await Effect.runPromise(Effect.provide(runCommand, NodeHost.layer)))
```

```text
hello from node
```

Nothing here is a Smithers wrapper. `ChildProcess` and `ChildProcessSpawner`
are Effect's own tags; this package supplies the implementation and nothing
else. A wall-clock budget is `Effect.timeout` around the effect, and
cancelling a command is fiber interruption.

## Build a workspace with an escape in it

The filesystem is where this bundle differs from Effect's Node adapter, so give
it something to refuse. Create a workspace directory with one ordinary file
inside it, and one symlink pointing at a file outside it:

```ts
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const container = mkdtempSync(join(tmpdir(), "platform-node-quickstart-"))
const workspace = join(container, "workspace")
const secret = join(container, "secret.txt")

mkdirSync(workspace)
writeFileSync(join(workspace, "inside.txt"), "confined\n")
writeFileSync(secret, "outside\n")
symlinkSync(secret, join(workspace, "escape.txt"))
```

## Compose the guarded host

`HostServices.layer` from [`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/) decorates every one
of the five tags with a capability check. It needs the workspace root that
bounds the filesystem, and a grant store that answers the permission
questions. For this local trial, use the allow-all store, so that the only
thing left refusing anything is the confinement itself. `GrantStore.layerNoop`
is a seam for tests and boot paths, not a production policy; a real host
answers with rules, as
[Write a capability policy](https://kernel.smithers.sh/guides/write-a-capability-policy/)
shows:

```ts
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as HostServices from "@smthrs/kernel/HostServices"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as Layer from "effect/Layer"

const guarded = HostServices.layer.pipe(
  Layer.provide(NodeHost.layer),
  Layer.provide(Workspace.layer(workspace)),
  Layer.provide(GrantStore.layerNoop)
)
```

## Read both files

Read the ordinary file, then read through the symlink and keep the failure
instead of the success:

```ts
import * as FileSystem from "effect/FileSystem"

const readBoth = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const inside = yield* fs.readFileString(join(workspace, "inside.txt"))
  const refusal = yield* Effect.flip(fs.readFileString(join(workspace, "escape.txt")))
  return { inside: inside.trim(), refusedWith: refusal.reason._tag }
})

console.log(await Effect.runPromise(Effect.provide(readBoth, guarded)))
```

```text
{ inside: 'confined', refusedWith: 'PermissionDenied' }
```

## What just happened

The first read walked the workspace with directory descriptors and opened a
regular file. The second read reached a symlink, and the walk refuses to
traverse one, so the operation failed with a typed `PermissionDenied` before
anything outside the workspace was opened. The grant store allowed both reads:
the refusal came from the descriptor-relative walk, not from a permission rule.

That is the property the bundle exists for. A path check followed by a
path-based open leaves a window in which the path can be swapped; performing
the operation relative to a pinned descriptor closes it. See
[The descriptor-relative filesystem](/concepts/descriptor-relative-filesystem/)
for how the helper does it and what else it refuses.

## Next steps

- [Contain child processes](/guides/contain-child-processes/): give every
  spawned process a kill deadline and a durable record, so a crashed host
  leaves nothing running.
- [Configure the filesystem helper](/guides/configure-the-filesystem-helper/):
  point at a different helper, and set the ceilings that bound a wide
  fan-out.
- [The host bundle](/concepts/host-bundle/): the five tags, the four layers,
  and what the bundle deliberately does not provide.
- [Troubleshooting](/troubleshooting/): what to do when every filesystem
  call fails closed.
