---
title: "Snapshot a working copy and put it back"
description: "Take a commit id you can return to, choose between restore and revert, and know what each one does to uncommitted edits and to later work."
sidebar:
  order: 1
---

Making a step reversible is two decisions: record a point you can return to,
and pick the operation that undoes the right amount of work.

## Record a point

```ts
import { Jj } from "@smthrs/jj"
import * as Effect from "effect/Effect"

const before = Effect.gen(function*() {
  const jj = yield* Jj
  const { commitId } = yield* jj.snapshot("before the review step")
  return commitId
})
```

On every backend, `snapshot` captures the working copy into the current change
without closing it, describing it, or opening a new one, so repeated snapshots
add no commits to your log. It returns three ids:

- `commitId` names the captured tree. It is content addressed, so
  nothing done later can change what it names, and jj still resolves it after
  the commit is hidden. Keep it: Smithers journals it so a retry, a resumed
  run, or a rewind returns to exactly that tree.
- `changeId` is the change's short human name. A rewrite moves it: the step
  that runs next edits the same change, so the change id names the step's
  edits, and an `abandon` makes it stop resolving. Show it to people; never
  restore to it.
- `operationId` names the jj operation that recorded the capture. Pass it to
  `opRestore` to restore local repository state, including bookmarks and rebases.
  Current remote and Git metadata stay intact; changes to another workspace
  make the restore fail.

Journal rows written before 1.0.0-rc.2 hold a change id. Change ids are reverse
hex (`k-z`) and commit ids are hex (`0-9a-f`), so both still resolve unchanged
and no migration is needed; the older rows keep the weaker change-id meaning.

### Snapshot without a message

```ts
const unnamed = Effect.gen(function*() {
  const jj = yield* Jj
  const { commitId } = yield* jj.snapshot()
  return commitId
})
```

The message is optional. Every backend leaves the change description intact,
with or without one: the engine keeps its label in the journal.

## Undo the whole point: restore

```ts
const rewind = (commitId: string) =>
  Effect.gen(function*() {
    const jj = yield* Jj
    yield* jj.restore(commitId)
  })
```

`restore` replaces the working copy with the tree recorded at `commitId`. It is
a replacement, not a merge:

- An uncommitted edit to a tracked file is overwritten, without a rejection.
- A file created after the snapshot is removed.

A caller expecting a merge loses work here, which is why it is written down and
why the package pins the behavior in a test. Reach for `restore` when you mean
"the world should look the way it looked", which is what rewinding a run to a
checkpoint means.

## Undo one change and keep the rest: revert

```ts
const undoOneAttempt = (changeId: string) =>
  Effect.gen(function*() {
    const jj = yield* Jj
    const { reverted } = yield* jj.revert!(changeId)
    return reverted
  })
```

`revert` applies the reverse of one change and inserts it underneath the working
copy, so the working copy holds the reverted tree rather than a commit that
undoes it somewhere else in the graph. Work committed after `changeId` survives.

The paths come back because a caller has to be able to say what was undone.
They are read before the revert runs, so they are the paths the reverted change
touched rather than a fact about where the revert landed, and they are reported
byte for byte: a tracked file named `" lead.txt"` or `"trail .txt"` arrives with
its spaces intact.

`revert` is optional on the interface, hence the `!`. Every layer this package
ships defines it, and answers `not_installed` where the backend cannot perform
it. See [Version control as a capability](../concepts/version-control-as-a-capability.md#three-members-are-optional-and-none-of-them-is-absent)
for why that is the shape.

## Undo the whole repository: opRestore

```ts
const rewindRepository = (operationId: string) =>
  Effect.gen(function*() {
    const jj = yield* Jj
    yield* jj.opRestore!(operationId)
  })
```

`opRestore` runs `jj op restore`. Bookmarks, heads, and working-copy commits
return to the operation's view, so bookmark moves, rebases, `describe`, and
`abandon` made after the snapshot are undone along with the tree. The
operations after it stay in `jj op log`. Node and Bun refuse with `conflict`
when another workspace was added or moved after the operation.

## Which one to use

| You mean                                           | Use                      |
| -------------------------------------------------- | ------------------------ |
| Rewind the run to the checkpoint it opened on      | `restore(commitId)`      |
| Also undo bookmark moves, rebases, and abandons    | `opRestore(operationId)` |
| Undo that one attempt and keep everything after it | `revert(changeId)`       |
| Show what changed between two points               | `diff(from, to)`         |

## Read the difference first

```ts
const changedSince = (changeId: string) =>
  Effect.gen(function*() {
    const jj = yield* Jj
    return yield* jj.diff(changeId, "@")
  })
```

`diff` produces a git-format unified diff. Both arguments go through jj's
revision language, so `@` (the working copy), `@-` (its parent), and a change
id all work. A revision that does not resolve fails with `invalid_ref` rather
than producing an empty diff, and an empty string fails with `invalid_ref`
before jj is spawned at all.

## What can go wrong

- A revision that does not resolve, or an empty string, fails `invalid_ref`.
- Running outside a repository fails `unknown`, carrying jj's own
  "There is no jj repo" text in the message.
- A working copy jj refuses to move fails `conflict`.
- No usable jj fails `not_installed` with the install guidance in the message.

Each one, with the fix, is in [Troubleshooting](../troubleshooting.md).
