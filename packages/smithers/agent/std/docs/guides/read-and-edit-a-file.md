---
title: "Read and edit a file"
description: "Page a file with read, anchor an edit by exact text or by an earlier hit's line range, and read what a miss reports back so the next attempt lands."
sidebar:
  order: 2
---

Four flows cover a file: `read`, `write`, `edit`, and `apply_patch`. This guide
is about the loop that matters, which is reading a region and then changing it
without losing the anchor in between.

## Read a page

```ts
import * as Read from "@smthrs/std/Read"

const page = Read.run({ path: "/workspace/src/widen.ts", offset: 40, limit: 20 })
```

`offset` and `limit` are 1-based lines. With neither, you get the first 2,000
lines. The result is:

| Field                  | Meaning                                                 |
| ---------------------- | ------------------------------------------------------- |
| `content`              | Raw page text, byte for byte as the file holds it.      |
| `startLine`, `endLine` | The 1-based range this page covers.                     |
| `totalLines`           | The file's line count.                                  |
| `truncated`            | Whether anything was cut.                               |
| `notice`               | What was shown out of what there was, when `truncated`. |

`content` carries no line-number gutter. That is deliberate: an anchor copied
out of a numbered read carries the numbers with it, so every `edit` built from
one misses. Line numbers are facts about the page, so they are page fields.

Source lines split on `\n`. A trailing `\r` is part of the line, including in
CRLF files. Pages omit the final `\n` and retain every `\r`. For example,
`"one\r\ntwo\r\n"` reads as `"one\r\ntwo\r"`. Copy that text unchanged into
`oldString` or `expect`. Replacement text is also literal: retain the `\r`
bytes in `newString` to keep CRLF endings, including the last line of a range.
A line-range edit leaves the final `\n` outside the replaced span.

A page cut by the byte budget ends on a whole line rather than handing back a
fragment that looks like an anchor and is not one. A line longer than 2,000
characters is clipped, and the notice says so by name, because a clipped line
cannot be an anchor either.

Reading an empty file returns an empty page with `startLine: 1`, `endLine: 0`,
and `totalLines: 0`. Only an `offset` past the end is
`offset_out_of_range`. A directory is `is_directory`; a file holding a NUL byte
or invalid UTF-8 is `binary_file`.

## Edit by exact text

The first anchor form is the file's own bytes:

```ts
import * as Edit from "@smthrs/std/Edit"

const applied = Edit.run({
  path: "/workspace/src/widen.ts",
  oldString: "  return value * 2",
  newString: "  return value * 3"
})
```

The match is byte exact. There is no fuzzy fallback, because a match that is not
your bytes is an edit nobody inspected.

`oldString` must occur exactly once. When it occurs more than once, the call
fails with `invalid_input` naming every line the anchor sits on, so you can widen
it without re-reading the file. Pass `replaceAll: true` to change all of them on
purpose.

When it occurs nowhere, the call fails with `no_match`, and the message carries
the file's **actual** bytes at the nearest region, with that region's line range:

```text
oldString does not occur in /workspace/src/widen.ts. Lines 1-3 actually hold this, raw:
export function widen(value: number): number {
  return value * 2
}

Copy the lines you meant from that text, or anchor by startLine/endLine instead.
```

When not even one line of the anchor occurs in the file, the message says that
instead: the file is the wrong one, or the region is not what you remember.

That is the point of the failure: re-anchor from reality inside the same frame,
rather than re-reading, re-guessing, and missing again.

## Edit by line range

The second anchor form reuses a hit you already have from `read` or `grep`,
instead of retyping the text:

```ts
const applied = Edit.run({
  path: "/workspace/src/widen.ts",
  startLine: 2,
  endLine: 2,
  expect: "  return value * 2",
  newString: "  return value * 3"
})
```

`startLine` and `endLine` are both required and inclusive. `expect` is optional
and turns the retyped copy into a checked assertion rather than a search key: if
those lines hold anything else, the call fails with `no_match` and prints what
they actually hold, which is what a file that moved under your line numbers looks
like.

