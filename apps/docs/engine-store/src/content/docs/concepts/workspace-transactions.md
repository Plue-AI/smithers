---
title: "Workspace transactions"
description: "The two-phase workspace sandbox: a body runs against an isolated tree and returns its writes, and a separate copy-back checks preconditions and applies them to the host."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine-store/docs/concepts/workspace-transactions.md"
---

`WorkspaceSandbox` is a functional transaction over a filesystem. A sealed
action's body runs in an isolated workspace and returns its writes rather than
performing them. Applying those writes to the host is a separate call that
checks all preconditions before changing files and attempts in-process rollback
on failure. Filesystem copy-back is not crash-atomic.

```ts
interface Service {
  readonly execute: <Output, Error>(
    execution: Execution<Output, Error>
  ) => Effect<ExecutionResult<Output>, Error | WorkspaceError, Crypto>
  readonly materialize: <Output>(
    accepted: Accepted<Output>
  ) => Effect<void, MaterializationConflict | WorkspaceError, Crypto>
}
```

## execute never touches the host

The transaction is seeded with exactly the declared read set. An undeclared
file is simply not there, which is the strong enforcement tier: the body cannot
read what it did not declare because the bytes were never copied in. The
transaction is served through both the `Workspace` tag and a re-rooted Effect
`FileSystem`, so a body written against either surface is isolated.

At settlement the whole map is diffed. An execution whose observations
contradict its declaration comes back `Invalidated`, and that shape deliberately
carries provenance and violations only: there is no accessor for the candidate
output, the files, or the queued effects. An accepted execution comes back as
`Accepted`, carrying the `WorkflowResult`, the memo `CacheOutcome`, and, in
expected mode, the violations the declaration did not predict.

Seeding costs a copy of the declared reads. Re-rooting the body onto a bare
host tree instead would leave every undeclared file readable and reduce
enforcement to detection by diff after the fact, and the OS-level overlay that
would fix that is not reachable through Effect's `FileSystem` tag, so it could
not run in a browser. Bazel uses the same copy-in strategy for the same reason.

## materialize is the only host write

Copy-back is a compare-and-set on every `FileChange.beforeDigest`. If the base
moved, the whole bundle is refused with `MaterializationConflict` and nothing
lands. The engine answers that by retrying the attempt from a fresh base a bounded
number of times.

`beforeDigest` describes what is really on the host, not what was in the seed.
The `Host.baseline` seam is what supplies it, because "absent from the seed" is
emphatically not "absent from the host": a body writing a declared output it
never declared as a read is the ordinary case, and that file usually already
exists from a previous run. Treating the seed as the whole world made every such
copy-back a conflict the engine could only rebase into the same refusal.

Two more properties bind the write:

- Every copy-back host call (the lock, the preflight reads, each write,
  directory creation, and removal, and every rollback call) is one
  descriptor-relative request against the workspace root pinned when the
  commit starts. The host resolves each path component with `O_NOFOLLOW`
  from that root, so there is no gap between a check and a write for another
  process to swap a symlink into. A symlink anywhere on a change's path, a
  hard-linked file, or a root replaced mid-commit fails `materialize` with
  `path_escapes_workspace`. That includes a symlink that stays inside the
  root: the body writes the referent path itself.
- Digest checks and retained-byte resolution finish before any file change. The apply loop journals each target's pre-image before touching
  it, including the target of a write that fails partway through. An apply
  failure triggers an attempt to restore those files. Empty parent directories
  can remain after rollback.

The filesystem host serializes preflight, apply, and rollback with
other cooperating commits. A semaphore is shared by workspace root in the
process. A `.smithers-workspace-lock` lease file under the root coordinates
separate processes, including callers using symlink aliases of the same root.
This path is reserved: bundles cannot materialize it or its children. The `.flows` engine state directory is reserved the same way, so no
write set, `**` glob, or `expected` boundary mode lets a step body replace the
engine database, its `-wal` and `-shm` siblings, or artifact objects kept
there. Add other state paths under the root with the `reservedPaths` option.
A write or removal that targets a reserved path or lies beneath one fails
`materialize` with `host_unavailable` before any file changes; a symlink alias
of one is refused with `path_escapes_workspace` like any other symlink. Names
match after NFKC normalization and case folding, so a spelling a
case-insensitive volume equates with a reserved path, such as `.FLOWS`, is
refused on every volume. An NTFS 8.3 short-name shape, such as `FLOWS~1`, is
refused wherever a reserved segment stands, because an NTFS volume with short
names on opens the long name through it.
Filesystem hosts must support exclusive `wx` file creation, `stat` with an
mtime, `utimes`, `rename`, and `remove`.

The lock is `@smthrs/artifacts/FileLease`, the same lease the artifact store
uses for its objects directory. The file holds a unique owner token, and the
holder refreshes its mtime while the commit runs:

