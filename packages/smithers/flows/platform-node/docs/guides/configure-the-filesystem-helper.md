---
title: "Configure the filesystem helper"
description: "Point AtomicFileSystem at a smithers-jj-export helper and set the byte ceilings, process ceiling, and timeout that bound what one filesystem call may cost."
---

Use this when the host keeps the `smithers-jj-export` helper somewhere the
adapter does not look, or when the default ceilings do not fit the workload.
`AtomicFileSystem.layerWith` takes all of it in one options object.

```ts
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"

const filesystem = AtomicFileSystem.layerWith({
  executable: "/opt/smithers/bin/smithers-jj-export",
  concurrency: 4,
  timeoutMs: 60_000,
  limits: { content: 4 * 1024 * 1024 }
})
```

`layerWith` returns a `Layer<FileSystem.FileSystem>` with no requirements, the
same shape as `AtomicFileSystem.layer`. Substitute it wherever the bundle would
have used the default.

## Choose the helper

The adapter runs `smithers-jj-export --atomic-fs` and uses the first of:

1. `executable` from `layerWith`.
2. `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY`.
3. The package's `bin/<platform>-<arch>/smithers-jj-export`.
4. In a source checkout, `target/release/smithers-jj-export`, then
   `target/debug/smithers-jj-export`.
5. `/usr/local/bin/smithers-jj-export`.

Build it in a source checkout:

```sh
cargo build --locked --release -p smithers-ffi --bin smithers-jj-export
```

Or name an installed helper:

```sh
export SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=/opt/smithers/bin/smithers-jj-export
```

A configured path must be absolute. The adapter never searches `PATH` or the
working directory.

The executable is re-validated on every request, as an absolute, executable
regular file outside the confined workspace. The file a path names can be
replaced while a host runs, so a check made only at construction would describe
a file that is no longer there. A host with no helper builds cleanly and then
fails every guarded filesystem call with `PermissionDenied`.

The packaged helper and the source-checkout builds (steps 3 and 4) are copied
to a private `0700` directory when the first layer in the process is built,
before any flow runs. Later layer builds copy nothing, because a flow of an
earlier run may already have written those paths. Requests execute that copy,
so a flow that rewrites one of those files later changes nothing that runs. A
default helper not present at that first build is refused with
`PermissionDenied` when its path, or the file the path links to, lies inside the
confined workspace: its bytes, or the choice of binary, could only have come
from a flow.

## Set the byte ceilings

`limits` accepts a partial `Limits`; the fields you omit keep their defaults.

| Field        | Default | What it bounds                                                                           |
| ------------ | ------- | ---------------------------------------------------------------------------------------- |
| `content`    | 16 MiB  | the bytes one `readFile` or `writeFile` may carry                                        |
| `request`    | 24 MiB  | the framed request, refused before a helper is even started                              |
| `response`   | 24 MiB  | the framed response, which is what a directory listing is charged against as it is built |
| `stderr`     | 64 KiB  | the diagnostic text retained from a failing helper                                       |
| `batchEntry` | 24 MiB  | one batch member's encoded result envelope, in UTF-8 JSON bytes                          |
| `batchSize`  | 128     | the number of operations in one batch; inclusive, maximum 128                            |

`request` and `response` are larger than `content` because base64 expands
16 MiB to 22369624 bytes, which has to fit.

A binary `writeFile` over the `content` ceiling never reaches the helper.
The kernel checks the advertised limit before encoding anything and fails
with a typed `BadArgument`; the helper's own ceiling is the backstop.

`request` and `response` count UTF-8 JSON payload bytes; each frame also has a
separately bounded header. A batch shares those same ceilings. `content`
continues to apply separately to every file, including digest-only reads, so
hashing in the helper does not bypass the existing read quota. `batchEntry`
includes the member's success or failure envelope. If even a failure cannot fit,
the whole call refuses. Aggregate response exhaustion likewise refuses the
call instead of returning an incomplete result list.

Every one of these is a contract rather than a tuning knob: without them a
large file, a large directory tree, or a malfunctioning helper makes the host
allocate until it dies. Raising one raises what a single call can cost the
host.

Lowering `response` has one consequence worth knowing. It bounds the rejection
envelope too, so a ceiling small enough to cut one off degrades that
operation's typed reason to the fail-closed one, and you lose the specific
errno.

## Set the process and time ceilings

The two ceilings that decide whether the host survives a wide fan-out are not
byte ceilings.

| Field         | Default                     | What it bounds                                  |
| ------------- | --------------------------- | ----------------------------------------------- |
| `concurrency` | `os.availableParallelism()` | how many helpers may run at once                |
| `timeoutMs`   | 300000                      | how long one helper may run before it is killed |

Each ordinary call or bounded batch starts one helper. Without a process ceiling,
an `Effect.forEach(files, read, { concurrency: "unbounded" })` over fifty paths
would start fifty helpers at once. The same permit covers request JSON
serialization and framing, so queued calls retain their input rather than an
additional encoded request buffer. Invalid settings and batch counts are
rejected before admission; serialized request sizes are checked after admission
and before starting the helper.

`timeoutMs` is a backstop, not a latency budget. A read at the content ceiling
over a slow disk has to fit under it, so five minutes is generous; what it
bounds is a helper that will never answer at all. A helper that passes the
deadline is killed and the operation fails closed.

## Ceilings are read once

Every field except `executable` is read once, when the layer value is
constructed. `Options` is a plain object the caller still holds, and a byte
ceiling that changes under a running host is not a ceiling.

The reading happens outside the layer body, so two compositions of the same
layer value enforce the same ceilings and share one process semaphore. Building
the layer twice does not double the concurrency budget.

## Check the defaults from code

The defaults are exported, so a program that reports its own configuration does
not have to restate them:

```ts
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"

AtomicFileSystem.defaultExecutable // "/usr/local/bin/smithers-jj-export"
AtomicFileSystem.defaultLimits // { content, request, response, stderr, batchSize, batchEntry }
AtomicFileSystem.defaultConcurrency // os.availableParallelism()
AtomicFileSystem.defaultTimeoutMs // 300000
```
