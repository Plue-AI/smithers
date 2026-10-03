# @smthrs/platform-bun

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect`, `@effect/platform-node`,
`@effect/platform-node-shared`, and `@effect/platform-bun` as exact
`4.0.0-rc.115` peer dependencies. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://platform-bun.smithers.sh

The Bun host bundle for Smithers, which runs long jobs as durable flows: each
step is recorded, so a restart resumes what did not finish instead of starting
over. `BunHost.layer` is a single Effect layer that fills the five services a
program reaches the outside world through: the filesystem, path handling, child
processes, version control, and HTTP.

A program that calls `node:fs`, `Bun.spawn`, or a global `fetch` directly cannot
be permission checked, denied, audited, or replayed, because nothing sits
between it and the runtime. Smithers closes the outside world behind five Effect
service tags instead, and a host bundle is the object that fills them. This
package is that object for a process running on Bun.

## Install

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

`@smthrs/platform-node`, `@effect/platform-node`,
`@effect/platform-node-shared`, `@effect/platform-bun`, and `effect` are
required peers, exactly as `package.json` declares them. Package managers that
resolve required peers install all five automatically; all Effect versions are
exact.

The filesystem slot spawns the `smithers-jj-export` native helper. From a
source checkout, build it with:

```sh
cargo build --locked --release -p smithers-ffi --bin smithers-jj-export
```

Elsewhere, set `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` to its absolute path, or
build the layer with `BunFileSystem.layerWith({ executable })`. `PATH` is never
searched. Windows is unsupported.

## Example

```ts
import { BunHost } from "@smthrs/platform-bun"
import { Effect } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("git", ["status", "--short"]))
})

Effect.runPromise(Effect.provide(program, BunHost.layer))
```

The program names Bun nowhere. It asks for a service tag, and the layer decides
what fills it, so swapping `BunHost.layer` for `NodeHost.layer` from
`@smthrs/platform-node` does not change a character of it.

The complete host bundles require jj 0.39.0 or newer. Each bundle builds its jj
layer with one version probe; construction can fail with `JjError`, including
`not_installed` or `unsupported_version`. The version probe and repository commands use the
selected process runner. Contained bundles record and retire the probe in the
host process ledger. Probe results are cached per resolved absolute executable
path and runner, with a separate cache for each spawner instance.

## Modules

| Module          | What it provides                                                                                                                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BunHost`       | The closed Host bundle: `layer`, `layerAt`, `layerContained`, `layerContainedAt`, and the `BunHostError` those two root-bound factories throw; `layerHttpClient`, the network slot with redirects stopped; re-exports `AtomicFileSystem`, `BunChildProcessSpawner`, and `BunFileSystem` |
| `BunFileSystem` | `@smthrs/platform-node`'s atomic `FileSystem`, plus `layerWith` for a host whose helper lives elsewhere                                                                                                                                                                                 |

Three variants change one slot each. `BunHost.layerAt(root)` binds version
control to one absolute repository root instead of the process working
directory. `BunHost.layerContained(options)` prepares and records a supervisor
before each target starts, then keeps its cleanup deadline after target exit.
The private host connection also initiates group cleanup on host loss;
unverified cleanup retains its `ProcessLedger` record for restart
reconciliation. `BunHost.layerContainedAt` combines both variants. On POSIX,
handle `pid` names the supervisor while status describes the target; use
`handle.kill` to stop it. See the [containment guide](./docs/guides/contain-child-processes.md)
for detached commands, escaped sessions, and unsupported-platform limits.

Two properties are worth knowing before you compose the five slots by hand. The
filesystem slot carries `@smthrs/platform-node`'s `AtomicFileSystem`, so under
`@smthrs/kernel`'s guard an authorized path operation runs against file
descriptors and refuses to follow a link: a symlink swapped in after
authorization cannot redirect the write. And the HTTP slot is Effect's
shared egress client without automatic redirects, so a
`302` comes back to you as a `302` and the second origin is never contacted.

## Runtimes

Bun >=1.4.0 and Node.js >=26.4.0. The raw bundle's child-process spawner is
Effect's Node spawner re-exported. Contained POSIX bundles use the prepared
native adapter from `@smthrs/platform-node/ProcessReaper`. The bundle falls back to the
`@effect/platform-node` adapters off Bun and so resolves `node:` built-ins,
which is what stops it bundling for a browser. A page composes
`@smthrs/platform-browser` instead.

The host exports `implementationIds` for its five raw bundle service slots;
contained factories replace the process runner. Its rooted
factories reject invalid roots before constructing a layer, using the host's
own error with code `invalid_repository_root`.

BunHost includes BunCrypto in every bundle, so ArtifactStore.put composes
with BunHost alone. Crypto remains separate from the five capability slots.
BunHost also re-exports ProcessReaper and HostLiveness from platform-node.
