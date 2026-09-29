---
title: "Inputs"
description: "The file(), glob(), and gitDiff() input declarations: how each resolves against a package, when the planner digests it, and what revalidation catches."
---

An input is a declaration of content a target depends on. Declaring it is pure;
measuring it happens later.

## The three constructors

```ts
import { Smithers } from "@smthrs/targets"

const sources = Smithers.glob("src/**/*.ts")
const excluded = Smithers.glob("src/**/*.ts", { exclude: ["src/**/*.gen.ts"] })
const config = Smithers.file("vitest.config.ts")
const rootConfig = Smithers.file("//eslint.jsdoc.js")
const changes = Smithers.gitDiff("origin/main")
```

Each returns a plain tagged object.

| Constructor                  | Value                                |
| ---------------------------- | ------------------------------------ |
| `glob(pattern, { exclude })` | `{ _tag: "Glob", pattern, exclude }` |
| `file(path)`                 | `{ _tag: "File", path }`             |
| `gitDiff(base)`              | `{ _tag: "GitDiff", base }`          |

`Input.isDeclared(value)` tests for one of the three tags. The union is
`Input.Declared`.

## No I/O at evaluation

The constructors read nothing. A target call collects the declared values it finds
in its attrs, and a target may add more through its `inputs(attrs)` function. That
is the whole of input declaration.

The planner expands and digests them during discovery, once per target, in
`Workspace.expandInputs`. The result is an `ExpandedInput` per declaration:

```ts
interface ExpandedInput {
  readonly declaration: Input.Declared
  readonly files: ReadonlyArray<{ path: string; digest: string | undefined }>
  readonly digest: string
}
```

`digest` is the sha256 of the JSON of the file list. That digest is what reaches
the target's key material. The pattern text and the path do not.

## Path resolution

A declared path or pattern resolves against the package directory of the target
that declared it. A value starting with `//` resolves from the workspace root
instead.

```ts
// In packages/greeter/PACKAGE.ts
file("tsconfig.json") // packages/greeter/tsconfig.json
file("//eslint.jsdoc.js") // eslint.jsdoc.js
glob("src/**/*.ts") // packages/greeter/src/**/*.ts
```

The result is a normalized workspace-relative posix path. A value that escapes
the workspace throws `declared input escapes the workspace: <value>`.

The package directory used here is the target's `PACKAGE.ts` directory, which is
not the same thing as the target's `cwd` attribute. `cwd` is where the tool
process starts. Both are usually the same directory, and `buildAndCheckPackage`
passes the package directory as `cwd`, but they are resolved independently.

## Glob expansion

Expansion walks the real filesystem, starting at the pattern's static prefix, the
longest leading run of segments containing no glob metacharacter.

The walk:

- honors every `.gitignore` from the workspace root down to the walked
  directory,
- skips `.git` and `node_modules` entries,
- stops at subpackage boundaries: it never descends into a subdirectory holding
  a `PACKAGE.ts` file,
- skips the resolved cache directory and the fixed `.flows/store` subtree
  unconditionally, ignored or not,
- matches the result against the pattern with `minimatch` and `dot: true`,
- removes anything matching an `exclude` pattern,
- sorts.

### Globs are package scoped

Like Bazel, a glob only sees its own package. A recursive pattern declared in
`packages/greeter` matches `packages/greeter/src/index.ts`, but stops before
`packages/greeter/examples/index.ts` once `packages/greeter/examples/PACKAGE.ts` exists.
Those files belong to the subpackage's own targets; a target that wants them
depends on that package's label instead.

The `PACKAGE.ts` name is compared exactly, so a source file named `build.ts` is
never mistaken for a package marker on a case-insensitive filesystem.

The target applies to every glob in every target. It also applies before the
pattern's static-prefix directory: starting a walk at
`packages/greeter/examples/src` does not bypass a `packages/greeter/examples/PACKAGE.ts`
boundary. A `//`-rooted glob resolves its pattern from the workspace root but
remains scoped to the declaring package: `//packages/greeter/src/**/*.ts` is legal
from `packages/greeter`, while `//*.ts` is not. Depend on another package's label
instead. This deliberately follows Bazel package boundaries; only `file()`
keeps the smithers build extension that permits `//`-anchored cross-package file
references.

Repeated expansion of an unchanged tree is therefore deterministic. A pattern
whose static prefix does not exist, is not a real directory, is unreachable
through real directories, contains a `node_modules` segment, or lands inside
host state expands to an empty list.

### The walk stays inside the workspace

Every directory from the workspace root down to the static prefix, and every
directory below it, must be a real directory whose resolved path is still inside
the canonical workspace root.

- A symbolic link to a directory is never descended. It can neither move the
  walk outside the workspace nor make it loop.
- A directory that resolves outside the root, or that is replaced while it is
  being read, fails the expansion. It does not contribute files under names that
  mean nothing in this workspace.