| Bound                          | Value                          |
| ------------------------------ | ------------------------------ |
| Heartbeat interval             | 10 seconds                     |
| Stale after                    | 60 seconds without a heartbeat |
| Acquisition deadline           | 2 minutes                      |
| Retry interval while contended | 25 milliseconds                |

A killed or crashed holder stops heartbeating, and the next committer reclaims
its lock a minute later. Reclaimers of one stale lock race for a `wx` claim
file first, so the lock is moved away at most once and a fresh lock is never
displaced. A committer that cannot take the lock within two minutes fails with
`commit_lock_timeout` instead of waiting forever; the deadline ends before
preflight starts, so it never interrupts an apply. A lock directory left by an
rc.1 build is reclaimed on the same 60-second bound.

The fence is bounded, not absolute. A holder whose host stalls past 60 seconds
(a suspended machine, a stopped debugger) is reaped while it still runs; its
heartbeat logs `Workspace commit lock was reclaimed while its holder was still
running`, and its commit continues unfenced.

Copy-back needs a host that can make those descriptor-relative requests. On
Node and Bun that is `@smthrs/platform-node`'s `AtomicFileSystem.layer`, which
`NodeHost` and `BunHost` already provide; an in-memory volume attests
isolation with `@smthrs/kernel/FileSystem`'s `withIsolatedFileSystem`; the
kernel-guarded `FileSystem.layer` rooted at the same workspace also qualifies.
`WorkspaceSandbox.layerFileSystem` and `StepSandbox.layer` fail to build with
`host_unavailable` over a plain path-based host such as
`NodeFileSystem.layer`, because a path-based check cannot keep a concurrent
symlink swap out of the write. Writers that ignore the advisory lock are not serialized.

The undo journal exists only in memory. A process crash can leave partial file
changes behind; the lock it held is reclaimed once stale. Rollback can also fail: the returned
compound cause preserves the original apply failure and a `WorkspaceError`
with code `host_unavailable` whose cause contains the rollback failure. Neither
case guarantees restoration. The caller owns host reconciliation before
resuming work: inspect affected paths and restore or accept their state.
Waiting for the lock is interruptible, and an interrupted waiter never removes
a lock it does not own.

## Queued effects are dispatched after copy-back, never inside it

A body that wants to send a message calls `Workspace.queueEffect`. The
transaction records it and sends nothing. A speculative send has already reached
the world when its execution turns out to be invalid, and reaches it twice when
a copy-back loses a race.

The optional `EffectDispatcher` stage runs after copy-back settles, deduplicated
by `QueuedEffect.idempotencyKey`, the same key an irreversible action must carry
before it may be retried at all. With no dispatcher provided the engine journals
what a transaction queued and sends nothing. The journal records
`diff-bundle-captured` and `copy-back-settled`.

## One transaction, two hosts

`makeHosted(host)` is the transaction. A `Host` supplies four things: `snapshot`
(the base), `baseline` (the host's digest for a path the transaction never
observed), `retain` (whether a produced file travels inline or by content
address), and `commit` (the serialized, preconditions-first apply), plus a `root`.

Two hosts ship:

- `makeMemory(initialFiles)` is deterministic and browser-safe. It seeds the
  whole tree rather than the declared read set, so an undeclared read is
  observable, which is what makes it the conformance implementation.
- `makeFileSystem(fs, path, artifacts, workspaceRoot, options)` and its layer
  `layerFileSystem(options)` back the transaction with the kernel `FileSystem`,
  the host `Path`, the kernel `Workspace` root, and the artifact store for products too large to
  carry inline.

Because both are `makeHosted` over one `Host`, the transaction, the diff, the
violation check, and the provenance cannot drift between them.

## It is a determinism boundary, not a security boundary

A body that reaches the host through a service the transaction does not seed is
outside the transaction. Denying that ambient access is the VM and
`SandboxProvider` story in [`@smthrs/sandbox`](https://sandbox.smithers.sh/reference/api/). The transaction's
`FileSystem` surface is deliberately partial. `readDirectory` lists immediate
children and accepts `""`, `"."`, and the absolute workspace root as the root.
`exists` recognizes the root, files, and directories implied by visible file
paths. The root exists even when the transaction is empty; empty subdirectories
are not retained, and `makeDirectory` is a no-op. File reads, writes, and removals
require a non-root path. Paths containing `..` are refused. Directory probes
trace the visible files that establish their results for declaration checks.
A settled bundle is applied without a human diff-review gate, which is a known
limitation.

## StepSandbox is the scope-safe front door

`StepSandbox.Service` has one member, `open`, which yields a
`WorkspaceSandbox.Service` for one step or fails with `UnsupportedBoundary`.
`StepSandbox.layer` is the filesystem-backed one, `layerTest(initialFiles)` is
deterministic, and `layerNoop` fails closed for a host that cannot sandbox at
all, such as a browser.

## Related

- [Step boundaries](/concepts/step-boundaries/): the declaration the transaction is
  validated against.
- [Cache admission](/concepts/cache-admission/): why the sandbox is what makes a
  result shareable across runs.
