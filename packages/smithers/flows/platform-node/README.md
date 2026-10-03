# @smthrs/platform-node

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

**Documentation:** https://platform-node.smithers.sh

The Node.js Host bundle for Smithers. One layer, `NodeHost.layer`, provides the
five services a program runs its side effects through: a filesystem, a path
helper, a child-process spawner, a [Jujutsu](https://jj-vcs.github.io/jj/)
adapter, and an HTTP client.

`@effect/platform-node` already ships Node implementations of most of those, and
this package uses them where they fit. Three guarantees are not ones a
general-purpose adapter makes, so this package implements them itself:

- **A filesystem a symlink cannot redirect.** `AtomicFileSystem` opens the
  workspace root once, walks each component with `O_NOFOLLOW`, and performs the
  final syscall relative to a pinned directory descriptor, so a path swapped
  between the permission check and the operation cannot redirect it.
- **Child processes a crashed host does not leave behind.**
  `NodeHost.layerContained` gives every child a `SIGTERM`-then-`SIGKILL`
  deadline and a durable ledger record, and sweeps the records a previous
  incarnation abandoned while the layer is built.
- **An honest answer about whether a run's owner is still alive.**
  `HostLiveness.isAlive` is the probe a durable engine consults before it takes
  a run some other process recorded itself as owning. Ambiguity resolves toward
  alive, because stranding a run is cheaper than running it twice.

## Availability

`@smthrs/platform-node` is not on npm at 1.0.0-rc.0. Its source lives in the
[smithers repository](https://github.com/smithersai/smithers), and the
[installation page](https://platform-node.smithers.sh/installation/) covers how
to depend on it from a checkout and the `effect` version it pins.

On POSIX, filesystem confinement requires Node.js 26.4.0 or later and the
`smithers-jj-export` native helper. From a source checkout, build it with:

```sh
cargo build --locked --release -p smithers-ffi --bin smithers-jj-export
```

Install the Rust toolchain `rust-toolchain.toml` pins with `rustup toolchain install`
if needed. The host finds `target/release/smithers-jj-export`
automatically. Packaged installs supply a platform helper; an operator-managed
installation can set `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` to its absolute path.
A missing helper refuses confined operations, including MCP flow discovery.

## Run a command through the host

```ts
import { NodeHost } from "@smthrs/platform-node"
import { Effect } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("git", ["status", "--short"]))
})

Effect.runPromise(Effect.provide(program, NodeHost.layer))
```

`ChildProcess` and `ChildProcessSpawner` are Effect's own tags. The same layer
also provided the `FileSystem`, `Path`, `Jj`, and `HttpClient` that program did
not ask for.

## Layers

| Layer                              | What it adds                                                      |
| ---------------------------------- | ----------------------------------------------------------------- |
| `NodeHost.layer`                   | the five tags, with `Jj` bound to the process working directory   |
| `NodeHost.layerAt(root)`           | the same, with `Jj` pinned to one absolute repository root        |
| `NodeHost.layerContained(options)` | process containment: kill deadlines, ledger records, a reap sweep |
| `NodeHost.layerContainedAt(...)`   | both, which is what the flow engine's `NodeRuntime` composes      |

The contained layers require a `ProcessLedger`, because the durable half of
containment is only as good as the journal underneath it. `ProcessLedger.layer`
inherits a crashed incarnation's processes; `ProcessLedger.layerMemory` contains
this one and nothing more.

```ts
import { ProcessLedger } from "@smthrs/kernel"
import { NodeHost } from "@smthrs/platform-node"
import { Layer } from "effect"

const host = Layer.provide(
  NodeHost.layerContained({ graceMs: 2000 }),
  ProcessLedger.layer({ hostId: "engine-1", ownerPid: process.pid })
)
```

The contained spawner prepares a supervisor and records its identity before
activating the target. On POSIX `handle.pid` names that owner, while
`exitCode` and `isRunning` describe the target. Natural target exit still
cleans up its owned group, including children holding output open. Use the
handle's `kill` for signal delivery; cleanup failure retains the ledger record.
`ScopedProcess` supplies this lifetime policy for transient commands without a
durable ledger, and exposes the separate native `Handle.targetPid` for diagnostics.
Its native control sockets use the private `TMPDIR` and short relative Unix
addresses in deep workspaces. The owner starts in its owned socket directory,
so removing the caller's working directory does not prevent owner startup. An address exceeding the platform limit is
refused without falling back to another directory.

Complete host bundles require jj 0.39.0 or newer. Construction probes the binary through its selected runner; a contained host records and retires this probe in its process ledger and can fail with `JjError` (`not_installed` or `unsupported_version`). Repository commands use the selected process runner.

## Modules

The barrel exports four namespaces: `NodeHost`, `HostLiveness`,
`ProcessReaper`, and `ScopedProcess`. `AtomicFileSystem` is deliberately not among them; it is reached
as `NodeHost.AtomicFileSystem` or through the
`@smthrs/platform-node/AtomicFileSystem` subpath.

| Module             | What it provides                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NodeHost`         | the complete closed Host bundle, plus re-exports of `AtomicFileSystem`, `ProcessReaper`, `NodeCrypto`, and Effect's raw `NodeFileSystem`, spawner, and `HttpClient`                  |
| `AtomicFileSystem` | the descriptor-relative, no-follow filesystem layer and its options, ceilings, and glob grammar                                                                                      |
| `HostLiveness`     | whether a recorded run owner is still alive: `isAlive`, `Owner`, `Options`                                                                                                           |
| `ProcessReaper`    | live containment and restart reconciliation: `layerSpawner`, `SpawnerOptions`, `processLifecycle`, `reap`, `layer`, `System`, `Refusal`, `posixSystem`, `windowsSystem`, `systemFor` |
| `ScopedProcess`    | transient scoped commands with the same lifecycle: `Options`, `Handle`, `spawn`, `Status`, `status`                                                                                  |

`NodeCrypto` is re-exported for a different reason than the rest: `Crypto` is not
a Host service, so it is not in the closed list, but every durable composition
needs one and a program that already depends on this package for its host should
not need a second dependency for the digest.

## What the bundle does not provide

**There is no shell service.** Running a command is Effect's `ChildProcess` and
`ChildProcessSpawner`, so a wall-clock budget is `Effect.timeout` around the
effect and cancellation is fiber interruption, not an `AbortSignal`.

**There is no HTTP service.** An outgoing request is Effect's `HttpClient`,
provided here as `NodeHttpClient.layerUndici`. Undici installs no redirect
interceptor, so every hop stays a separate, checkable request.

Both are what lets [`@smthrs/kernel`](https://kernel.smithers.sh) check
`proc:spawn` against the rendered command line before any process starts, and
`net:get` / `net:post` against the host of every URL a request reaches,
redirect targets included. Wrap the bundle in its `HostServices.layer` to get
that permission-aware projection.

## Where this sits

[`@smthrs/flows`](https://flows.smithers.sh) is the durable flow engine: flows,
actions, the journal, and the runtime that replays a crashed run from where it
stopped. It deliberately re-exports no `@smthrs/platform-*` package, for the
same reason `effect`'s own index does not re-export `@effect/platform-node`:
the program that runs picks its platform. So a Node program installs
`@smthrs/flows` for the engine and this package for the machine underneath it,
and its `NodeRuntime` composes `NodeHost.layerContainedAt` plus
`HostLiveness.isAlive` from one options object.

## Read next

The documentation site covers the rest: [the host bundle](https://platform-node.smithers.sh/concepts/host-bundle/), [the descriptor-relative filesystem](https://platform-node.smithers.sh/concepts/descriptor-relative-filesystem/)
and everything it refuses, [process containment](https://platform-node.smithers.sh/concepts/process-containment/)
and every guard checked before a reap, the [API reference](https://platform-node.smithers.sh/reference/api/), and
[troubleshooting](https://platform-node.smithers.sh/troubleshooting/).

For a different runtime, the sibling bundles are
[`@smthrs/platform-bun`](https://platform-bun.smithers.sh) and
[`@smthrs/platform-browser`](https://platform-browser.smithers.sh).

The host exports `implementationIds` for its five service slots. Its rooted
factories reject invalid roots before constructing a layer, using the host's
own error with code `invalid_repository_root`.

The atomic filesystem supports descriptor-based `chmod` and `chown` on regular files so replacements can preserve permissions and ownership. Symlinks, hard-linked files, directories, and special files are refused by this boundary.
