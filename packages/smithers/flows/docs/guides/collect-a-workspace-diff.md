---
title: "Collect the files a sandboxed child wrote"
description: "Turn on collectDiff to read back the files a guest created, changed, or deleted, understand how changes are detected and the one edit a timeless provider misses, and set the limits that bound it."
sidebar:
  order: 5
---

A sandboxed child that only computes a value needs nothing here: read
`result.output`. This guide is for a child that writes files, where you also
want what it wrote.

## Ask for the diff

`collectDiff` is off by default. Turn it on and `result.diff` carries every file
the guest created or changed, and `result.deleted` lists every file it removed,
paths relative to the session workdir.

```ts
import * as SandboxedFlow from "@smthrs/flows/SandboxedFlow"
import * as Effect from "effect/Effect"

const report = Effect.gen(function*() {
  const result = yield* SandboxedFlow.execute(Writer, { count: 3 }, {
    provider,
    session: "writer-1",
    entry: new URL("./child.ts", import.meta.url),
    collectDiff: true
  })

  for (const file of result.diff) {
    console.log(`${file.path}: ${file.bytes.length} bytes`)
  }
})
```

Each entry is a `DiffEntry`: a `path` and the file's `bytes` as a
`Uint8Array`. The protocol's own files under `.smithers-sandbox/` never appear.

## The diff is data, not an applied change

Nothing on the host is modified. `result.diff` and `result.deleted` are values
you decide what to do with: apply them to a workspace, attach them to a review,
or throw them away.

Nothing holds the diff for a person to accept first. A host that wants review
builds it around this value: hold `result.diff`, show it, and apply it when
someone accepts.

## Change detection compares sizes and modification times

The host lists the workspace before the guest runs and again after. It collects
every path that is new or whose size or modification time changed, and lists
every path that was there before and is gone after in `result.deleted`.

Each walk is one directory listing followed by the stats, and the stats run
sixteen at a time. It matters because a provider with no native filesystem
answers each `stat` with a session command in the guest, so a serial walk pays
one remote round trip per workspace file, twice per execution. The bound is
there for the other direction: an unbounded walk would open one guest process
per file at once. Results keep the listing's order, so the order of
`result.diff` does not depend on which stat answered first.

A provider whose `stat` reports no modification time, such as the portable
shell probes a session with no native filesystem falls back to, compares sizes
alone. On such a provider **a file rewritten in place at exactly its previous
size is missed.** It can only happen on a reattached workspace, because a fresh
workspace holds nothing but the protocol's own files, which makes every file the
child writes a creation. If your child edits files it did not create on such a
provider, either have it write to new paths or compute the change inside the
child and return it as part of `output`.

Directories the guest creates are listed through, not read as files, so a
nested path arrives as its files.

## Bound what comes back

The limits are shared with the result readback. Any bound you omit keeps its
default. Bounds are inclusive: exactly the configured count or byte total is
accepted. A zero diff budget permits empty files; a zero file budget permits
no changed files. A zero result budget rejects every protocol result. Byte
limits count encoded bytes, including multibyte UTF-8 and the result envelope.

| Bound         | Default | What it caps                                      |
| ------------- | ------- | ------------------------------------------------- |
| `resultBytes` | 5 MiB   | The result JSON the guest wrote.                  |
| `diffBytes`   | 100 MiB | The total bytes collected across the diff.        |
| `files`       | 1,000   | The number of created or changed files collected. |

```ts
const bounded = SandboxedFlow.execute(Writer, { count: 3 }, {
  provider,
  session: "writer-1",
  entry,
  collectDiff: true,
  limits: { files: 50, diffBytes: 8 * 1024 * 1024 }
})
```

`SandboxedFlow.defaultLimits` is the resolved default object, readable if you
want to derive from it.

`files` is spent during the second walk: the walk fails as soon as it has seen
more changed files than the bound allows, rather than statting the rest of a
workspace whose diff is already refused. The message names the limit, not a
total the walk stopped short of measuring.

The diff holds regular files only. A symbolic link the guest leaves in the
workspace, or a file reached through one, is not collected: its bytes would be
the link target's, which on a provider backed by the host's disk can sit
outside the workspace. A created, changed, or deleted path that holds a
backslash, a `.`, `..`, or empty segment, or a drive prefix fails the execution
with `diff_unsafe`, because an applier could write it outside the workspace.

Exceeding a diff bound fails the execution with `diff_overflow`, and exceeding
`resultBytes` fails it with `result_overflow`. Metadata sizes can refuse a read early. Readback stops at the remaining
byte budget plus one, and actual bytes count toward the aggregate diff limit
before a file is appended. A file that grows after the snapshot cannot bypass
the bound. Native filesystem streams receive a bounded read request; other
providers run `head -c` in the guest to bound transfer. The guest image must
provide `head` with `-c` support. Overflow messages report the limit; a bounded
read need not discover the full size of an oversized file.

## Journal the diff

`resultSchema(success)` builds the action's success schema as
`{ output, diff, deleted }`, and `Diff`, `DiffEntry`, and `Deleted` are the
schemas underneath it. A result journaled before `deleted` existed decodes with
an empty list.
The bytes serialize as base64, so a sandboxed action's whole result is
JSON-encodable and replays out of the journal unchanged.

That is what makes a sandboxed execution work as
[one durable action](./run-a-child-flow-in-a-sandbox.md): a replay hands back
the same files without acquiring a machine.
