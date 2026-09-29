---
title: "Search a workspace"
description: "Find files with glob and search their contents with grep: roots, ordered include and exclude patterns, context lines, per-file caps, and the notices that keep an empty answer from lying."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/std/docs/guides/search-a-workspace.md"
---

Both flows go through the `Search` service, so bind either
[`PortableSearch.layer` or `NativeSearch.layer`](/guides/bind-the-standard-flows/)
first. The semantics are identical; see
[The search contract](/concepts/search-contract/) for why.

## Choose the search root

`root` defaults to `.`, resolved by the host filesystem. A guarded agent host
resolves it inside its workspace. Pass a root to search another directory:

```ts
import * as Glob from "@smthrs/std/Glob"

const files = Glob.run({ pattern: "**/*.ts", root: "/workspace" })
// files.paths, files.total, files.truncated, files.notice
```

Every pattern is matched against a candidate's path **relative to that root**.
An absolute pattern such as `/workspace/tests/**` is read as the root-relative
path `workspace/tests/**`, which nothing under `/workspace` can match. When that
happens, `notice` says so rather than returning a silent empty result.

Three rules follow from root-relative matching:

- No `/` in the pattern matches the basename at any depth: `*.ts` finds every
  TypeScript file in the subtree.
- A `/` in the pattern anchors it at the root: `src/*.ts` matches
  `<root>/src/a.ts` and not `<root>/lib/src/a.ts`.
- A leading `/` or `./` is the same anchor spelled out.

`glob` returns at most 1,000 paths per call, and `limit` lowers that. Pass
`hidden: true` to include dot files.

Both flows apply `.gitignore` rules from the search root and nested directories,
even outside Git repositories. `noIgnore` is an optional boolean defaulting to
`false`; set `noIgnore: true` to include ignored paths. Rules above the root and
global ignore files do not apply. Hidden-file and fixed directory skips still
apply when `noIgnore` is true.

## Search contents

```ts
import * as Grep from "@smthrs/std/Grep"

const found = Grep.run({
  pattern: "def widen",
  root: "/workspace",
  globs: ["**/*.py", "!**/test_*.py"],
  context: 2,
  maxCount: 3,
  limit: 50
})
```

| Input                                      | What it does                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `pattern`                                  | A Smithers Ripgrep ASCII v1 expression, or a literal with `fixedStrings`. |
| `globs`                                    | Ordered include and exclude patterns, `!` for exclusion.                  |
| `ignoreCase`, `smartCase`                  | Case handling. The two are mutually exclusive.                            |
| `beforeContext`, `afterContext`, `context` | Context lines. `context` cannot be combined with the other two.           |
| `maxCount`                                 | At most this many matches per file. At least 1.                           |
| `filesWithMatches`                         | Report file names only.                                                   |
| `hidden`                                   | Include dot files.                                                        |
| `noIgnore`                                 | Include paths excluded by `.gitignore` when true. Defaults to false.      |
| `symbols`                                  | Report the definition enclosing each hit. True by default.                |
| `limit`                                    | Global match budget, capped at 200.                                       |

The output is match-centric:

| Output                | Meaning                                                                   |
| --------------------- | ------------------------------------------------------------------------- |
| `matches`             | Each hit with its own `before` and `after` context and optional `symbol`. |
| `files`               | The file list, which is what `filesWithMatches` fills.                    |
| `filesSearched`       | Every file the globs admitted, including binaries and unopenable files.   |
| `skippedBinary`       | How many of those held a NUL byte.                                        |
| `truncated`, `notice` | Whether the budget bit, and what was shown out of what there was.         |
| `retriedAsLiteral`    | Present when these results came from re-running the pattern literally.    |

`limit` counts matches, not rows, so context can never crowd out the hit it
belongs to.

## Read the definition a hit sits in

Each hit carries the definition enclosing it, when the file's shape says so
plainly. That is a read window, so the follow-up read is exact rather than a
guess at `line - 10`:

```ts
import * as Read from "@smthrs/std/Read"

const hit = found.matches[0]
if (hit?.symbol !== undefined) {
  const page = Read.run({
    path: hit.file,
    offset: hit.symbol.startLine,
    limit: hit.symbol.endLine - hit.symbol.startLine + 1
  })
}
```

Set `symbols: false` to skip the annotation. When the shape is not plain, the
heuristic answers nothing rather than guessing a window.

## When a regular expression finds nothing

A pattern full of metacharacters that finds nothing is the most common way a
search lies. If a pattern containing metacharacters produces no matches and no
files, the search runs again with `fixedStrings: true`, and if the literal
reading finds something the result carries `retriedAsLiteral: true` and says so
in `notice`. The retry costs one more pass only in the case that already found
nothing.

To search a literal on purpose, pass `fixedStrings: true` yourself and skip the
regular expression grammar entirely.

## What is refused

These are `invalid_input` rather than a best guess, because two peer
implementations must not each pick their own reading:

- `ignoreCase` and `smartCase` both true.
- `context` together with `beforeContext` or `afterContext`.
- `maxCount` below 1.

File-type registries are unsupported; there is no `types` input field.

An unsupported pattern is `invalid_pattern`, with a message naming the
construct. A `root` that does not exist is `not_found`.

## What a walk never enters

Twelve directory names are skipped during descent, including `.git`,
`node_modules`, `__pycache__`, and `.venv`. Skipping applies to descent only, so
naming one of them as the `root` searches it. An entry the process cannot read
is skipped and the walk continues.

The portable peer streams file contents when the host supports it. A guarded
host may provide atomic file reads but refuse streaming handles. If a stream
fails before delivering any bytes, search tries that same filesystem's atomic
read. A stream that fails after delivering bytes is discarded without a second
read, so two versions of a changing file cannot be combined into one result.
