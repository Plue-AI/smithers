---
title: "Run jj in a browser tab"
description: "Compose BrowserJj over a synchronous filesystem and the flows_jj wasm module, keep the mount durable, and know the seven places the WebAssembly backend answers differently from the jj command line."
sidebar:
  order: 5
---

A tab cannot spawn the `jj` binary. It can run jj-lib itself: the library is
compiled to `wasm32-wasip1` and shipped in this package as
`wasm/flows_jj.wasm`, and `BrowserJj` runs it over the WASI preview 1 shim this
package also ships, on whatever synchronous filesystem the page mounts. Eight
of the nine contract operations work there, with real change ids and a real
operation log. `revert` has no operation in the compiled ABI and
reports `not_installed`.

Snapshot captures the current change without describing or closing it and
returns `{ commitId, changeId, operationId }`. `opRestore(operationId)` restores
the repository view and working-copy files, preserves current remote and Git
state, and refuses changes to other workspaces since the captured operation.

## Compose the layer

```ts
import { Jj } from "@smthrs/jj"
import * as BrowserJj from "@smthrs/jj/browser/BrowserJj"
import { configureSingle, fs } from "@zenfs/core"
import { IndexedDB } from "@zenfs/dom"
import * as Effect from "effect/Effect"

await configureSingle({ backend: IndexedDB })

// wasmUrl: however your bundler serves this package's wasm/flows_jj.wasm.
const wasm = await WebAssembly.compileStreaming(fetch(wasmUrl))

const program = Effect.gen(function*() {
  const jj = yield* Jj
  return yield* jj.snapshot("before the step")
}).pipe(Effect.provide(BrowserJj.layer({ fs, wasm, root: "/repo" })))
```

Like the filesystem, the layer is a **function**: the page owns the mount and
the wasm bytes, so both arrive as arguments. The library never fetches, and it
never picks a storage backend for its host.

`BrowserJjOptions` takes five fields:

| Field      | Meaning                                                             |
| ---------- | ------------------------------------------------------------------- |
| `wasm`     | The reactor, precompiled or as raw bytes. Required.                 |
| `fs`       | The synchronous filesystem the repository lives on. Required.       |
| `root`     | The workspace root inside that namespace. Defaults to `"/"`.        |
| `onStdout` | Receives anything jj-lib writes to stdout. Unset drops it.          |
| `onStderr` | Receives anything jj-lib writes to stderr. Rust panics arrive here. |

Prefer a dedicated `root` such as `"/repo"` that already exists, so the
repository's `.jj` does not share the mount root with unrelated state.

### The options object is read once

`root`, `fs`, `onStdout`, and `onStderr` are read when `make` is called.
`wasm` is read later, at the first operation, which is what lets a page hand
over bytes it is still loading. Replacing a field on the options object
afterwards changes nothing, and raw bytes are copied at the read, so the
executable authority cannot be swapped between a failed operation and a retry.

`fs` itself stays a live service the page continues to own.

### Traps discard the reactor

A guest that panics or calls `proc_exit` never runs its own cleanup, so the
host does it: the operation fails with `unknown`, the shim closes every host
descriptor the guest still held, and the next operation instantiates a fresh
reactor from the bytes captured at the first read. A host-side refusal before
the reactor is entered, such as the symlink scan, keeps the live reactor.

### Scoped disposal

`layer` and `make` never dispose a reactor that did not trap; its descriptors
last as long as the page. When the service has a shorter life than the page,
use `layerScoped` or `makeScoped`. Both close the live reactor's descriptors
when the scope closes, and every operation on the service after that fails
with `unknown`.

```ts
const program = Effect.gen(function*() {
  const jj = yield* Jj
  return yield* jj.status()
}).pipe(Effect.provide(BrowserJj.layerScoped({ fs, wasm, root: "/repo" })))
```

## Durability is the mount's job

ZenFS fronts OPFS or IndexedDB with a synchronous mirror and writes back
asynchronously. That mirror is precisely what lets jj-lib run without threads,
and it means an operation returning does not mean bytes reached storage. Call
your mount's `sync` after operations that must survive a reload. This layer
does not own the mount and never syncs for you.

