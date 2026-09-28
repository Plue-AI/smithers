---
title: "Give each parallel agent its own workspace lane"
description: "Add a named jj workspace for a parallel agent, pin it at a recorded revision, and forget it afterwards, including how relative lane paths resolve and what a forget leaves behind."
sidebar:
  order: 2
---

A jj workspace is a second working copy over one repository. Smithers uses one
per parallel agent so two agents editing the same checkout never see each
other's half-written files, and [`@smthrs/time-travel`](/api/time-travel) forks
a run by adding one.

## Add a lane

```ts
import { Jj } from "@smthrs/jj"
import * as Effect from "effect/Effect"

const openLane = (name: string, path: string) =>
  Effect.gen(function*() {
    const jj = yield* Jj
    yield* jj.workspaceAdd(name, path)
  })
```

`name` is the lane's identity inside the repository. `path` is the directory the
new working copy lands in, and jj creates it.

Both are opaque argv, never a shell fragment. The adapter passes the name as
`--name=<value>` and the path after a `--` terminator, so a lane called
`-dash-lane` is a name rather than a bundle of short flags, and a path of
`--config-file=/tmp/x.toml` is a positional rather than a jj global option.
Separators, spaces, semicolons, and non-ASCII characters all survive intact,
because nothing here reaches a shell.

## Pin the lane at a recorded revision

```ts
const forkAt = (name: string, path: string, commitId: string) =>
  Effect.gen(function*() {
    const jj = yield* Jj
    yield* jj.workspaceAdd(name, path, commitId)
  })
```

With a third argument the new workspace opens at that revision instead of the
lane default. That is how a fork lands the child on the frame's recorded
pointer without touching the parent's working copy: the parent keeps editing
where it was, and the child starts from the tree the run recorded.

The recorded pointer is a commit id. When a step later rewrote that change, for
example with `jj squash`, the commit is hidden, and pinning a lane at it brings
it back as a divergent sibling of the rewritten change. That sibling holds the
tree the run recorded, which is the one a fork needs.

An empty revision string fails `invalid_ref` before jj is spawned, and no lane
directory is created.

## Forget the lane afterwards

```ts
const closeLane = (name: string) =>
  Effect.gen(function*() {
    const jj = yield* Jj
    yield* jj.workspaceForget(name)
  })
```

Two properties make this safe to run on a cleanup path:

- **It is idempotent.** Forgetting a lane nobody added succeeds. A cleanup path
  runs after failures too, so a forget that failed on an absent lane would turn
  one error into two.
- **It does not touch the commits made in the lane.** The work is still in the
  repository; only the workspace registration goes away.

The lane **directory stays on disk**. Removing it is the caller's job, in both
the CLI and the WebAssembly backends.

## Where a relative lane path resolves

This is the one behavior that changes with the layer you chose:

| Layer                                     | A relative `path` resolves against |
| ----------------------------------------- | ---------------------------------- |
| `NodeJj.layer`, `NodeJj.layerSpawner`     | the caller's working directory     |
| `NodeJj.layerAt`, `NodeJj.layerSpawnerAt` | the bound repository root          |

The same call therefore builds the lane in two different places depending on
the composition. Pass absolute lane paths and the question does not arise. See
[Bind jj to a repository and contain its child process](./bind-and-contain.md).

## Under the capability kernel

The guarded implementation adds `PlatformError` to `workspaceAdd`'s error
channel, because it canonicalizes the destination against the workspace root
before asking for the `jj:workspace-add` and `fs:write` grants, and resolving a
path is itself a filesystem operation that can fail. It canonicalizes a second
time after the checks and refuses with a permission error if the answer moved,
so a symlink that already exists, or one planted before that second resolution,
cannot redirect the lane. The second resolution narrows the race without closing
it: jj receives a path, not a directory handle, so a process that can write in
the workspace and swaps a path component after the second resolution and before
jj creates the directory can still place the lane elsewhere. Do not share a lane
parent directory with a writer you do not trust.

Narrow with `isJjError` before reading a `code` off that channel:

```ts
import { isJjError, Jj } from "@smthrs/jj"
import * as Effect from "effect/Effect"

const laneFailure = Effect.gen(function*() {
  const jj = yield* Jj
  const failure = yield* Effect.flip(jj.workspaceAdd("lane", "/tmp/lane", ""))
  return isJjError(failure) ? failure.code : "not a jj failure"
})
```

## What can go wrong

- A lane path that cannot be created, such as a directory nested under a
  regular file, fails `unknown` with the reason in the message. No workspace is
  registered and no directory is left behind.
- An unresolvable pin revision fails `invalid_ref`.
- On the browser layer a pinned add is two calls rather than one, and a failed
  pin rolls the add back. The edge case where both fail is described in
  [Run jj in a browser tab](./run-jj-in-a-browser.md#a-pinned-lane-is-two-calls).
