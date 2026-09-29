---
title: "@smthrs/platform-bun"
description: "The Bun host bundle for Smithers: one Effect layer that fills the five services a program reaches the outside world through, with optional containment for the processes it spawns."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-bun/docs/README.md"
---

`@smthrs/platform-bun` is the Bun host bundle for Smithers, which runs long jobs
as durable flows: each step is recorded, so a restart resumes what did not
finish instead of starting over. `BunHost.layer` is a single Effect layer that
fills the five services a program reaches the outside world through: the
filesystem, path handling, child processes, version control, and HTTP.

## What it solves

A program that calls `node:fs`, `Bun.spawn`, or a global `fetch` directly cannot
be permission checked, denied, audited, or replayed, because nothing sits
between it and the runtime. Smithers closes the outside world behind five Effect
service tags instead, and a host bundle is the object that fills them. This
package is that object for a process running on Bun.

Composing the same five slots by hand costs you two properties this bundle
already has:

- **A filesystem that survives a symlink race.** The filesystem slot carries
  [`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/)'s `AtomicFileSystem`, so under
  [`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/)'s guard an authorized path operation runs
  against file descriptors and refuses to follow a link, rather than failing
  closed. A symlink swapped in after authorization cannot redirect the write.
- **An HTTP client that stops at a redirect.** The bundle configures Effect's
  egress client without automatic redirects, so a `302`
  comes back to you as a `302` and the second origin is never contacted. A
  client that follows redirects on its own reaches a host nobody authorized.

The bundle also runs on Node.js 26.4.0 or later. The raw child-process spawner
is Effect's Node spawner re-exported; contained POSIX variants use
`ProcessReaper.layerSpawner` and its prepared native adapter. See
[Runtime parity with Node](/concepts/runtime-parity/).

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

`@effect/platform-bun` is a required peer at exactly `4.0.0-rc.115`. Package
managers install it with the other required Effect peers. The filesystem slot
also needs the `smithers-jj-export` helper, and every complete bundle needs
jj 0.39.0 or later because it probes jj while the layer is built.
[Installation](/installation/) covers all three and the import forms.

## Run a command and a file operation through the host

This program names Bun nowhere. It asks for two service tags, and the layer
decides what fills them:

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
  return yield* spawner.string(ChildProcess.make("wc", ["-c", "report.txt"]))
})

Effect.runPromise(Effect.provide(program, BunHost.layer)).then(console.log)
```

Replace `BunHost.layer` with `NodeHost.layer` from
[`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/) and the program above does not
change a character. That portability is what the five tags buy.

Two variants change one slot each. `BunHost.layerAt(root)` binds version control
to one absolute repository root instead of the process working directory, which
a long-lived host wants because the working directory is ambient state anything
can change. `BunHost.layerContained(options)` routes every spawn through a
prepared supervisor with a `SIGTERM`-then-`SIGKILL` deadline. The owner is
recorded before target activation; each pipeline leg has its own record. The
handle's `pid` names the supervisor, and `exitCode` describes the target. A
natural target exit still cleans up its owned group, and only verified cleanup
retires the record. The durable ledger lets a later incarnation reconcile any
retained records.

## How this relates to @smthrs/flows

[`@smthrs/flows`](https://flows.smithers.sh/reference/api/) is the durable flow engine: it records each step of
a long job in a journal, so a restart replays what finished and resumes at what
did not. Steps still have to read files and spawn processes, and this package is
one of the three bundles that let them.

`@smthrs/flows` re-exports no platform bundle on purpose, for the same reason
`effect`'s own index does not re-export `@effect/platform-node`: a platform is
chosen by the program that runs, not by the library it depends on. Its
`NodeRuntime` helper builds a Node host for you, so a program that calls
`NodeRuntime.layerHost` never imports a platform package. A program that runs on
Bun composes this package instead and provides `BunHost.layer` itself.
[`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/) and
[`@smthrs/platform-browser`](https://platform-browser.smithers.sh/reference/api/) are the sibling bundles that
fill the same five slots on their own runtimes.

Above both sits [`@smthrs/cli`](https://cli.smithers.sh/reference/api/), the `smithers` command that finds the
flows in a project, plans them, runs them, and reads their events back. Install
the CLI to run flows from a shell or a CI job, `@smthrs/flows` when the program
that runs them is yours, and this package when that program runs on Bun.

## Where to go next

- [Installation](/installation/): the peer dependency, the
  `smithers-jj-export` helper, the supported runtimes, and the import forms.
- [Quickstart](/quickstart/): the program above, run twice, the second time
  with containment on and a child visible in the ledger.
- [The Host surface on Bun](/concepts/host-surface/): what each of the five
  slots is, whose code fills it, and how to take one service without the other
  four.
- [Contain and reap child processes](/guides/contain-child-processes/): the
  escalation deadline, the ledger, and the sweep that kills what a crashed host
  abandoned.
- [Bind the host to a repository root](/guides/bind-a-repository-root/):
  `layerAt`, `layerContainedAt`, and the refusal they throw.
- [API reference](/reference/api/): every export, with its signature.
- [Troubleshooting](/troubleshooting/): the failures these modules produce,
  and what to change.

The host exports `implementationIds` for its five service slots. Its rooted
factories reject invalid roots before constructing a layer, using the host's
own error with code `invalid_repository_root`.

BunHost includes BunCrypto in every bundle, so ArtifactStore.put composes
with BunHost alone. Crypto remains separate from the five capability slots.
BunHost also re-exports ProcessReaper and HostLiveness from platform-node.
