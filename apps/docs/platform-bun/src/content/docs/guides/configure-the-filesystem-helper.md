---
title: "Configure the filesystem helper"
description: "Point the filesystem slot at a smithers-jj-export helper with BunFileSystem.layerWith, and tune the helper's concurrency, timeout, and byte limits."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-bun/docs/guides/configure-the-filesystem-helper.md"
---

The filesystem slot carries the kernel's atomic host extension, and that
extension does not run in-process. Each guarded path operation is executed by
the `smithers-jj-export` helper the adapter spawns, which is what makes the
operation descriptor-relative and no-follow: a symlink swapped in after
authorization cannot redirect it somewhere else.

The adapter uses the first of `executable`, `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY`,
the package's `bin/<platform>-<arch>/smithers-jj-export`, a source checkout's
`target/release` or `target/debug` build, and
`/usr/local/bin/smithers-jj-export`. It never searches `PATH`.

## Build or name the helper

In a source checkout:

```bash
cargo +1.98.0 build --locked --release -p smithers-ffi --bin smithers-jj-export
```

Anywhere else, set the absolute path:

```bash
export SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=/opt/smithers/bin/smithers-jj-export
```

Or pass it to the layer:

```ts
import { BunFileSystem } from "@smthrs/platform-bun"

const fileSystem = BunFileSystem.layerWith({ executable: "/opt/smithers/bin/smithers-jj-export" })
```

The executable is re-validated on every request rather than read once when the
layer is built, because the file a path names can be replaced while the host
runs.

## Use it as the whole host's filesystem slot

`BunHost.layer` builds its filesystem slot from `BunFileSystem.layer`, which
uses the default search. Merge your configured layer over the bundle so it
shadows that slot, and put it last: for a duplicate tag, the later layer in a
merge wins.

```ts
import { BunFileSystem, BunHost } from "@smthrs/platform-bun"
import * as Layer from "effect/Layer"

// The override comes second. Reversing the arguments silently keeps the
// default helper.
const host = Layer.merge(
  BunHost.layer,
  BunFileSystem.layerWith({ executable: "/opt/smithers/bin/smithers-jj-export" })
)
```

This replaces the `FileSystem` tag every consumer resolves, including the
kernel's guarded `FileSystem.layer`, which is where the helper actually runs.
The spawner inside the bundle keeps the default filesystem layer it was built
with for resolving executables and working directories; that path is unguarded
and does not use the helper.

Prefer this over hand-composing the five slots. Rebuilding them yourself means
rebuilding the `HttpClient` slot too, and its `redirect: "manual"` wiring is
internal, so a hand-composed bundle quietly gains redirect following.

`BunHost` also re-exports `AtomicFileSystem` itself, so you can reach the
implementation and its full option set without adding
[`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/) as a second dependency:

```ts
BunHost.AtomicFileSystem.layerWith({ executable, concurrency, timeoutMs })
```

## The other options

`BunFileSystem.Options` is `AtomicFileSystem.Options`:

| Field         | Meaning                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `executable`  | The absolute `smithers-jj-export` path. Default: the search above. Re-validated per request.              |
| `concurrency` | How many helper processes may run at once. A contract, not a tuning knob: every operation is one process. |
| `timeoutMs`   | How long one helper may run before it is killed and the operation fails closed.                           |
| `limits`      | The byte ceilings the helper enforces on the values it moves.                                             |

`concurrency` exists because an unbounded `Effect.forEach` over a directory
would start one helper per entry and pin every core. Raise it deliberately.

Everything except `executable` is snapshotted when the layer is built. The
options object stays yours, and a byte ceiling that changed under a running
host would not be a ceiling.

## Windows

The extension is unsupported on Windows. A guarded path operation there fails
closed.

## Related

- [The Host surface on Bun](/concepts/host-surface/): why the filesystem
  slot is the Node package's implementation, and what the extension buys under
  the kernel's guard.
- [`@smthrs/platform-node`](https://platform-node.smithers.sh/reference/api/): the `AtomicFileSystem` adapter
  itself, its full option set, and its refusal matrix.