## Hosts with no wasm module

```ts
import * as BrowserJj from "@smthrs/jj/browser/BrowserJj"

const layer = BrowserJj.layerUnsupported
```

Every operation reports `not_installed`, naming the jj command the CLI adapter
would have run. That is the same code the Node adapter reports for a missing
binary, so a caller needs no browser-specific branch. The service stays present:
an absent capability is a capability with an answer, never a missing tag.

## Where the wasm backend answers differently

These divergences are real, deliberate, and pinned by tests. Read them before
you assume parity with the CLI.

### `revert` is not available

The compiled ABI has no revert operation, so `BrowserJj.layer` defines `revert`
and fails it with `not_installed` and the message "jj is not available in the
browser". For advance capability checks, use host configuration or non-mutating
capability metadata maintained by the host. Property presence does not establish
support, and a revert probe mutates repositories on Node and Bun. Handle
`not_installed` only when executing a user-requested undo, as shown in
[Handle a requested revert](./testing.md#handle-a-requested-revert).

`restore` is unaffected, so rewinding a run to a recorded change id works here
exactly as it does on the CLI.

### Repository initialization is explicit in the wasm ABI

Only the `init` ABI operation creates a repository. `status`, `diff`, and
`restore` on an uninitialized or missing root fail with `JjError.code: "unknown"`
and leave the filesystem unchanged, like NodeJj. BrowserJj checks for the
repository before calling those operations, including with older wasm bytes.
`BrowserJj.snapshot` explicitly calls `init` before its first snapshot when the
repository is absent; snapshot is a compensable write capability.

### Simple backend, no git

Repositories are created with jj's Simple backend, not the git backend, because
the git implementation is compiled out. There is no fetch, push, or clone, and
no colocated `.git`. Native jj can open these repositories. Upstream calls the
Simple backend a testing backend and does not promise on-disk format stability;
the pinned fork revision is what freezes the format for this package.

### A pinned lane is two calls

The frozen ABI has no revision field on `workspaceAdd`, so a pinned add is the
add followed by a restore rooted at the new lane. The whole sequence runs
uninterruptibly, because a cancel delivered between the two would strand a
registered lane.

If the pin fails, the adapter forgets the lane and reports the pin failure
against `workspaceAdd`, so the lane name is free again. As with any forget, the
lane directory stays on disk. If the **rollback itself** fails, the lane can
stay registered: the caller is told about the pin failure, which is the one it
can act on, and turning one error into two would hide it. Only a single ABI
operation can close that gap.

### Lane names and paths are checked

The reactor refuses a `workspaceAdd` or `workspaceForget` name outside
`[A-Za-z0-9._-]`, an empty name, and one that starts with `.`. It refuses a
`workspaceAdd` path that is relative or has a `.`, `..`, or `.jj` component.
Each refusal fails `unknown` before any directory or repository state is
written. The CLI layers pass names and paths to jj unchanged.

### `root(from)` answers for its own slice

The layer owns one workspace, so it answers the configured root for any path
inside it and fails for a path that is not. Answering for an unrelated tree
would be a wrong answer rather than a missing one. Containment is computed in
namespace coordinates, so `/repo/../outside` is correctly outside `/repo`.

### Real symlinks are rejected

The shipped `wasm32-wasip1` reactor cannot safely snapshot real symlinks: its
fallback reads target bytes instead of link text. `BrowserJj` rejects real
symlinks with a `JjError` (`code: "unknown"`) before `snapshot`, `status`,
`diff`, `restore`, or `workspaceAdd` enters the reactor. All five operations
can snapshot the working copy, including reads of existing revisions.

The check walks the workspace using link metadata without opening targets.
It includes ignored directories and dangling links, skips `.jj` and `.git`
contents, and rejects links at those metadata names. A rejected operation
writes no repository state, including on the first snapshot. Remove real
symlinks before retrying. The scan and reactor call run synchronously under
the layer's operation permit; the host must prevent concurrent filesystem
mutation by other workers during an operation.

Checking out an existing tree symlink still materializes a regular file
containing link text. Native symlink snapshots require a future reactor fix.
Direct consumers of the WASM ABI do not receive the `BrowserJj` guard.

### Synchronous, single threaded, and our own output text

Each operation runs the wasm module to completion on the calling thread. There
is no incremental progress, and an interruption waits for the operation to
finish. A host that cares should put the Smithers runtime in a worker; this
layer does not do it for you. jj's parallel working-copy paths degrade to
serial execution, which is correct but not parallel.

`status` and `diff` are rendered by the WebAssembly module this package ships
rather than by jj's command-line interface. `diff` is git-format unified diff and `status` is a
concise change-id listing with A, M, and D markers. Both are stable and tested,
and neither is byte identical to what the CLI prints. A path that holds a
control character, `"`, or `\` is C-quoted in both, the way git quotes it, so
a newline or escape byte in a file name cannot forge a header or status line.
File contents in hunks are printed as is. A `diff` whose text passes 64 MiB
fails `unknown`, the same ceiling the CLI layers put on jj's output.

Finally, `not_installed` here means "this host cannot do that", never "jj is
missing from your `PATH`". The wasm module itself produces only `conflict`,
`invalid_ref`, and `unknown`; every `not_installed` comes from the TypeScript
side, either from `revert` or from `layerUnsupported`.

## The WASI shim is public too

`@smthrs/jj/browser/WasiPreview1` is exported, because it is testable without
any wasm module: `make` returns plain functions over memory, a filesystem, and
a file-descriptor table, so a test constructs a `WebAssembly.Memory`, calls the
syscalls directly, and asserts errno values.

`path_open` applies `O_TRUNC` even with `APPEND`, then appends subsequent
writes to the current end of file. It validates the four-byte result region
before allocating a descriptor. If post-open truncation fails, it attempts to
close the host descriptor and returns the original truncation error, even if
closing also fails.

### Namespace ownership is required

`root` is not a security sandbox for `node:fs` under concurrent mutation.
The shim checks paths with `lstatSync` and later opens or mutates them by string
path. The slice provides no retained directory handles, atomic confined path
resolution, or no-follow open flags. A native writer can replace a checked file
or ancestor with a host-absolute symlink between those calls, causing a read or
write outside `root`, even when the guest requested no-follow. Rechecking paths
or adding a final-component no-follow flag cannot secure ancestor resolution.

The host must prevent concurrent namespace mutation during each WASI syscall,
including replacement of `root` or its host ancestors. This includes native
processes, other workers, and reentrant backend callbacks. Synchronous guest
execution alone does not enforce that requirement. If writers cannot be
excluded, use a backend that independently confines **every** read and mutation
to the allowed storage. This requirement applies to all path operations,
including rename, unlink, timestamp changes, and operations through directory
fds. The shim does not detect or reject concurrent writers.

With that requirement satisfied, `root` maps the guest namespace to one slice.
`..` of the namespace root is the root. Symlink expansion uses namespace
coordinates: absolute targets are re-rooted at the preopen, and relative
targets resolve against the link's directory. Traversed ancestors must exist
and be directories after expansion, including components consumed by `..`.
`/file/../victim` returns `ENOTDIR` when `file` is a regular file;
`/missing/../victim` returns `ENOENT`. A chain that exceeds the hop budget
returns `ELOOP`. No-follow rejects stable final symlinks with `ELOOP`.

The filesystem it runs over is described structurally by
`@smthrs/jj/browser/WasiFs`, and the shape has two deliberate consequences:
`openSync` takes Node string flags (`"r"`, `"w"`, `"wx"`) rather than numeric
`O_*` constants, which are platform specific, and errors must be thrown with a
Node-style string `code` property so the shim can map them onto WASI errno
values. Both ZenFS and `node:fs` satisfy it already.

The shim's honest divergences from a kernel WASI host are listed in the
[API reference](../api.md).
