---
title: "Quickstart"
description: "Search a real directory with grep, then read the exact definition the hit sits in, using the in-process search peer and no external binary."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/std/docs/quickstart.md"
---

This quickstart runs two standard flows end to end against a real directory.
`grep` finds a line and reports the definition that encloses it; `read` turns
that definition's line range into a page. By the end you will have taken the two
steps an agent takes hundreds of times a run, and you will have taken them
without an external binary and without an API key.

## Prerequisites

- Node.js 26.4.0 or later.
- A package with the dependencies installed. Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

## Make a tree to search

Two files, so the glob filter has something to exclude:

```bash
mkdir -p /tmp/std-quickstart/src
printf 'export function widen(value: number): number {\n  return value * 2\n}\n' > /tmp/std-quickstart/src/widen.ts
printf 'widen is defined in src/widen.ts\n' > /tmp/std-quickstart/README.md
```

## Compose the host

`Grep.run` asks for the `Search` service; `Read.run` asks for `FileSystem`.
`PortableSearch` is the in-process implementation of `Search`, so the whole
composition is two layers:

```ts
import { NodeServices } from "@effect/platform-node"
import * as PortableSearch from "@smthrs/std/PortableSearch"
import * as Layer from "effect/Layer"

/** FileSystem, Path, and ChildProcessSpawner, from the Node platform. */
const platform = NodeServices.layer

/** The in-process Search peer, built over that platform. */
const search = PortableSearch.layer.pipe(Layer.provide(platform))

const host = Layer.merge(platform, search)
```

Swapping `PortableSearch.layer` for `NativeSearch.layer` runs the same calls
through the `rg` executable instead. Nothing else in this file changes, which is
the point of the seam. See [The search contract](/concepts/search-contract/).

## Search, then read what you found

Each returned hit carries the definition it sits inside, when the file's shape
says so plainly. That is a line range, so it is a read window rather than a
guess:

```ts
import * as Grep from "@smthrs/std/Grep"
import * as Read from "@smthrs/std/Read"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const found = yield* Grep.run({
    pattern: "widen",
    root: "/tmp/std-quickstart",
    globs: ["*.ts"]
  })
  const hit = found.matches[0]
  if (hit === undefined) return "no match"
  console.log(`${hit.file}:${hit.line}  ${hit.text}`)
  console.log(`searched ${found.filesSearched} file(s)`)

  const symbol = hit.symbol
  if (symbol === undefined) return "no enclosing definition"
  const page = yield* Read.run({
    path: hit.file,
    offset: symbol.startLine,
    limit: symbol.endLine - symbol.startLine + 1
  })
  return `${symbol.kind} ${symbol.name}\n${page.content}`
})

console.log(await Effect.runPromise(Effect.provide(program, host)))
```

Run the file with your TypeScript runner. The output is the hit, the file count,
and the whole definition:

```text
/tmp/std-quickstart/src/widen.ts:1  export function widen(value: number): number {
searched 1 file(s)
function widen
export function widen(value: number): number {
  return value * 2
}
```

`filesSearched` is 1 because `globs: ["*.ts"]` excluded `README.md`. A glob
without a `/` matches a basename at any depth, so `*.ts` reaches
`src/widen.ts` without naming the directory.

## What just happened

- `page.content` is raw file text. The line numbers came back as the sibling
  fields `startLine`, `endLine`, and `totalLines`, never as a gutter inside the
  text, so any line of `content` can be pasted straight into `edit` as an
  anchor.
- `hit.symbol` is a heuristic that reports only what a file's shape says
  plainly. When it cannot read a definition, it answers `undefined` rather than
  guessing a window.
- Neither call took a limit from you, and both applied one: `grep` returns at
  most 200 matches and `read` at most 2,000 lines. Whenever a limit bites, the
  result says so in `truncated` and `notice`. See
  [Limits are disclosed, never silent](/concepts/limits-and-disclosure/).

## Next steps

- [Search a workspace](/guides/search-a-workspace/) for globs, context lines,
  case rules, and the literal retry.
- [Read and edit a file](/guides/read-and-edit-a-file/) for the two anchor
  forms `edit` accepts and what a miss reports.
- [Bind the standard flows into a host](/guides/bind-the-standard-flows/) to
  offer all 17 flows to an agent instead of calling two by hand.
