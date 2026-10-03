# @smthrs/sandbox

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://sandbox.smithers.sh

Provisioned machines, provider-neutral remote process execution, and sandbox
liveness for flows. A provider adapts its SDK session to one of two seams:
`RemoteChildProcessSpawner.Provider`, which can only run a command line, or
`Sandbox.Provider`, which owns a machine's whole lifecycle and its filesystem.
This package derives Effect's host services, two conformance suites, health,
and supervision from those seams, and ships ten machine providers built on
them.

It implements no isolation of its own. What a sandbox does and does not prevent
differs per provider and is documented at
https://sandbox.smithers.sh/concepts/isolation/.

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

## Public API

Every namespace below is also its own import subpath.

| Namespace                   | Import                                      | What it is                                                                    |
| --------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| `RemoteChildProcessSpawner` | `@smthrs/sandbox/RemoteChildProcessSpawner` | Remote implementation of Effect's `ChildProcessSpawner`.                      |
| `ProviderConformance`       | `@smthrs/sandbox/ProviderConformance`       | The conformance suite a provider implementation must pass.                    |
| `Sandbox`                   | `@smthrs/sandbox/Sandbox`                   | The provisioned-machine contract and its projections.                         |
| `SandboxConformance`        | `@smthrs/sandbox/SandboxConformance`        | The conformance suite a sandbox session provider must pass.                   |
| `SandboxMerge`              | `@smthrs/sandbox/SandboxMerge`              | Lands a session's captured work in a host jj repository as one change.        |
| `DirectorySandbox`          | `@smthrs/sandbox/DirectorySandbox`          | The scratch-directory sandbox provider.                                       |
| `CommandSandbox`            | `@smthrs/sandbox/CommandSandbox`            | The argv-prefix sandbox provider, over `ssh`, `docker exec`, or this machine. |
| `ContainerSandbox`          | `@smthrs/sandbox/ContainerSandbox`          | The container-lifecycle sandbox provider, over a Docker-compatible CLI.       |
| `KubernetesSandbox`         | `@smthrs/sandbox/KubernetesSandbox`         | The Pod-per-session sandbox provider, over `kubectl`.                         |
| `JustBashSandbox`           | `@smthrs/sandbox/JustBashSandbox`           | The in-process interpreter sandbox provider, for hosts that cannot spawn.     |
| `MicrosandboxSandbox`       | `@smthrs/sandbox/MicrosandboxSandbox`       | The Microsandbox microVM provider.                                            |
| `VercelSandbox`             | `@smthrs/sandbox/VercelSandbox`             | The Vercel Sandbox provider.                                                  |
| `DaytonaSandbox`            | `@smthrs/sandbox/DaytonaSandbox`            | The Daytona sandbox provider.                                                 |
| `AwsSandbox`                | `@smthrs/sandbox/AwsSandbox`                | The AWS ECS task provider.                                                    |
| `CloudflareSandbox`         | `@smthrs/sandbox/CloudflareSandbox`         | The Cloudflare Durable Object provider.                                       |
| `SandboxHealth`             | `@smthrs/sandbox/SandboxHealth`             | Sandbox health-check contracts.                                               |
| `SandboxSupervision`        | `@smthrs/sandbox/SandboxSupervision`        | Heartbeat supervision over a remote sandbox session.                          |

`DirectorySandbox` requires `sh` on `PATH`, including on Windows.

Opening a provider is scoped, so interruption closes the layer scope and runs
the provider's cancellation finalizer. No `AbortSignal` crosses this seam.
`Provider.kill` and `Provider.ping` are optional: a provider that implements
them can stop one command without tearing down its session and can be
supervised, and a provider that omits them keeps the narrower contract.
Standard input is not optional. A provider that declares `stdin: true` receives
a command's input collected whole; a provider that does not is handed an
input-fed command's refusal instead, so the bytes are never silently dropped.
Additional file descriptors, `stdin: "inherit"`, custom shell paths, detached
processes, and non-default pipeline routing fail with a `BadArgument`
`PlatformError`, because the provider contract cannot preserve their semantics.
Output `pipe`, `ignore`, and `inherit` options and output sinks are
honored by the adapter.

