---
title: "@smthrs/platform-node"
description: "The Node.js host bundle for Smithers flows: Effect's Node platform services plus a filesystem a symlink cannot redirect, child processes a crashed host does not abandon, and a run-owner liveness probe."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-node/docs/README.md"
---

`@smthrs/platform-node` provides the five services a program on Node.js runs
its side effects through: a filesystem, a path helper, a child-process spawner,
a [Jujutsu](https://jj-vcs.github.io/jj/) adapter, and an HTTP client. One
layer, `NodeHost.layer`, provides all five.

That set is the host surface of [Smithers](https://smithers.sh/docs/), a durable
engine for long-running agent work whose packages carry the `@smthrs` scope.
This package is the Node.js machine a Smithers flow runs on, and it is usable
on its own by any Effect program that wants the same guarantees.

## Availability

`@smthrs/platform-node` is not on npm at 1.0.0-rc.0. Its source lives in the
[smithers repository](https://github.com/smithersai/smithers), and
[Installation](/installation/) covers how to depend on it from a checkout
and which `effect` version it pins.

## What it solves

Effect already ships Node implementations of most of those services, and this
package uses them where they fit. Three guarantees are not ones a
general-purpose adapter makes, so this package implements them itself.

**A filesystem a symlink cannot redirect.** A permission check names a path,
and a path-based operation resolves that path again when it runs. Anything with
write access to the directory can swap a component for a symlink in between, so
the operation authorized for one file performs on another. `AtomicFileSystem`
closes that window: it opens the workspace root once, walks each component with
`O_NOFOLLOW`, and performs the final syscall relative to a pinned directory
descriptor, which names an inode rather than a name.

**Child processes a crashed host does not leave behind.** A host killed
outright runs no finalizer, so the agents and builds it started keep running
with nobody left to signal them. `NodeHost.layerContained` gives every child a
`SIGTERM`-then-`SIGKILL` deadline and a durable ledger record, and sweeps the
records a previous incarnation abandoned while the layer is built. The POSIX
supervisor keeps ownership after a natural target exit and requests cleanup
when its private parent connection closes. Cleanup must be verified before a
record retires.

**An honest answer about whether a run's owner is still alive.**
`HostLiveness.isAlive` is the probe a durable engine consults before it takes a
run some other process recorded itself as owning. Both ways of being wrong cost
something, so the rule resolves ambiguity toward alive: stranding a run is
cheaper than running it twice.

## Run something through the host

Provide `NodeHost.layer` to any program that asks for a host service. This one
asks for the spawner:

```ts
import { NodeHost } from "@smthrs/platform-node"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("git", ["status", "--short"]))
})

console.log(await Effect.runPromise(Effect.provide(program, NodeHost.layer)))
```

`ChildProcess` and `ChildProcessSpawner` are Effect's own tags. There is no
Smithers wrapper around either: a wall-clock budget is `Effect.timeout` around
the effect, and cancelling a command is fiber interruption. The same layer also
provided the `FileSystem`, `Path`, `Jj`, and `HttpClient` that program did not
ask for, and the filesystem in it is the confined one described earlier. The
[quickstart](/quickstart/) runs a program that reads a file through it and
watches a symlink escape get refused.

Running this bundle needs Node.js 26.4.0 or later and the `smithers-jj-export`
helper, which `AtomicFileSystem` uses for the descriptor-relative syscalls Node
does not expose. [Installation](/installation/) covers the requirement,
where it fails when it is missing, how to point at a different helper, and the
Effect peers your project pins.

## How this relates to @smthrs/flows

[`@smthrs/flows`](https://flows.smithers.sh/reference/api/) is the single dependency that carries the whole
Smithers durable flow engine: flows, actions, the journal, and the runtime that
replays a crashed run from where it stopped. It deliberately does not
re-export any `@smthrs/platform-*` package, for the same reason `effect`'s own
index does not re-export `@effect/platform-node`: the program that runs picks
its platform, not the library it depends on. So a Node program installs
`@smthrs/flows` for the engine and this package for the machine underneath it.

Once both are installed, `@smthrs/flows`' `NodeRuntime` module builds the whole
durable composition from one options object, and what it composes from here is
`NodeHost.layerContainedAt` plus `HostLiveness.isAlive`. Read this site when
you want to know what those layers guarantee, configure the filesystem helper,
or diagnose a refusal. Reach for this package on its own when you want the host
services without the engine.

Above both sits the `smithers` command-line tool,
[`@smthrs/cli`](https://cli.smithers.sh/reference/api/), which runs flows without you composing anything.
For a different runtime, the sibling bundles are
[`@smthrs/platform-bun`](https://platform-bun.smithers.sh/reference/api/) and
[`@smthrs/platform-browser`](https://platform-browser.smithers.sh/reference/api/).
[`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/) owns the closed list of five host tags and
wraps each one with the capability check that makes the confinement above
enforceable.

## Where to go next

- [Installation](/installation/): peers, host prerequisites, import forms,
  and what a capability-checked composition adds.
- [Quickstart](/quickstart/): run a command, then read a file through the
  guarded host and watch an escape refused.
- [The host bundle](/concepts/host-bundle/): the five tags, the four layers,
  and what this package deliberately does not provide.
- [The descriptor-relative filesystem](/concepts/descriptor-relative-filesystem/):
  how the confinement works and what each call costs.
- [Process containment](/concepts/process-containment/): incarnations, the
  ledger, and every guard checked before a reap.
- [API reference](/reference/api/): every export, layer, and option.
- [Troubleshooting](/troubleshooting/): the refusals this bundle reports and
  which of them are the safe answer.

The host exports `implementationIds` for its five service slots. Its rooted
factories reject invalid roots before constructing a layer, using the host's
own error with code `invalid_repository_root`.
