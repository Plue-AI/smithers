---
title: "Declare the files a node touches"
description: "Write a node's read, write, and removal sets with FileSet: literal paths, globs, tree artifacts, filegroups, and the forms a workspace-relative path may not take."
sidebar:
  order: 6
---

`FileSet` is the static filesystem vocabulary planning and execution share.
A node's `effects` are written in it, and everything the plan knows about
conflicts comes from what you declare here.

```ts
import * as Plan from "@smthrs/plan/Plan"

const effects: Plan.NodeEffects = {
  reads: [{ _tag: "Glob", include: ["src/**/*.ts"] }],
  writes: ["dist/bundle.js"],
  removes: ["dist/stale.js"],
  boundaryMode: "hard"
}
```

## The four declaration forms

| Form           | Written as                                | Where it is valid          |
| -------------- | ----------------------------------------- | -------------------------- |
| `Pattern`      | A workspace-relative literal path string. | reads, writes, and removes |
| `Glob`         | `{_tag: "Glob", include, exclude?}`       | reads and writes           |
| `TreeArtifact` | `{_tag: "TreeArtifact", path}`            | writes only                |
| `Filegroup`    | `{_tag: "Filegroup", name, entries}`      | reads and writes           |

Bare string entries are literal paths at both overlap analysis and execution,
even when they contain `*` or `**`. Use `Glob.include` and `Glob.exclude` for
wildcard matching in read and write declarations.

```ts
import * as FileSet from "@smthrs/plan/FileSet"

const sources: FileSet.Glob = {
  _tag: "Glob",
  include: ["src/**/*.ts"],
  exclude: ["src/**/*.test.ts"]
}

const bundle: FileSet.TreeArtifact = { _tag: "TreeArtifact", path: "dist" }

const group: FileSet.Filegroup = FileSet.makeFilegroup("sources", [sources, "package.json"])
```

A tree artifact is a whole directory captured and replayed as one output. It
belongs in a write set, and `ReadEntry` deliberately excludes it: a read set
names what the node consumes, and a directory output is not that.

## Expanding a filegroup

A filegroup is a name for a reusable collection. Both plan passes expand groups
before they compare anything, and `expand` does the same for a caller,
deterministically and in declaration order:

```ts
const flattened: ReadonlyArray<FileSet.Entry> = FileSet.expand([group, bundle])
const reads: ReadonlyArray<FileSet.ReadEntry> = FileSet.expandReads([
  { _tag: "Filegroup", name: "sources", entries: [sources] }
])
```

`expandReads` is the read-set counterpart, typed so a tree artifact cannot
appear in the result.

## What a workspace-relative path may not be

`workspaceRelative` decides whether a declaration names a file one way only. It
refuses:

- Absolute paths, POSIX (`/etc/passwd`) and drive-letter (`C:/tmp`), and the
  drive-relative `C:tmp`.
- Upward traversal: any `..` segment.
- Aliasing forms: `.` segments and empty segments.
- C0 controls (U+0000 through U+001F) and DEL (U+007F).

C1 controls (U+0080 through U+009F) stay legal, because those bytes are valid in
a POSIX file name.

The aliasing rules are correctness, not tidiness. Two spellings of one file that
the overlap check cannot see would let a plan run a reader and its writer in the
same wavefront round.

## Canonical form

`canonical` rewrites every separator to `/` and normalizes Unicode to NFC. Every
exact-path comparison in the module goes through it:

```ts
const same = FileSet.canonical("dist\\bundle.js") === FileSet.canonical("dist/bundle.js") // true
```

So the backslash spelling and the NFD spelling of one workspace path overlap.
A glob, by contrast, tests the path bytes it is handed: canonicalizing a
_measured_ path before matching it is the caller's decision, because a backslash
inside a path segment is literal text on a POSIX filesystem.

Overlap goes one step further and compares `folded`, the canonical form with
letter case folded away. A case-insensitive filesystem opens `src/A.ts` and
`src/a.ts` as one file, so two nodes writing them serialize.

## Matching and overlap

| Function                        | Answers                                           |
| ------------------------------- | ------------------------------------------------- |
| `matchesPattern(pattern, path)` | Whether one path matches one Bazel-style pattern. |
| `matchesGlob(glob, path)`       | The same, honoring the glob's `exclude` list.     |
| `overlaps(left, right)`         | Whether two entries might share a path.           |
| `isGlob`, `isTreeArtifact`      | Which variant an entry is.                        |

In `Glob.include`, `Glob.exclude`, and the `matchesPattern` helper, `**` matches
path segments; `*` matches within one segment and never crosses a separator. A
trailing `**` matches the rest of the path. Calling `matchesPattern` directly does
not change how a bare string declaration is interpreted.

`overlaps` is conservative by design: `true` may over-serialize, and `false`
proves that no path can belong to both declarations. Two globs always overlap,
and so do a glob and a tree artifact.

## Writes and removals are one set

A removal mutates the world exactly as a write does, so both plan passes fold
`writes` and `removes` together. Declaring one path as both fails compilation
with `invalid_effects`, because the declaration contradicts itself.

`removes` accepts literal path strings only, not globs or tree artifacts.

## Boundary mode

`boundaryMode` is `hard` or `expected`. It travels with the declaration into the
measured boundary at execution time. The plan passes do not interpret it: they
only need to know which paths a node produces and which it consumes.

## Next

- [Declared effects and conflicts](../concepts/effects-and-conflicts.md): what
  the two plan passes do with these declarations.
- [Compile drafts into a plan](./compile-a-plan.md): where effects are decoded
  and written back into key material.