The package is browser-bundleable: it adapts a provider a caller hands it and
owns no host access of its own.

```ts
import { RemoteChildProcessSpawner } from "@smthrs/sandbox"
import { Effect } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const provider = RemoteChildProcessSpawner.TestRemote.make({
  scripts: { "echo hi": { stdout: "hi" } }
})

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("echo", ["hi"]))
}).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))

Effect.runPromise(program)
```

A `Sandbox.Provider` goes further: `acquire` hands back one held machine with
byte-typed file transfer beside the same spawn, and `Sandbox.layerHost` places
`ChildProcessSpawner`, `FileSystem`, `Path`, and `SandboxHealth` on it, which
is the host surface an agent's standard tools consume.

```ts
import { ContainerSandbox, Sandbox } from "@smthrs/sandbox"

const provider = ContainerSandbox.make({ spawner, image: "node:22" })
const session = "run:01J..."
const host = Sandbox.layerHost(provider, { session })
```

`ContainerSandbox` passes `--network none` when `network` is omitted. Set an
engine network mode explicitly to opt into egress.

Container images must provide Linux GNU or BusyBox utilities, including
`stat -c`, `mktemp -d`, and `ln -T`. The native filesystem exposes real modes
and ownership, and supports exclusive `wx` writes through a completed sibling
file and an atomic hard link. Existing files, symlinks, directories, and FIFOs
are never overwritten by an exclusive write. Ordinary writes support `w`
without an explicit mode; other flags are refused. Standard write and edit
tools use these operations to replace files while preserving their metadata.

`Sandbox.run` holds one machine for one unit of work and returns the body's
result with the `Work` its checkout gained, a git diff from a base the host can
fetch. `SandboxMerge.apply` lands that work in a host jj repository as one
change, recording conflicts the way `jj rebase` does. See
[Return work from a sandbox](https://sandbox.smithers.sh/guides/return-work-from-a-sandbox/).

A provider that can be pinged can also be supervised. `SandboxSupervision`
probes the open session on a cadence and retires it when the probe says it is
dead, so the commands running in it fail instead of waiting forever and a
retry policy lands the work on a fresh session. Project the lifecycle provider
onto the command-provider contract and declare the container session's capabilities:

```ts
import { SandboxSupervision } from "@smthrs/sandbox"

const commandProvider = Sandbox.commandProvider(provider, {
  session,
  provides: { ping: true, kill: true }
})
const supervised = SandboxSupervision.layer(commandProvider, {
  interval: "10 seconds",
  tolerance: 2
})
```

A provider proves its adapter with `ProviderConformance.check` or, for a
lifecycle provider, `SandboxConformance.check`. Both run the contract as
behavior through the real adapter layer and report every check that did not
hold. `signals-a-running-command` watches the process rather than the call: a
`kill` that answers success and leaves the command running satisfies the type
and leaks a process for every cancelled action, so the check waits
`Commands.stopsWithin` for the command to stop and names it when it does not.

`DirectorySandbox` requires a lifecycle-backed contained spawner, such as
`NodeHost.layerContained()` provided with a `ProcessLedger`. It refuses raw or
deadline-only spawners before creating a workspace. Explicit kill and every
spawn-scope close delegate to the contained handle; an observed target exit
does not skip cleanup, and cleanup failure fails release.

`DirectorySandbox` starts local children with a replacement environment. The
host contributes only `PATH`, `HOME`, `USER`, `LANG`, `LC_*`, `TERM`, `TMPDIR`,
and `SHELL`; `Session.spawn` adds the names its caller explicitly declares.
Ambient credentials and other unrelated host variables do not enter the
directory-backed session. This narrows credential exposure, but it does not
turn a host directory into a filesystem, user, or network security boundary.

## Limits

See [Limits](https://sandbox.smithers.sh/limits/) for operation bounds,
buffering, and provider-specific byte fidelity.

See the [API reference](https://sandbox.smithers.sh/reference/api/) and the
[kernel reference](https://kernel.smithers.sh/reference/api/).
