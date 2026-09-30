---
title: "Match files with a glob pattern"
description: "The glob grammar AtomicFileSystem implements, how exclusions prune the walk, the patterns it refuses outright, and the three answers where it deliberately differs from Node's globber."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-node/docs/guides/match-files-with-glob.md"
---

Use this when a program needs to select files under the workspace. `glob` is
one of the fifteen operations the atomic adapter implements, so it costs one
helper process for the whole tree rather than one per entry.

```ts
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"

const sources = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.glob("**/*.ts", {
    root: "/absolute/workspace",
    exclude: ["**/node_modules/**", "**/*.test.ts"]
  })
})
```

The helper cannot call Node's globber, so it implements the grammar itself.
That has three consequences you need to know: what the grammar supports, what
it refuses, and where it deliberately answers differently.

## The grammar

| Construct      | Meaning                                         |
| -------------- | ----------------------------------------------- |
| `*`            | any run of characters within one segment        |
| `?`            | any one character within one segment            |
| `[abc]`        | a character class, with `!` or `^` for negation |
| `**`           | zero or more whole segments                     |
| `{a,b}`        | alternation                                     |
| a trailing `/` | directory-only matching                         |

The dotfile rule keeps a wildcard out of a name beginning with `.`, while a
segment that spells the dot matches one: `*` misses `.git`, and `.*` or `[.]*`
finds it.

A one-member class is the literal it spells, so `[.]` is a `.` path segment.
The globber drops a spelled `.` before it parses and collapses `[.]` only
afterwards, so this one survives, and as the last segment it names its own
anchor. A `**` immediately before it addresses nothing, so `**/[.]` names
nothing while `**/deep/[.]` names the directory. Anywhere but last, and in an
exclusion, a `.` segment names an entry no directory holds.

A trailing `**` spans zero segments, so it also names its own anchor: a
directory always, and a non-directory only when every segment before it is
literal. `top.txt/**` names the file; `t*.txt/**` names nothing. Adjacent `**`
segments act as one: `deep/**/**` includes `deep`, `.hidden/**/**` includes
`.hidden`, and `**/**/**` includes the root. Repeating `**` still excludes
hidden descendants unless another segment explicitly names their leading dot.

Matching is segment-wise and linear in the candidate's length, never a compiled
regular expression, because a pattern of repeated `*x` fragments costs a regex
engine exponential backtracking.

## Exclusions prune the walk

An exclusion is not a filter applied to the results. Excluding a directory
excludes everything below it, and nothing under an excluded directory is
listed, counted against the 100000-entry ceiling, or charged against the
response ceiling. An exclusion that names the root stops the walk before it
begins.

An absolute exclude is rewritten against the glob root, so it applies to the
same names the selecting pattern does.

The selecting pattern prunes the same walk. A directory is entered only when a
remaining pattern segment, or an open `**`, can still name something below it,
so `src/index.ts` or `*.ts` never reads the subtrees beside its match, and a
name the pattern does not select is never charged against the response
ceiling. Names in a directory the walk does read still count against the
100000-entry ceiling, because reading them was work. Literal segments are found
by reading their parent rather than by a direct lookup: matching is
case-sensitive on every host, and a lookup on a case-insensitive filesystem
would answer for a name the pattern did not spell.

## Patterns the adapter refuses

Five inputs fail as a typed `BadArgument` before filesystem walking. The byte
limit is checked before brace expansion, which stops at its alternative limit.
Each expanded alternative is checked for unsupported syntax before compilation,
so refused patterns cost no directory listing:

| Input                                             | Why                               |
| ------------------------------------------------- | --------------------------------- |
| a pattern longer than 4096 UTF-8 bytes            | a bound on what one call may cost |
| braces expanding past 64 alternatives             | brace expansion is multiplicative |
| extglob, such as `+(a\|b)`                        | not implemented                   |
| `[:` inside an open class, such as `[a[:digit:]]` | not implemented                   |
| brace bodies containing `..`, including `{1..3}`  | not implemented                   |

The last three checks conservatively refuse unsupported syntax, including
unrecognized class names and non-range brace sets containing `..`. Treating an
unsupported construct as literal text could make an exclusion return the paths
it was meant to remove. The refusal covers the
exclude list as well as the pattern, and it reads a character class as a class,
so `[!(]*` is an ordinary negated class and not an extglob.

Backslashes follow Node's POSIX rules: an absolute selector and every exclude
drop them while leaving following wildcard magic active, and a relative
selector containing one matches nothing.

## Three answers pinned against Node

Every other row of the grammar is asserted against `@effect/platform-node`'s
own globber in a parity suite. Three answers are pinned instead, because the
native globber gives no single answer to copy.

**Case is always sensitive.** Node's globber passes
`nocase: isMacOS || isWindows` with `nocaseMagicOnly: true`. On a
case-insensitive host that means a magic segment folds case (`*.TXT` finds
`upper.txt`), a literal segment the matcher decides is compared exactly
(`**/MID.txt` misses `mid.txt`), and a literal segment Node addresses directly
comes back with the pattern's own spelling (`TOP.TXT` returns `TOP.TXT`) even
though the directory does not hold that spelling. This adapter returns only
names its walk found, and keeps one rule on every host. A pattern whose meaning
depends on which machine reads it is worse than one that means the same
everywhere, and worst of all in an exclusion.

**A globstar exclusion leaves the directory entry.** A trailing `**` in an
exclusion removes what is under a directory and leaves the directory entry
itself. Node's answer here depends on the shape of the selecting pattern:
`**/*` with `exclude: ["nested/**"]` keeps `nested`, and `**` with the same
exclusion drops it. This adapter gives one answer for every selector.
Consequently the directory-only `**/` names directories below its own anchor
but not that anchor: with `exclude: ["**/"]`, `**` keeps the root and its files
while pruning every directory. Node empties the answer instead.

**A dotted segment after a globstar matches dotfiles, but a globstar never
spans a hidden directory.** Node 22 matched nothing for `**/.hidden`; Node 24
and later match the dotfiles. This adapter matches the dotfiles on every
version. Node 24 and later also walk into a hidden directory when the segment
after `**` matches it, so with `.hidden/.secret` and `.hidden/.nested/.wanted`
present, `**/.*` returns `.hidden`, `.hidden/.secret`, `.hidden/.nested` and
`.hidden/.nested/.wanted`, and `**/.*/**` returns `.hidden` and
`.hidden/.nested`. This adapter returns `.hidden` alone for both, because only a
segment that names a hidden directory may enter it: `.hidden/.*` returns
`.hidden/.nested` and `.hidden/.secret`.

## Keep the cost down

One `glob` is one fork, so prefer a single pattern with an `exclude` list to
several calls you merge yourself. Prune with exclusions rather than filtering
results: an excluded subtree is never walked at all, which is the difference
between a cheap call and one that reads a `node_modules` tree before discarding
it. A narrow selector is cheap on its own: `src/**/*.ts` enters `src` and
nothing beside it.
