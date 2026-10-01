---
title: "Run commands through a transport"
description: "Adapt a spawn-only provider onto Effect's ChildProcessSpawner with RemoteChildProcessSpawner.layer, and know which constructor to reach for when an open failure must be visible."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/sandbox/docs/guides/run-commands-through-a-transport.md"
---

Use this seam when something else already provisioned the machine and all you
need is to run commands on it. For a backend you also provision, use
[`Sandbox.layerHost`](/guides/place-a-flow-body-on-a-machine/), which gives you a
filesystem on the same session.

## The layer

```ts
import { RemoteChildProcessSpawner } from "@smthrs/sandbox"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const provider = RemoteChildProcessSpawner.TestRemote.make({
  scripts: { "echo hi": { stdout: "hi" } }
})

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("echo", ["hi"]))
}).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
```

Provider acquisition is tied to the layer scope. Interrupting an execution or a
stream consumer closes that scope and runs the finalizer `Provider.open`
installed. No `AbortSignal` crosses this seam.

Read [How a remote command differs from a local one](/concepts/remote-commands/)
before you port existing `ChildProcess` code onto it.

## Choose a constructor

Three constructors sit behind the layer, and they differ in exactly one way:
what happens when the session cannot be opened.

| Constructor            | On an open failure                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `layer(provider)`      | builds a spawner whose every command fails with the open error                                   |
| `make(provider)`       | the same, as an effect in the caller's scope                                                     |
| `makeOpened(provider)` | fails in the caller's scope, so the caller can tell an opened session from one that did not open |

`layer` and `make` keep the failure on the action that tried to run something
rather than on whatever was building the layer, which is usually what you want:
a host that never spawns anything should not fail at composition time.

Reach for `makeOpened` when you are building something that reopens sessions. A
supervisor that cached `make`'s result as a live generation would replay one
open failure for the life of the layer without ever calling `open` again. That
is why `SandboxSupervision` is built on `makeOpened`.

## What the adapter does with the command

The command reaches the provider as the string `CommandLine.render` produces,
with `cwd` and `env` alongside it. A `PipedCommand` renders into one line, so
the `|` reaches the remote shell.

Failures are normalized: `timeout` becomes `TimedOut`, `unavailable` and
`not_found` become `NotFound`, and everything else becomes `Unknown`, all under
the `ChildProcess` module the sibling spawners name. The original
`ProviderError` is on `PlatformError.cause` when you need the distinction back.

## Give the seat a name it will keep

`Provider.session` is the stable, provider-neutral session key `open` is called
with. Every bundled provider derives its machine's name from that key, so the
key is durable machine identity rather than a label; see
[Sessions and their keys](/concepts/sessions/).

## Read next

- [Supervise a session](/guides/supervise-a-session/): make a dead session fail its
  commands instead of leaving them waiting.
- [Prove a provider](/guides/prove-a-provider/): run the contract against your
  adapter.
