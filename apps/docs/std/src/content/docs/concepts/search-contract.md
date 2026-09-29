---
title: "The search contract"
description: "Smithers Ripgrep Subset v1: what grep and glob support, how patterns and globs are read relative to the search root, and how two peer implementations are held to one answer."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/std/docs/concepts/search-contract.md"
---

`grep` and `glob` are two projections of one contract, Smithers Ripgrep Subset
v1. The contract exists because the package ships two implementations of it, and
a caller must not be able to tell which one answered.

- `PortableSearch` walks the injected `FileSystem` in process. It needs no
  external binary, so it is the peer a browser host and a test host use.
- `NativeSearch` drives the `rg` executable through the permission-aware
  spawner.

Both are bound to the `Search` service, and `Grep.run` and `Glob.run` call
whichever one the host provided. Neither module knows which peer is in play.

## What v1 supports

`grep` corresponds to a bounded subset of ripgrep's flags:

| Input field                                | Ripgrep flag                              |
| ------------------------------------------ | ----------------------------------------- |
| `fixedStrings`                             | `-F`                                      |
| `ignoreCase`                               | `-i`                                      |
| `smartCase`                                | `-S`                                      |
| `globs`                                    | ordered `-g` include and exclude patterns |
| `beforeContext`, `afterContext`, `context` | `-B`, `-A`, `-C`                          |
| `maxCount`                                 | `--max-count`, per file                   |
| `filesWithMatches`                         | `--files-with-matches`                    |
| `hidden`                                   | `--hidden`                                |
| `noIgnore`                                 | `--no-ignore`                             |
| `limit`                                    | the global result budget, capped at 200   |

`glob` corresponds to `rg --files -g <pattern>`.

`noIgnore` is an optional boolean defaulting to `false`. Both flows apply
`.gitignore` rules from the search root and nested directories, even outside
Git repositories. Set `noIgnore: true` to include ignored paths. Parent and
global ignore rules, `.ignore`, `.rgignore`, and `.git/info/exclude` do not
participate. Hidden-file and fixed directory skips still apply.

File-type registries are not supported, so there is no `types` field to pass.
`-i` and `-S` together, and `-C` combined with `-A` or `-B`, are `invalid_input`,
because ripgrep's own precedence for those combinations is not a thing two peers
should each guess at.

## The pattern grammar

Smithers Ripgrep ASCII v1 is deliberately the intersection of Rust's regex crate
and JavaScript's `RegExp`, so both peers compile the same pattern to the same
meaning. A pattern is rejected with `invalid_pattern` when it:

- contains anything outside printable ASCII, or exceeds 4,096 bytes;
- opens a special group with `(?`, which covers lookaround and named groups;
- escapes an alphanumeric, which covers backreferences, shorthand classes such
  as `\d`, and encoded escapes;
- nests a character class, leaves one empty, or uses a class set operation
  (`&&`, `--`, `~~`);
- names a counted repetition above 1,000;
- exceeds 128 nested groups or 8,192 compiled states after repetition expansion;
- fails to compile as a JavaScript regular expression.

`fixedStrings: true` skips the grammar entirely except for the ASCII and length
checks, because a literal is escaped rather than compiled.

Inside the shared compiler, `.` matches any character except a newline and `$`
anchors at the end of the whole input, which is what makes a line-oriented
search behave the same in both peers.

Portable grep evaluates this grammar with a Thompson state machine. Matching
work is linear in line length times the bounded state count, including nested
quantifiers and ambiguous alternatives. It yields every 4,096 state visits so
host timers and Effect interruption can run during a long match. JavaScript
regular expressions are used only for individual character predicates.

The portable scan reads files in chunks and counts overflow without retaining
all hits. It keeps the first `limit` hits and their context, plus one boundary
hit to preserve context ownership at truncation. Symbol source is loaded only
for files with returned hits and released after annotating each file. Memory
still includes the current line and, with `symbols: true`, one retained hit's
source file; `limit` is a result budget, not a byte limit on that source.

## Globs are relative to the root, never absolute

This is the rule that most often surprises a caller, and getting it wrong is
silent: an absolute pattern matches nothing at all, forever.

A candidate is matched by the path it has **relative to the search root**. Three
consequences, and both peers implement all three identically:

