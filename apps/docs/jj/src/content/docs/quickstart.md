---
title: "Quickstart"
description: "Snapshot a real repository, diff two snapshots, and restore the working copy back out of one, in a single file against the jj CLI."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/jj/docs/quickstart.md"
---

This quickstart runs the whole reversible-step cycle against a real repository:
take a snapshot, change a file, take another, read the diff between them, and
put the working copy back. By the end you will have seen the three operations
Smithers relies on to undo a step, and the change id that ties them together.

## Prerequisites

- Node.js 26.4.0 or later.
- `jj` on `PATH`. Check with `jj --version`; see
  [Installation](/installation/) if it is missing.
- `@smthrs/jj` and its `effect` peer resolvable from the file you are about to
  write. [Installation](/installation/) has the workspace form.

## Create a repository to work in

The layer operates on a repository; it never creates one. Make a throwaway:

```bash
jj git init ~/jj-quickstart
cd ~/jj-quickstart
```

## Write the program

Create `quickstart.ts` in that directory:

```ts
import { Jj } from "@smthrs/jj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import * as Effect from "effect/Effect"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const repository = process.cwd()
const note = join(repository, "note.txt")

const program = Effect.gen(function*() {
  const jj = yield* Jj

  // The state to come back to. `snapshot` describes the current change, reads
  // its commit id, and opens a fresh one, so the id names the tree just closed.
  writeFileSync(note, "first\n")
  const { commitId } = yield* jj.snapshot("first note")

  // Do the work a step would do.
  writeFileSync(note, "second\n")
  yield* jj.snapshot("second note")

  // `@-` is the parent of the working copy: the change the second snapshot
  // just closed.
  const diff = yield* jj.diff(commitId, "@-")
  console.log(diff)

  // Undo it. `restore` replaces the working copy with the recorded tree.
  yield* jj.restore(commitId)
  console.log(`note.txt is now: ${readFileSync(note, "utf8").trim()}`)
}).pipe(Effect.provide(NodeJj.layerAt(repository)))

Effect.runPromise(program)
```

`layerAt` binds jj to one absolute repository root, so a later change to
`process.cwd()` cannot redirect these operations into another checkout. Use
`NodeJj.layer` instead when the repository is genuinely whatever directory the
process is in.

## Run it

Run the file with your TypeScript runner, from the repository directory. It
prints the git-format diff between the two snapshots, then the content restore
recovered:

```text
diff --git a/note.txt b/note.txt
...
-first
+second

note.txt is now: first
```

## What just happened

`snapshot("first note")` set the description on the working-copy change, read
back its commit id and short change id, and opened a new empty change on top.
The commit id is the durable handle: it names one tree forever, survives a
process restart, and is what Smithers stores in the journal. The change id is
a display name that follows later rewrites of the change.

`diff(from, to)` asked jj for a git-format unified diff between two revisions.
Each argument is `@`, `@-`, a commit id, or a change id. Any other string, such
as a revset, fails with `invalid_ref` before jj runs, and an id that resolves to
nothing fails with `invalid_ref` rather than producing an empty diff.

`restore(commitId)` replaced the working copy with the tree recorded at that
commit. It is a replacement, not a merge: uncommitted edits are overwritten and
files created after the snapshot are removed. That is the property that makes a
step reversible, and the reason to reach for `revert` instead when you mean
"undo that one attempt and keep the rest".

## Next steps

- [Snapshot a working copy and put it back](/guides/snapshot-and-restore/):
  the difference between `restore` and `revert`, and when each is right.
- [Give each parallel agent its own workspace lane](/guides/workspace-lanes/):
  `workspaceAdd`, pinned revisions, and cleanup.
- [How a jj failure is reported](/concepts/failures/): the six codes and
  what each one means.
