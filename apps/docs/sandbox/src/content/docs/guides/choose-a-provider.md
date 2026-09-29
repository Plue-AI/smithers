---
title: "Choose a provider"
description: "Pick one of the ten bundled machine providers by what you need from it, construct it, and look one up by name at the host's composition root."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/sandbox/docs/guides/choose-a-provider.md"
---

All ten providers implement `Sandbox.Provider`, so the composition around them
is identical and only the construction differs. Choose on four questions: what
boundary you need, whether output has to be byte exact, whether you need to
stop a running command, and what the provider costs to run.

## The ten, side by side

| Provider              | A machine is                                                         | Needs                                            | Byte-exact command output | Declares `kill` |
| --------------------- | -------------------------------------------------------------------- | ------------------------------------------------ | ------------------------- | --------------- |
| `DirectorySandbox`    | one host directory                                                   | nothing beyond host services                     | yes                       | yes             |
| `JustBashSandbox`     | one directory in a shared virtual filesystem, interpreted in process | a just-bash instance                             | no                        | no              |
| `CommandSandbox`      | whatever an argv prefix reaches: `ssh`, `docker exec -i`, or `[]`    | the prefix's CLI; the guest's `sh` and `base64`  | yes                       | yes             |
| `ContainerSandbox`    | one container held on `sleep infinity`                               | a Docker-compatible CLI                          | yes                       | yes             |
| `KubernetesSandbox`   | one Pod held on `sleep infinity`                                     | `kubectl` and a cluster                          | yes                       | yes             |
| `MicrosandboxSandbox` | one local microVM                                                    | a Microsandbox host                              | yes                       | yes             |
| `VercelSandbox`       | one persistent Vercel sandbox                                        | Vercel credentials                               | no                        | no              |
| `DaytonaSandbox`      | one named Daytona sandbox                                            | a Daytona client                                 | no                        | no              |
| `AwsSandbox`          | one Fargate task                                                     | ECS, the `aws` CLI, and `session-manager-plugin` | no                        | yes             |
| `CloudflareSandbox`   | one Sandbox Durable Object                                           | a Worker binding                                 | no                        | no              |

"Byte-exact command output" is about a command's own `stdout` and `stderr`.
File transfer is byte exact on all ten, so a caller that needs bytes out of a
command has the command write a file and reads that back with `readFile`.

A provider without `kill` cannot stop one command without tearing down the
session. Closing the session's scope still ends the machine, and every command
in it with the machine.

For what each boundary actually is, read
[What a sandbox does and does not prevent](/concepts/isolation/). For the
per-provider mechanics (reattachment, environment delivery, signal design, and
the honest limits of each transport), read the provider sections of the
[API reference](/reference/api/).

## Construct one

Each provider takes its dependencies as values, so the package never reaches
for an ambient host.

```ts
import { ContainerSandbox, DirectorySandbox, MicrosandboxSandbox } from "@smthrs/sandbox"
import * as Microsandbox from "microsandbox"

const local = DirectorySandbox.make({ fs, spawner, root: "/var/tmp/smithers" })

const contained = ContainerSandbox.make({
  spawner,
  image: "node:22"
})

const microVm = MicrosandboxSandbox.make({
  sdk: Microsandbox,
  image: "oven/bun:1",
  persistence: "sticky",
  cpus: 2,
  memoryMib: 2048,
  network: "none"
})
```

`fs` and `spawner` are Effect's `FileSystem` and `ChildProcessSpawner`, taken
from the host that composes the provider. For `DirectorySandbox`, the spawner
must carry a platform lifecycle: use `NodeHost.layerContained()` or
`BunHost.layerContained()` with a `ProcessLedger`, as in the
[quickstart](/quickstart/). Raw and deadline-only spawners are refused
before the workspace is created.

`ContainerSandbox` defaults to the engine's `none` network. Set `network`
explicitly to opt the container into an egress-capable engine mode.

## Select one by name

The engine takes a `Sandbox.Provider` value and never looks a name up.
`MicrosandboxSandbox` is the recommended default: a microVM is the only bundled
backend that can hold a declared Nix environment. A host that lets an operator
name a provider keeps the lookup at its own composition root, where a provider
from another package joins it the same way, and refuses a name it does not
hold instead of falling back to a weaker sandbox:

```ts
import { RemoteChildProcessSpawner, type Sandbox } from "@smthrs/sandbox"
import { Effect } from "effect"

const providers: Record<string, Sandbox.Provider> = { microsandbox: microVm, directory: local }

const selectProvider = (name: string) => {
  const provider = providers[name]
  if (provider !== undefined) return Effect.succeed(provider)
  const message = `sandbox: no provider named ${name}`
  return Effect.fail(new RemoteChildProcessSpawner.ProviderError({ code: "unavailable", message }))
}
```

## Run a Nix environment in the microVM

`MicrosandboxSandbox` accepts the flake text rather than a path, because this
package reads no host files. Whoever composes the provider reads them, from a
checkout, a fixture, or a
[workspace's declared environment](https://github.com/smithersai/smithers/blob/main/packages/smithers/build/docs/concepts/environments.md):

```ts
const provider = MicrosandboxSandbox.make({
  sdk: Microsandbox,
  persistence: "sticky",
  environment: { flake: flakeText, lock: lockText, attr: "ci" }
})
```

With an environment and no `image`, the microVM boots `nixos/nix`. `acquire`
writes the two files into the workspace, realises the closure once with
`nix develop ... --command true` before handing the session out, and then runs
every command under it. A flake that does not evaluate fails the acquire with
`unavailable`, carrying `nix develop`'s exit code and stderr, and the booted
machine is stopped.

Boot stays fast through the store: a `sticky` session keeps the realised
closure across acquires, and a snapshot taken after the warm boots with it
already realised.

## Read next

- [Place a flow body on a machine](/guides/place-a-flow-body-on-a-machine/).
- [Limits](/limits/): where a provider buffers whole, and what that costs.
