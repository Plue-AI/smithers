---
title: "Quickstart"
description: "Mount one ZenFS volume in a page, wire a just-bash interpreter to it, and prove that a spawned command and the FileSystem service see the same file."
sidebar:
  order: 2
---

This quickstart puts both adapters in a real page and proves the one property
the whole design turns on: a command spawned through the interpreter and a read
through Effect's `FileSystem` see the same bytes, because they share one mounted
volume.

## Prerequisites

- A bundler that can serve a page, and a browser that supports IndexedDB.
- The package and the two backends. Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

## Mount one volume and wire the interpreter

Create `quickstart.ts` in your page's bundle. The mount happens first, because
both views are taken from it:

```ts
import { BrowserServices } from "@smthrs/platform-browser"
import { configureSingle, fs } from "@zenfs/core"
import { IndexedDB } from "@zenfs/dom"
import { Bash } from "just-bash"

await configureSingle({ backend: IndexedDB })

/** Two views of one volume: the interpreter, and the promises API the adapter reads. */
const bash = new Bash({ fs })
const layer = BrowserServices.layer({ bash, fs: fs.promises })
```

`BrowserServices.layer` provides three services from that pair:
`ChildProcessSpawner`, `FileSystem`, and `Path`. Passing a `bash` built over a
different mount than `fs` is the one mistake the function signature exists to
make visible.

## Write the program against the tags

Nothing in the program names this package. It asks for Effect's service tags,
so the same code runs under [`NodeHost`](/api/platform-node) or
[`BunHost`](/api/platform-bun) unchanged:

```ts
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner

  yield* fileSystem.makeDirectory("/workspace", { recursive: true })
  yield* fileSystem.writeFileString("/workspace/notes.txt", "hello from the tab\n")

  const fromBash = yield* spawner.string(
    ChildProcess.make("cat", ["notes.txt"], { cwd: "/workspace" })
  )
  const fromFileSystem = yield* fileSystem.readFileString("/workspace/notes.txt")

  return { fromBash, fromFileSystem }
})
```

`cwd` is an absolute path inside the volume. A tab has no `process.cwd()`, so a
relative `cwd` has nothing meaningful to resolve against.

## Run it

```ts
console.log(await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.orDie)))
```

Load the page. The console prints the same string twice, once through the
interpreter and once through the filesystem adapter:

```text
{ fromBash: 'hello from the tab\n', fromFileSystem: 'hello from the tab\n' }
```

If `fromBash` is empty and `fromFileSystem` is not, the interpreter and the
adapter are on different mounts. That failure and its fix are in
[Troubleshooting](./troubleshooting.md#a-command-cannot-see-a-file-the-filesystem-just-wrote).

## Make the writes survive a reload

ZenFS fronts IndexedDB and OPFS with a synchronous mirror and writes back
asynchronously, so a returned write does not mean bytes reached storage. Call
the mount's `sync()` after writes that must survive a reload. This package
never syncs for you: it does not own the mount.

## What just happened

`BrowserServices.layer` built two adapters over one volume. The write went
through Effect's `FileSystem`, which this package implements over the ZenFS
promises API. The read went through `ChildProcessSpawner`, which this package
implements by handing a rendered command line to the in-page interpreter and
replaying its captured output. Both are ordinary Effect services, so nothing
above them knows it is running in a tab.

The output is buffered, not streamed: the interpreter runs to completion and
the handle then replays what it captured. That, and every other place a tab
diverges from a process table, is in
[Run a command in a tab](./guides/run-a-command.md).

## Next steps

- [Compose the browser host bundle](./guides/compose-the-host.md): add the
  wasm-backed `Jj` and the fetch-backed `HttpClient` for the complete Host.
- [Injected backends](./concepts/injected-backends.md): why the layers are
  functions, and what the one-mount rule protects.
- [The isolation attestation](./concepts/isolation-attestation.md): what
  `BrowserFileSystem.layer` claims to the capability kernel that
  `BrowserFileSystem.make` does not.
