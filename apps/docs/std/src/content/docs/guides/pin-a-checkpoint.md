---
title: "Pin a tree and read it later"
description: "Record the working tree as a checkpoint, materialize it as a scratch directory for the length of one call, and relocate a read or a command onto it."
sidebar:
  order: 6
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/std/docs/guides/pin-a-checkpoint.md"
---

A checkpoint is a **value**. Minting one changes nothing about the workspace,
and running a call against one leaves the live tree exactly as it stands. That
is the whole of what it buys: before it existed, the only way to answer "did
this fail before my change" was to undo the change, which means reverting the
very work the reading was meant to prove.

This module is the host half of [`@smthrs/harness`](https://harness.smithers.sh/reference/api/)'s
`ctx.checkpoint()` and `ctx.call(flow, input, { at })`. The harness owns the
surface, the identity, the bound, and the refusals; this owns the two host
operations that need a real tree.

## Bind the git store

```ts
import * as Checkpoints from "@smthrs/std/Checkpoints"

const store = Checkpoints.layerGit({
  root: "/workspace/repo", // the host path of the git repository
  cwd: "/testbed", // where a container sees that same directory
  baseRef: "refs/flows/capture-base" // optional
})
```

`layerGit` requires a `ChildProcessSpawner`. A host that pins nothing binds
`Checkpoints.layerNoop`, whose refusal says to take the reading on the live tree
instead.

## Capture and materialize

```ts
import * as Effect from "effect/Effect"

const reading = Effect.gen(function*() {
  const checkpoints = yield* Checkpoints.Checkpoints
  const snapshot = yield* checkpoints.capture("before-fix")
  return yield* checkpoints.materialize(snapshot.id, (tree) => Effect.succeed(tree.host))
})
```

`capture(id)` records the working tree as it stands and returns a `Snapshot`
with the `id` you gave and the store's own `ref` for it. `materialize(id, use)`
hands the tree back as a directory for the length of the effect you pass, and
removes it however that effect ends. It is scoped rather than returned, because
a run killed at its wall-clock budget would otherwise leave a second checkout of
the whole repository inside the tree whose diff is the run's answer.

A `Materialized` carries four paths, because one directory can have two names:

| Field       | Meaning                                               |
| ----------- | ----------------------------------------------------- |
| `host`      | Where a process on this machine finds the checkpoint. |
| `guest`     | Where a container finds the same directory.           |
| `root`      | The workspace itself, as this machine names it.       |
| `guestRoot` | The workspace as a container names it.                |

`Checkpoints.baseId` is `"base"`, the tree the run opened on. It is not minted:
the store uses `baseRef` when one is declared. A declared ref that
does not resolve is `not_found`. Otherwise it tries `TestRunner.captureBase`
and then `HEAD`, matching `test`.

## What the git binding does, and does not do

`layerGit` records with `git stash create`, which is the one git command that
records the working tree and changes nothing else: it does not move the
worktree and does not touch the stash ref. It runs against a temporary shadow
`GIT_DIR` that shares only the workspace's objects and reads a copy of the
workspace index, so it never writes the agent's index and never runs a hook,
`core.fsmonitor` command or filter driver the workspace's `.git` names. That matters
because the agent runs `git` in this same workspace and its own `git diff` is
the run's evidence. A capture that staged into the real index would be the
harness editing the evidence while recording it. A tree with nothing to record
prints nothing, and the checkpoint is then `HEAD`, which is exactly what the
tree is.

The commit is named in the repository's own git config, under
`Checkpoints.configSection` (`flows-checkpoint`), and **not** by a ref. A ref is
history: `git log --all` lists it, `git show` prints it, and `git log --all -S`
searches it, so a checkpoint named by a ref would hand an agent a commit
containing its own edit and let it read that back as if it were upstream work.
Under config the commit object stays unreferenced, a checkout by id works
perfectly well, and no command that walks refs can reach it.

One command still sees it: `git fsck` reports it as a dangling commit, because
that is what an unreferenced commit is. A checkout is a standalone repository
rather than a worktree of the workspace, so `git log --all` in the workspace
does not list it even while a call runs in it.

Untracked files are not in the recorded tree, which matches how a patch is
captured. Materialization is a detached checkout at
`<root>/.flows-checkpoints/<id>-<lease>`, under `Checkpoints.scratchDirectory`.
Its own `.git` names the commit in `HEAD` and reaches the workspace's objects
through a relative `objects/info/alternates`, so git run in it through a
container mount works.
Each call gets a unique lease, so overlapping calls never remove each other's
checkout. Existing checkouts are left alone; a `SIGKILL` can leave one behind.
Inside the workspace is the only placement that works, for the same reason the
`test` baseline is placed there: a container sees the workspace through a mount,
and a scratch checkout anywhere else on the host is not visible to it.

## Point a call at a checkpoint

`relocate` rewrites one call's input so the call runs against a materialized
checkpoint. It is a closed table, not a per-flow hook:

```ts
const relocation = Checkpoints.relocate("read", { path: "src/widen.ts" }, tree)

if (relocation._tag === "Relocated") {
  // relocation.input now reads .flows-checkpoints/<id>-<lease>/src/widen.ts
}
```

| Flow           | The field it is relocated by                                           |
| -------------- | ---------------------------------------------------------------------- |
| `bash`         | `cwd`, into the checkpoint and into the same subdirectory it asked for |
| `read`, `ls`   | `path`, prefixed with the checkpoint's workspace-relative directory    |
| `grep`, `glob` | `root`, prefixed the same way                                          |

`bash` is relocated from the guest side when the call names a container, because
that is the path the container will be given. Keeping the subdirectory matters:
a check declared in `tests/` that silently ran at the top would come back
failing for a reason nobody chose.

Three inputs are refused rather than rewritten, and the tag says which:

- `UnsupportedFlow`, for any flow outside that table. `test` is deliberately
  outside it: it answers this question already with `against: "base"`, and two
  mechanisms pointed at one tree are two answers that can disagree.
- `AbsolutePath`, because an absolute path in these runs is a container path and
  the host cannot know which prefix of it names the tree.
- `OutsideTree`, for a relative path that climbs past the checkpoint with `..`,
  which names the live tree under another name. That is exactly the tree the
  reading was taken to avoid, and a call key folds the checkpoint in, so a live
  reading recorded under a checkpoint would replay as a pinned one forever.