The two forms do not mix. Each of these is `invalid_input`:

- `oldString` together with `startLine` or `endLine`.
- Neither `oldString` nor a line range. Use `write` to create a file.
- An empty `oldString`.
- `expect` together with `oldString`.
- `replaceAll` together with a line range.
- `endLine` before `startLine`.

A range past the end of the file is `offset_out_of_range`.

## Read the hunk back

Every successful edit returns the region it wrote, raw, with two lines of
context on each side:

```ts
// applied.startLine, applied.endLine: the range of the returned hunk
// applied.replacements: how many occurrences changed
// applied.hunk: the edited region as it now stands
```

A mis-indented edit costs one glance at `hunk` instead of an investigation.

## Concurrent changes

`edit`, `write`, and `apply_patch` hold exclusive sibling directory locks from
before reading until their mutation finishes. Existing symlink aliases share
the resolved file's lock. Case and Unicode normalization variants conservatively
share a lock, even on a case-sensitive filesystem. Separate hosts and processes using these handlers
coordinate through the same filesystem; it must implement exclusive directory
creation. A competing call fails with `no_match` and names the busy file before
changing it. Re-read and retry after the other writer finishes. Anchors and
line-range `expect` are checked again on every retry.

A patch locks all source and destination paths before reading update contents.
It may create destination parent directories first. Failure to acquire any lock
releases the locks already acquired without applying file changes. Locks also
release on ordinary failure and Effect interruption. Process death leaves a
`.smithers-*.lock` directory and subsequent calls refuse to write. Stop all
writers for that file, inspect its contents, and remove only the lock named in
the refusal before retrying. Locks are never reclaimed by age.

These locks coordinate standard handlers sharing a filesystem, including patch
adds, deletes, and moves. Shell commands, editors, and other programs that do
not use this protocol are outside that guarantee. Whole-file `write` and patch
add operations intentionally replace contents; use an anchored edit when a
previously read version must still match.

## Write a whole file

`write` replaces a file, creating parent directories:

```ts
import * as Write from "@smthrs/std/Write"

const written = Write.run({ path: "/workspace/notes.md", content: "# Notes\n" })
// written.bytesWritten, written.created
```

It preserves the file's mode, and it refuses to write over a directory with
`command_failed`. Prefer `edit` for a targeted change: a whole-file write of a
file you only partly know is how an unrelated region disappears.

`write`, `edit`, and `apply_patch` updates stage replacement bytes in a unique
sibling file, preserve existing permission bits and ownership, then rename it
over the destination. A failure before rename leaves the original bytes intact.
Existing symlinks continue to target the same file. Hard links to the old inode
keep its old contents. The host must support exclusive creation and atomic
rename; unsupported operations fail without falling back to truncation.

Temporary files are removed on failure and Effect interruption. Process death
can leave an unused temporary file. This is per-file atomicity, not a transaction
across a whole patch or a promise of persistence after power loss. No `fsync` is
performed. Timestamps and extended metadata such as ACLs are not copied.

## Apply a patch instead

`apply_patch` accepts Codex's V4A patch text as one string, so a model trained on
that tool can use the shape it knows:

```ts
import * as ApplyPatch from "@smthrs/std/ApplyPatch"

const result = ApplyPatch.run({
  input: [
    "*** Begin Patch",
    "*** Update File: src/widen.ts",
    "@@",
    "-  return value * 2",
    "+  return value * 3",
    "*** End Patch"
  ].join("\n")
})
// result.added, result.modified, result.deleted, result.output
```

One rule to know: a patch naming the same file in two sections is refused whole
rather than applied by halves. Every update hunk is derived from the file as it
is on disk, so the second section would start from an original the first has
already replaced. A file needing several changes carries several `@@` chunks
inside one section.

Because a patch names its files inside its own text, `apply_patch` cannot narrow
its effect envelope for one call, and declares the workspace-wide worst case.
`edit` narrows to the one path it was given, so prefer `edit` where a scheduler
is running calls concurrently.
