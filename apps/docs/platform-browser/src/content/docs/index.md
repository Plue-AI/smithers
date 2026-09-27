---
title: "@smthrs/platform-browser"
description: "Effect's FileSystem and ChildProcessSpawner inside a browser tab, over a virtual filesystem the page mounts and a bash interpreter that runs in the page."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-browser/docs/README.md"
---

`@smthrs/platform-browser` gives a browser tab two Effect platform services it
otherwise cannot have: `FileSystem`, over a virtual filesystem the page mounts,
and `ChildProcessSpawner`, over a bash interpreter that runs inside the page.
Code written against Effect's service tags runs in a tab without changing a
line.

## What it solves

Effect's own browser platform package covers HTTP, sockets, workers, key-value
storage, and crypto. It ships neither a `FileSystem` nor a
`ChildProcessSpawner`, because a tab has no `node:fs` and cannot fork a
process. Any program that reads a file or runs a command stops at the browser:
you rewrite it against a bespoke storage API, or you leave it on a server and
talk to it over the network.

A tab can serve both, given two objects the page supplies itself: a virtual
filesystem, such as ZenFS over IndexedDB, OPFS, or memory, and an in-page bash
interpreter, such as just-bash. This package is the adapter pair that turns
those two objects into Effect's services. Neither backend is a dependency here.
Each arrives as a function argument, so the page chooses which storage backend
is mounted, and your bundle carries no vendor code this package picked for you.

Both adapters state their limits rather than hiding them. A mounted volume has
no symlink creation, no writable file handles, and no watcher, so those
operations fail with a typed `PlatformError` instead of pretending to succeed,
and the spawner refuses a process pipeline rather than silently running half of
it. [Troubleshooting](/troubleshooting/) lists every refusal with the change
that resolves it.

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

[Installation](/installation/) covers which backend each adapter needs,
and the `effect` version the peer dependency pins.

## Write a file in the tab, then count its lines with a command

The snippet mounts one volume, writes a file through Effect's `FileSystem`,
then counts its lines with `wc`, which runs in the tab:

```ts
import { BrowserServices } from "@smthrs/platform-browser"
import { configureSingle, fs } from "@zenfs/core"
import { IndexedDB } from "@zenfs/dom"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { Bash } from "just-bash"

await configureSingle({ backend: IndexedDB })

/** Two views of one volume: the interpreter's, and the promises API the adapter reads. */
const layer = BrowserServices.layer({ bash: new Bash({ fs }), fs: fs.promises })

const program = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner

  yield* fileSystem.makeDirectory("/workspace", { recursive: true })
  yield* fileSystem.writeFileString("/workspace/notes.txt", "one\ntwo\nthree\n")

  return yield* spawner.string(
    ChildProcess.make("wc", ["-l", "notes.txt"], { cwd: "/workspace" })
  )
})

console.log(await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.orDie)))
```

The program itself names nothing from this package. It asks for
`FileSystem.FileSystem` and `ChildProcessSpawner`, so the same code runs under
[`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/) or
[`@smthrs/platform-bun`](https://platform-bun.smithers.sh/reference/api/) unchanged.

The one rule the design turns on is visible in the layer line: `bash` and `fs`
are two views of a single mount. Build them over different mounts and nothing
raises an error, because both objects are valid; the command simply reads a
file the write never reached. [Injected backends](/concepts/injected-backends/)
explains the rule, and the [Quickstart](/quickstart/) walks the same program
end to end.

## How this fits with @smthrs/flows

[`@smthrs/flows`](https://flows.smithers.sh/reference/api/) is the durable flow engine these adapters were
built for. A flow runs on a **host**, which is a closed set of five service
tags: `FileSystem`, `Path`, `ChildProcessSpawner`, `Jj`, and `HttpClient`.
Provide those five and a flow runs; where it runs is a composition detail the
flow never sees. `@smthrs/flows` ships the Node host and the durable engine
around it, and it deliberately re-exports no platform bundle, because the
program that runs picks its own. `BrowserHost.layer` from this package is that
pick for a tab: the same five tags, backed by a mount, an in-page interpreter,
Effect's `fetch` client, and jj compiled to WebAssembly. See
[The closed Host surface](/concepts/host-bundle/), and
[Compose the browser host bundle](/guides/compose-the-host/) for the wiring.

Those five tags carry the memory engine and the capability kernel into a tab,
but not the durable engine: its shipped `SqlClient` uses `node:sqlite` and
`NodeRuntime` is Node-only, so providing the Host supplies no browser database
and does not make durable execution portable.

You need none of that to use the two adapters on their own.
`BrowserServices.layer` is an ordinary Effect platform layer, and a page that
wants a filesystem and a shell can stop there.

Above `@smthrs/flows` sits [`@smthrs/cli`](https://cli.smithers.sh/reference/api/), the `smthrs` command that
finds flows in a project, plans them, runs them, and reads their events back.
It runs flows on a machine rather than in a tab, so it composes the Node host;
this package is what the same engine uses when the page is the machine.

## Next steps

- [Installation](/installation/): the backends you supply, the import forms,
  and what bundles for a browser.
- [Quickstart](/quickstart/): one mount, one command, one file, proven from
  both sides.
- [Injected backends](/concepts/injected-backends/): why the layers are
  functions, and what the one-mount rule protects.
- [Run a command in a tab](/guides/run-a-command/): working directories,
  environment, buffered output, cancellation, and what the spawner refuses
  rather than fakes.
- [Read and write files on a mounted volume](/guides/work-with-files/): the
  operations a mounted volume serves, and what the rest answer with.
- [API reference](/reference/api/): every public export.
