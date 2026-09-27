---
title: "The descriptor-relative filesystem"
description: "Why AtomicFileSystem runs every filesystem operation through the smithers-jj-export helper, what confinement that buys, which operations it covers, and what it costs per call."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-node/docs/concepts/descriptor-relative-filesystem.md"
---

`AtomicFileSystem` is `NodeHost`'s filesystem slot, and it is not Effect's
`NodeFileSystem`. It exists to close one race.

## The race it closes

A capability check names a path. A path-based operation resolves that path
again when it runs. Between the two, anything with write access to the
workspace can replace a component of the path with a symlink, and the operation
that was authorized for one file performs on another.

POSIX has the answer: open a directory, keep the descriptor, and perform the
final syscall relative to it (`openat(2)`, `renameat(2)`, and the `dir_fd`
family). A descriptor names an inode, not a name, so a swap after the walk
cannot redirect anything.

Node's JavaScript filesystem API exposes none of that, and no root-handle
equivalent. So `AtomicFileSystem` delegates each operation to the native
`smithers-jj-export` helper, which does have it. For ordinary operations and batches, the helper walks
from the filesystem root to the canonical workspace root using descriptor-relative
`O_NOFOLLOW | O_DIRECTORY` opens for every component. It verifies the opened
root's device/inode against the identity captured when the kernel layer was
composed, then performs the operation relative to a pinned parent descriptor.
An ancestor symlink swap or replacement of the root by another directory fails
ordinary operations with `PermissionDenied` before any content is read or changed.

## What the helper refuses

The confinement rules are strict, and two of them surprise people:

- **A regular file with more than one hard link cannot be opened.** A hard link
  is not a symlink, so `O_NOFOLLOW` cannot confine it: the same inode is
  reachable from outside the workspace under another name. Refusing the open is
  the only confinement available.
- **A symlink is never traversed, opened, renamed, or removed.** Directory
  listing is the single exception. It names a symlink entry and never descends
  through it, because listing resolves nothing and refusing would buy no
  confinement.

Two more rules follow from requiring the kind on the descriptor rather than on
a name:

- **Only regular files carry content.** A FIFO, a socket, a device, or a
  directory is refused for every read and write, because the kind is checked on
  the already-open descriptor and cannot be swapped afterwards.
- **Every open is non-blocking.** A named pipe planted at a path cannot park
  the adapter inside `open()` until some other process opens the other end. A
  write-only open of a reader-less pipe returns a typed failure instead. Node's
  own filesystem waits there indefinitely, which is the one place this adapter
  is deliberately stricter than the implementation it mirrors.

The workspace root itself is addressable like any other directory: `exists`,
`stat`, `readDirectory`, `realPath`, `glob`, and a recursive `makeDirectory`
all answer for it. Removing it, renaming it or onto it, reading it as a file,
writing over it, and a non-recursive `makeDirectory` on it stay refused.

## Which operations it covers

Thirteen operations can be expressed as one descriptor-relative request, and
those are the ones the adapter implements:

```text
readFile  readFileString  writeFile  writeFileString  exists  stat
readLink  realPath  makeDirectory  readDirectory  remove  rename  glob
```

Everything else on Effect's `FileSystem` surface returns a live handle or a
stream that Node cannot open relative to a pinned descriptor: `open`, `stream`,
`sink`, `watch`, `copy`, `copyFile`, `link`, `symlink`, `access`, `chmod`,
`chown`, `truncate`, `utimes`, and the `makeTemp*` family. Under the kernel
decorator each of those fails closed with a typed `PermissionDenied` rather
than silently reverting to a path-based call. A program that needs them reaches
for the raw `NodeHost.NodeFileSystem` outside the capability boundary.

Wrapping that raw layer directly also fails closed, because it carries no
atomic extension for the kernel to call.

## How the helper is started

The helper is `smithers-jj-export --atomic-fs`, a Rust binary shipped with the
package. Three properties of how it is started are load-bearing:

- **Absolute path, never a `PATH` lookup.** A binary planted in the working
  directory or on an injected `PATH` would run inside the process that holds
  the pinned root descriptor.
- **Outside the workspace.** The resolved executable must be an executable
  regular file outside the confined root. A packaged helper is copied out of
  the workspace before any flow runs.
- **Inert process.** It starts with an empty environment and the filesystem
  root as its working directory.

Both directions of the protocol are length-framed and bounded, so neither a
large file nor a malfunctioning helper can make the host allocate without
limit. See
[Configure the filesystem helper](/guides/configure-the-filesystem-helper/)
for the ceilings and how to change them.

## What it costs

An ordinary operation starts one helper. The guarded filesystem also
offers `FileSystem.batch(fs)` from `@smthrs/kernel/FileSystem`: one helper
serves up to 128 read requests against the same root descriptor. Requests may
stat, list directories, expand host globs, or collect SHA-256 digests, optionally
with file bytes. The helper exits after that request. There is no persistent
process.

- Prefer one recursive `readDirectory` (one helper for the whole tree) to a read
  per entry.
- Use bounded batches for a wide fan-out. Without a ceiling, an
  `Effect.forEach(files, read, { concurrency: "unbounded" })` over fifty paths
  would start fifty helpers at once, which is why the adapter carries a
  process ceiling at all.

Each batch member keeps its own canonical resource and grant check. Denied
members never enter the helper. Results retain their request index and sort by
normalized path using JavaScript's UTF-16 order, including Unicode names and
duplicate requests. Directory and glob results also sort deterministically.

The guard captures the root's device/inode at composition. The helper walks to
that root without following any component symlink and verifies its identity
before and after measurement. Root loss is a boundary failure, not a collection
of absent files. Digest reads compare descriptor metadata before and after the
read, then compare the pathname against that descriptor. Directory walks check
their opened directories for observed mutations. These checks detect changes
during a measurement; they do not freeze a workspace or claim a simultaneous
snapshot of unrelated paths.

A workspace symlink is allowed when composed, but the kernel rechecks its
logical path before and after grants. Retargeting it refuses the batch even
while the old canonical root remains available to the helper.

An entry absent before measurement reports `NotFound`. An entry or ancestor
that disappears after measurement begins reports `Busy`, so an interrupted
read cannot become evidence that the file was initially absent.

The digest is SHA-256 of the original bytes. No JSON, encoding, or pathname is
added to its input. Boundary tree and read-set identities remain the engine's
existing canonical constructions.

`AtomicFileSystem.helperSpawns()` exposes a process-local count for diagnostics.
Elapsed timings from `scripts/observation-bench.ts` are local measurements and
do not establish a production speed claim.

## Errors

Errno is normalized to the same reasons `@effect/platform-node` reports, so a
caller reads the same typed reason it would get from the native filesystem,
with one addition: a helper failure that carries no errno at all stays
`PermissionDenied`, so the boundary fails closed.

Writes follow Effect's `OpenFlag` contract exactly (`r`, `r+`, `w`, `wx`, `w+`,
`wx+`, `a`, `ax`, `a+`, `ax+`), and the test suite checks each flag against the
native Node filesystem. Truncation runs on the opened descriptor rather than
through `O_TRUNC`, so a hard link is refused before the file is modified.

`remove(path, { recursive: true })` walks iteratively with an explicit
descriptor stack, bounded at 512 levels deep and 100000 entries visited. One
directory's names are read before any of its entries is unlinked, because
unlinking from a directory while iterating it is undefined. Progress is partial
on refusal: entries already unlinked stay unlinked. `force: true` succeeds for
a path whose ancestors do not exist, exactly as `fs.rm` does.
