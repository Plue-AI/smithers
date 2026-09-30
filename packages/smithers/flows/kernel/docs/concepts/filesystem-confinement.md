---
title: "Filesystem confinement"
description: "Why authorizing a pathname is not enough: canonical resources, the re-resolution after a suspended grant, descriptor identity, and the two host extensions that make confinement enforceable."
sidebar:
  order: 3
---

Guarding a filesystem is harder than guarding a process, because a path is not
a thing. It is a name that something else can rebind between the moment you
authorize it and the moment the host acts on it. The naive decorator, check
the pathname and then hand the same pathname to the host, is vulnerable to a
symlink swap: authorize `/workspace/notes.txt`, and by the time the host
resolves it the name points at `/etc/shadow`.

Everything in this page exists to close that window.

## The capability resource is canonical, not literal

`FileSystem.canonicalResource(fileSystem, path, workspaceRoot, value)` is what
turns a caller's string into the resource a capability names. It resolves the
path through every existing ancestor, so an existing symlink cannot turn an
inside-workspace grant into outside authority. Then it maps a canonical path
that lands inside the workspace back to the stable logical workspace root, so
capability resources stay readable and stable even when the root itself is a
symlink. A relative path is resolved against the workspace root first.

Every host, including a descriptor-relative executor, resolves existing
components to their on-disk spelling before and after a grant decision.
On a case-insensitive volume, `.ENV` therefore names `.env` for permission
checks, and `REPORTDIR/new.txt` names `ReportDir/new.txt` when `ReportDir`
already exists. Missing components retain their requested spelling. A
path-based host must implement `realPath` with canonical on-disk spelling. The
capability matcher remains case-sensitive so distinct files on case-sensitive
volumes keep distinct permissions.

Native guarded operations on outside-pointing symlinks fail with
`PermissionDenied`, including `readLink`, `stat`, `exists`, and `remove`.
Authorization for a descriptor-relative executor never resolves a pathname on
the host. This matters on Windows, where `realpath` opens its argument through
links: one call on a link to `\\.\pipe\name` or `\\host\share` connects to
that pipe or share. Instead the executor answers one `resolve` request from the
pinned root. It walks without following any link, junction, or mount point,
and answers the on-disk spelling of existing components, or the first link on
the way with its text. Link text is resolved lexically and asked again, so a
component swapped for a link between two checks is seen as that link. A
reparse point the executor cannot translate, such as a volume mount point, is
refused without being traversed.

Each guarded operation asks the executor to resolve its path before and after
the grant decision, and then runs the operation itself. A guarded batch asks
once for all of its members before the grants, once after them, and then runs
the batch.

Capability resources are native paths, and patterns match them as text. On
Windows, write filesystem patterns with the native separator, such as
`fs:read:C:\work\**`. The pattern `fs:read:C:\work/**` selects nothing.

Resolution also applies one always-on refusal: a regular file with more than
one link fails with `"hard-linked files cannot be confined to the workspace"`.
A hard link is a second name for the same inode with no ancestry to check, so
there is no canonical answer to give.

## The path is resolved twice

A grant decision can suspend. An attended request waits for a person; a
journal-backed store waits for a write. What was authorized is the resource
the path named at check time, so the path must still name it when the decision
comes back.

The guard therefore resolves the resource, checks the capability, and resolves
it **again**. If the second answer differs, the operation fails with
`"path no longer names the resource that was authorized"`. A symlink or rename
swapped in during the wait is refused, never followed.

## An open handle is bound to an inode

Rechecking a pathname is not enough once a file is open. The pathname could be
re-authorized while the descriptor you hold names something else: after a
rename that descriptor can address an inode outside the workspace even though
the replacement path is still allowed.

So an open handle binds authorization to the descriptor's `device:inode`
identity, captured at open time, and every guarded handle operation
(`read`, `write`, `stat`, `truncate`, `sync`, and the `*All` and `*Alloc`
forms) rechecks that identity as well as the capability. A mismatch fails with
`"descriptor no longer names the resource at its authorized path"`.

Open flags decide which capabilities the open itself requires. A read-only
flag needs `fs:read`, a write flag needs `fs:write`, and a read-write flag
needs both.

A host that reports no inode identity is an isolated volume. Its attestation,
not inode evidence, is the boundary, so there is nothing to verify and the
recheck passes.

## Two ways a host earns the filesystem

The kernel refuses to delegate a checked pathname to a path-based host. A
platform adapter has to provide one of two extensions, and a host that
provides neither fails **every** relevant path, directory, stream, glob, and
handle operation closed with
`"host does not provide descriptor-relative, no-follow filesystem isolation"`.

**`withAtomicFileSystem(fileSystem, atomic)`** attaches a descriptor-relative,
no-follow executor. Operations are expressed as an `AtomicRequest` and run
relative to a pinned root handle, so there is no pathname for anything to
rebind between the check and the act. This is what a native host uses;
[`@smthrs/platform-node`](/api/platform-node) attaches it.

**`withIsolatedFileSystem(fileSystem)`** attests that the whole volume is
already confined by an enforceable boundary, which is true of an in-memory
browser volume or a test double that cannot address the host filesystem at
all. Path delegation is safe there because there is no host filesystem to
reach.

Both decorate the supplied service object in place and return that same
identity, so a host attaches exactly once at its boundary and keeps no
undecorated alias.

`withIsolatedFileSystem` **throws** on a filesystem that already carries a
descriptor-relative executor. The executor is the stronger guarantee, and
replacing it with a path-delegating attestation would route `access`, `copy`,
`chmod`, `link`, `symlink`, `open`, `watch`, `sink`, `stream`, and every
`makeTemp*` call back through pathnames after the capability check: the exact
window the extension closes. The refusal is a throw at composition time, so a
host cannot be assembled that way. Layering over an executor a caller has read
and delegates to is still allowed, because that replacement is the caller's
own decision.

## Engine machinery uses a confined view

The engine's own copy-back writes files a body produced; asking a grant store
for them would make the engine ask permission for its own bookkeeping. It still
must not follow a symlink a concurrent process swapped into the workspace.
`confined(fileSystem, root)` gives it the same descriptor-relative requests the
guarded layer sends, pinned to `root`, with no grant check. A path-based host
gets no such view: `confined` refuses it rather than fall back to a
check-then-write that a swap could beat.

## Temporary directories are outside the workspace

`makeTempDirectory`, `makeTempDirectoryScoped`, `makeTempFile`, and
`makeTempFileScoped` name no directory of their own. An implicit one is
authorized as `fs:write` on
`path.resolve(workspace.root, "..", FileSystem.systemTemporaryDirectoryName)`,
where the sentinel is the literal string `"<system-temp>"`.

The sentinel is outside the workspace root by construction and is never
confusable with a real path, so granting an ordinary workspace write does not
grant system temporary-directory access. A host missing the required extension
reports the refusal against the logical input `../<system-temp>`.

## Mutable inputs are snapshotted

An options record a caller still holds is a second way to change an operation
after it was authorized. The guarded filesystem snapshots option records,
nested arrays, and maps before any permission suspension, freezing what it
copies, so the operation executed after a grant arrives is the operation that
was approved. An options object carrying a getter rather than plain data
fails with `"filesystem options must contain only data properties"`, because a
getter is not something a snapshot can capture.

## Related

- [Adapt a new host platform](../guides/adapt-a-new-host-platform.md):
  attaching an extension and proving it with the contract suite.
- [How a grant decision is made](./grant-decisions.md): what happens between
  the two resolutions.
