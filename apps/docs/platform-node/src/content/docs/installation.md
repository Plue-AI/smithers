---
title: "Installation"
description: "Install @smthrs/platform-node, the peers and host prerequisites it needs, its entry points, and the packages a real host composition adds."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-node/docs/installation.md"
---

## Get the package

`@smthrs/platform-node` is not on npm at 1.0.0-rc.0. It ships as a member of
the [smithers repository](https://github.com/smithersai/smithers) workspace, so
using it today means working from a checkout:

```bash
git clone https://github.com/smithersai/smithers.git
cd smithers
pnpm install
```

Code that consumes it lives in that workspace too, either an existing package
or one you add, and depends on it with a workspace specifier:

```json
{
  "dependencies": {
    "@smthrs/platform-node": "workspace:*"
  }
}
```

## Peers

`@effect/platform-node`, `@effect/platform-node-shared`, and `effect` are peer
dependencies, so your project pins their versions rather than inheriting a
second copy. `@smthrs/platform-node` declares `4.0.0-rc.115` for all three:

```bash
pnpm add @effect/platform-node@4.0.0-rc.115 @effect/platform-node-shared@4.0.0-rc.115 effect@4.0.0-rc.115
```

The shared adapter peer keeps the Node implementation on the same Effect
release candidate. The upstream Node adapter uses a caret for that dependency,
which otherwise permits a later shared adapter with an incompatible Effect peer.
Package managers that install peers automatically resolve the exact version
from this package's manifest.

Its own runtime dependencies, [`@smthrs/jj`](https://jj.smithers.sh/reference/api/) and
[`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/), resolve from the same workspace.

The package ships ESM, CommonJS, and TypeScript declarations.

## Host requirements

| Requirement                     | Why it is needed                                                      |
| ------------------------------- | --------------------------------------------------------------------- |
| Node.js 26.4.0 or later         | the minimum this package's `engines` field declares                   |
| a POSIX host                    | Windows has none of the primitives below and is unsupported           |
| the `smithers-jj-export` helper | `AtomicFileSystem` runs every guarded filesystem operation through it |
| `jj` 0.39.0 or newer on `PATH`  | required at construction by every complete `NodeHost` layer           |

### jj is checked at construction

Every complete host bundle, `NodeHost.layer`, `NodeHost.layerAt`,
`NodeHost.layerContained`, and `NodeHost.layerContainedAt`, builds a
version-checked `Jj` layer before providing its services. This requires jj
0.39.0 or newer even when the program requests only the filesystem or process
spawner. Check the installed version with `jj --version`.

If the executable is missing, bundle construction fails with a typed `JjError`
whose code is `not_installed`. An older version fails with
`unsupported_version`. The version probe runs outside the host process ledger;
repository commands use the selected process runner.

### The filesystem helper

From a source checkout, build it with:

```sh
cargo +1.98.0 build --locked --release -p smithers-ffi --bin smithers-jj-export
```

The host finds `target/release/smithers-jj-export` automatically. Elsewhere,
set `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` to its absolute path.

`NodeHost.layer` builds cleanly on a host with no helper. The executable is
re-validated on every request rather than once at construction, because the
file a path names can be replaced while a host runs, and a check that happened
only at boot would be a check about a file that is no longer there.

The consequence is that on `node:22-slim`, `node:22-alpine`, or a distroless
image the layer builds, the run starts, and the first guarded filesystem call
inside a flow body fails with `PermissionDenied`. For the search order and
`layerWith`, see
[Configure the filesystem helper](/guides/configure-the-filesystem-helper/).

## Individual services without jj

Applications that do not need `Jj` can provide individual service layers.
This composition supplies the bundle's filesystem, path, process spawner, and
HTTP client without constructing a `Jj` layer:

```ts
import { NodeHost } from "@smthrs/platform-node"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"

const platform = Layer.mergeAll(NodeHost.AtomicFileSystem.layer, Path.layer)
const spawner = NodeHost.NodeChildProcessSpawner.layer.pipe(Layer.provide(platform))
const hostWithoutJj = Layer.mergeAll(platform, spawner, NodeHost.NodeHttpClient.layerUndici)
```

`NodeHost.NodeHttpClient.layerUndici` is the plain Undici pool, which dials
every origin directly. A program that may run behind an egress proxy composes
`NodeHost.EgressHttpClient.layer(process.env)` instead: it routes through the
proxy `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` name, and is this same plain
pool when they name none. The complete bundles above already use it.

Provide `hostWithoutJj` to a program that needs these services, or provide only
the individual layer it needs. The spawner requires both filesystem and path
services, supplied by `platform` above. The filesystem still requires the
helper described above. This composition does not provide `Jj`
and cannot satisfy consumers that require the complete five-tag host.

## Import forms

The root entry point re-exports three modules as namespaces:

```ts
import { HostLiveness, NodeHost, ProcessReaper, ScopedProcess } from "@smthrs/platform-node"
```

Each module is also importable from its own subpath, which is the form the
[API reference](/reference/api/) uses:

```ts
import * as HostLiveness from "@smthrs/platform-node/HostLiveness"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import * as ProcessReaper from "@smthrs/platform-node/ProcessReaper"
```

`AtomicFileSystem` is deliberately not in the barrel. Reach it through its own
subpath, or as a re-export off `NodeHost`:

```ts
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
// or
import { NodeHost } from "@smthrs/platform-node"
const filesystem = NodeHost.AtomicFileSystem.layer
```

Two subpath shapes are blocked in the export map:
`@smthrs/platform-node/internal/*` and `@smthrs/platform-node/*/index`.
`@smthrs/platform-node/package.json` is exported.

## Entry points

| Import                                   | Source                                                                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `@smthrs/platform-node`                  | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/src/index.ts)                       |
| `@smthrs/platform-node/NodeHost`         | [src/NodeHost.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/src/NodeHost.ts)                 |
| `@smthrs/platform-node/AtomicFileSystem` | [src/AtomicFileSystem.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/src/AtomicFileSystem.ts) |
| `@smthrs/platform-node/HostLiveness`     | [src/HostLiveness.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/src/HostLiveness.ts)         |
| `@smthrs/platform-node/ProcessReaper`    | [src/ProcessReaper.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/src/ProcessReaper.ts)       |
| `@smthrs/platform-node/ScopedProcess`    | [src/ScopedProcess.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-node/src/ScopedProcess.ts)       |

Every entry point is Node-only by construction: the bundle resolves
`node:child_process` and its siblings, and a build check keeps it that way. For a
browser host, use [`@smthrs/platform-browser`](https://platform-browser.smithers.sh/reference/api/); for Bun,
[`@smthrs/platform-bun`](https://platform-bun.smithers.sh/reference/api/).

## What a real composition adds

This package provides raw host services. A composition that enforces
capabilities wraps them in [`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/)'s decorators, which
need a workspace root and a grant store. Add that package to your own
dependencies with the same workspace specifier, then compose:

```ts
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as HostServices from "@smthrs/kernel/HostServices"
import * as Workspace from "@smthrs/kernel/Workspace"
import { NodeHost } from "@smthrs/platform-node"
import * as Layer from "effect/Layer"

const guarded = HostServices.layer.pipe(
  Layer.provide(NodeHost.layer),
  Layer.provide(Workspace.layer("/absolute/workspace")),
  Layer.provide(GrantStore.layerNoop)
)
```

`GrantStore.layerNoop` allows every operation inside the workspace. It is a
seam for tests and boot paths, not a production policy. Replace it with a
rule-based store before running untrusted work; see
[Write a capability policy](https://kernel.smithers.sh/guides/write-a-capability-policy/).

Turning on process containment adds a `ProcessLedger`, which the journal backs.
See [Contain child processes](/guides/contain-child-processes/).

Most programs never compose this by hand. `@smthrs/flows`' `NodeRuntime` builds
the whole durable runtime, including `NodeHost.layerContainedAt` and
`HostLiveness.isAlive`, from one options object.