- A `.gitignore` that cannot be read fails the expansion. It is not treated as
  an empty file, because a matcher that ignores nothing pulls generated output
  into key material.

## File digests

`digestFile` returns the sha256 of the file's content, or `undefined` when the
file does not exist. A declared-but-missing file still contributes deterministic
key material: the file list records `{path, digest: undefined}`.

Only a missing file is missing. A permission error, an unreadable parent
directory, and every other failure is reported rather than digested as absence,
so a workspace never plans as though a file it could not read had been deleted.

Content streams through a bounded buffer, so a large input costs a fixed amount
of memory rather than its own size. The read happens through a descriptor that
is checked to be the same regular file the path named, and checked again after
the last byte: a file replaced or rewritten mid-digest fails rather than
producing a digest of a file that never existed.

A declared input is a regular file. A FIFO, a socket, a device, and a directory
are refused; without that, a FIFO nobody writes to would block planning forever.

### Symbolic links

A symbolic link is followed only when its whole resolution stays inside the
canonical workspace root and ends at a regular file.

- A `file()` declaration naming a link that leaves the workspace fails. The
  declaration named it, so the refusal is explicit.
- A link inside a glob's walk that leaves the workspace is skipped. A walk
  surveys a tree; it does not assert anything about one named path.
- A link that stays inside is content either way, and both paths digest it
  identically, so a glob and a `file()` never disagree about a target's inputs.

A `PACKAGE.ts` that is a link is a package marker exactly when the workspace index
would import it: when it resolves, inside the workspace, to a regular file. A
link can therefore neither invent a package boundary nor erase one.

A `file()` declaration that resolves inside host state expands to an empty file
list, so cache content can never reach a digest.

## Git diffs

A `gitDiff(base)` declaration expands to the range `<base>...HEAD`.

1. `git diff --name-only -z <base>...HEAD --` lists the changed paths.
2. Paths inside host state are dropped and the rest are sorted. Each is recorded
   with `digest: undefined`; the file list names what changed, not its content.
3. `git diff --binary <base>...HEAD -- <paths>` produces the patch text, and the
   declaration's digest is the sha256 of that text.

An empty change set digests the empty string.

This makes a diff first-class key material: a target re-keys exactly when the
patch content changes. `LlmLint` is the target built on it.

## Sharing declarations

Declare once and reuse. Each target digests the declaration independently.

```ts
// packages/greeter/PACKAGE.ts
import { Smithers as S } from "@smthrs/targets"

const sources = S.glob("src/**/*.ts")
const sourceFiles = S.Filegroup({ srcs: [sources] })
const lintFiles = S.Filegroup({ srcs: [sources] })

export const Package = S.Package({ targets: { sourceFiles, lintFiles } })
```

Export a declaration for other `PACKAGE.ts` files to import:

```ts
// PACKAGE.ts
import { Smithers as S } from "@smthrs/targets"

export const rootJSDocConfig = S.file("//eslint.jsdoc.js")
export const Package = S.Package({ targets: {} })
```

```ts
// packages/greeter/PACKAGE.ts
import { Smithers as S } from "@smthrs/targets"
import { rootJSDocConfig } from "../../PACKAGE.ts"

const lint = S.EsLint({
  sources: [S.glob("src/**/*.ts")],
  deps: [],
  configs: [S.file("eslint.config.js"), rootJSDocConfig],
  maxWarnings: 0,
  fix: false,
  cwd: "packages/greeter"
})

export const Package = S.Package({ targets: { lint } })
```

An exported `file()` value is not a target and gets no label.

## Inputs are not outputs

Declaring an input never tells a tool what to read. It tells the planner what to
digest. The tool receives whatever argv the target's implementation builds.

Some targets do both. `EsLint` passes its glob patterns through to ESLint as
arguments, because ESLint expands globs itself. `BiomeCheck` passes each glob's
static directory prefix, because Biome walks paths rather than expanding
patterns. `Vitest` passes its config path but lets Vitest find the test files.
The declared inputs still control the key in all three cases.

## Measurement is revalidated, not assumed

The planner measures a target's declared inputs once and derives the target's
content key from that measurement. The executor takes the measurement again
before it acts on the key: before a cache lookup and before execution, again
after a cached entry's outputs are measured, and again after a successful
execution. Paths and per-file digests are compared, not only how many files
matched.

A declared input that changed, or that can no longer be read, fails the target.
Dependents are blocked, nothing is published to the cache, and every other target
still runs. The alternative, trusting the plan's measurement, would answer a hit
under a key that no longer describes the tree, or publish a result under one.

See [Caching](../workspace/caching.md#inputs-are-revalidated-not-assumed) for
the window this closes and the one syscall-level race that remains.

## Next

- [Dependencies](dependencies.md)
- [Caching](../workspace/caching.md)
- [Writing target definitions](../extending/writing-targets.md)