- A pattern with no `/` matches the **basename** at any depth. `*.py` finds
  every Python file in the subtree.
- A pattern containing `/` is matched against the root-relative path and is
  anchored at the root. `tests/*.py` matches `<root>/tests/a.py` and not
  `<root>/src/tests/a.py`.
- A leading `/` is that same anchor spelled explicitly, not a filesystem
  absolute path. `/a.py` matches only `<root>/a.py`, where bare `a.py` would
  match any `a.py` in the subtree. A leading `./` means the same anchor.

`**` crosses directory boundaries; `*` and `?` stay inside one segment; `?`
consumes one UTF-8 byte. Brace alternatives expand, up to 256 patterns. Glob
escapes and character classes are not supported. Trailing spaces are not part of
a pattern, because `rg` reads `-g` by gitignore's rules and drops them, and a
pattern left blank by that is rejected rather than read as no filter at all.

Ordered include and exclude globs work like ripgrep's: with no positive glob
everything is included, and the last pattern to match a candidate decides, with
`!` marking an exclusion.

So `/home/repo/tests/**` passed against a root of `/home/repo` is read as the
root-relative path `home/repo/tests/**`, which nothing under that root can
match. That answer is never silent: a positive glob no file under the root could
match is explained through `notice`, naming the reason (a missing directory, a
skipped directory, a hidden path with `hidden` left false) and, where it applies,
the root-relative pattern the caller probably meant.

A `root` that names one file is that file. It is reported whatever the pattern
says, because `rg` searches a path given on its command line without consulting
`-g`.

## What a walk skips

Repository internals, dependency trees, caches, and worktrees are never
descended into. This includes `.artifacts`, `.backend-go-modcache`,
`.pnpm-store`, `.worktrees`, and `worktrees`. Skipping applies to descent and
never to what the caller named, so naming one of them as the `root` still
searches it.

A walk also skips what it cannot read: a dangling symlink, a link cycle, a
directory the process may not list. One unreadable entry never fails the call,
which is what `rg --no-messages` does with the same tree. Only the root the
caller named can fail the walk.

Files with a NUL byte are skipped and counted in `skippedBinary`. Invalid UTF-8
in a searched file is replacement-decoded rather than refused.

## Two properties that belong to the contract, not to a peer

Both are computed in shared code, so neither peer can drift on them:

- **Each hit carries its enclosing definition.** A line number is not a read
  window. When a file's shape says plainly which definition a hit sits in, the
  match carries `symbol` with that definition's `kind`, `name`, `startLine`, and
  `endLine`, so the follow-up `read` is a fact rather than a guess. The
  heuristic answers nothing rather than guessing when the shape is not plain.
- **A metacharacter pattern that finds nothing is retried literally.** If a
  pattern containing regex metacharacters produces no matches and no files, the
  search runs again with `fixedStrings: true`. When that finds something, the
  result carries `retriedAsLiteral: true` and says so in `notice`. A search that
  found nothing because the caller wrote a literal containing `(` is the most
  common way a search lies.

## Proving a third peer

`Search` is a public seam: a host may bind its own implementation. Two modules
exist so that a new peer can be held to the same contract as the shipped ones.

`SearchContract` exports the matcher both peers build on, so a third peer reuses
the meaning of a pattern instead of reimplementing it:

```ts
import * as SearchContract from "@smthrs/std/SearchContract"

SearchContract.validatePattern("foo.*bar", false) // undefined, or a StdError
SearchContract.validateGlob("src/**/*.ts") // undefined, or a StdError
SearchContract.canonicalGlob("./src/**/*.ts ") // "/src/**/*.ts"
SearchContract.matchesGlob("*.ts", "src/widen.ts", "widen.ts") // true
SearchContract.includedByGlobs(["**/*.ts", "!**/*.d.ts"], "src/a.d.ts", "a.d.ts") // false
```

`SearchConformance` is the differential kit: it generates a tree and a batch of
calls from a seed, runs them through two implementations, and reports every
answer that differs. It knows nothing about which peer is right; a divergence is
the finding. It found two real drifts between the peers shipped here, one in how
`maxCount` interacts with context lines and one in how `ignoreCase` and
`smartCase` combine.

The walkthrough is
[Implement your own search peer](/guides/implement-a-search-peer/).
