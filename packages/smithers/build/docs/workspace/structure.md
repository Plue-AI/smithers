---
title: "Workspace structure"
description: "Discovery, PACKAGE.ts placement, package boundaries, lazy evaluation, default-target synthesis, and the directories that stay host state."
---

Examples importing `buildAndCheckPackage` use the [local helper defined here](../reference/targets/standard-package.md). Create that file in your repository before using those examples.

A smithers build workspace is a directory tree containing `PACKAGE.ts` files. The
workspace root is whatever `--workspace` points at, and it defaults to the
process working directory.

## Discovery

`Workspace.make` lists the workspace before it evaluates anything.

1. It runs `git ls-files -z --cached --others --exclude-standard` in the
   workspace root. This returns tracked and untracked files that git does not
   ignore.
2. If git could not be run at all, or the directory is not a git worktree, it
   falls back to a recursive walk that honors every `.gitignore` from the
   workspace root down.
3. Either way it drops empty entries, anything under a `node_modules` segment,
   the resolved cache directory, and the fixed `.flows/store` subtree, then
   sorts by UTF-16 code unit.

The listing is the workspace's view of itself. `PACKAGE.ts` files are the entries
equal to `PACKAGE.ts` or ending in `/PACKAGE.ts`.

Host state is dropped unconditionally, even when git lists it. Replayable cache,
scratch, and store content must never feed input discovery or a content digest.

### Only two git failures fall back

The fallback answers exactly the two cases where git had nothing to say about
the directory in the first place: git is not installed or not executable, and
the directory is not inside a worktree. A walk of the tree is a complete answer
to both.

Every other failure is reported: a repository this process cannot read, an
object-store corruption, a listing too large for the 64 MiB subprocess buffer, a
git that was killed. Falling back on those would hide a real fault behind a
listing that looks fine and is missing files, and a workspace missing files
plans and caches as though those files had been deleted.

### Every git path is validated

git reports paths relative to the repository root, and `-z` output is never
quoted, so a path that is absolute, rooted, traversing, empty, or carrying a NUL
or a backslash is not something git found in this workspace. One such entry
fails the whole listing rather than being filtered out of it: a listing that
framed one entry wrong is not a listing to trust the rest of. The same rule
applies to `git diff --name-only` output, which reaches a digest and a patch
argument.

### The walk stays inside the workspace

Fallback discovery uses the same walk glob expansion uses, with the package
boundary removed so it sees every `PACKAGE.ts`. Both therefore agree on which
`.gitignore` files apply, which symbolic links name workspace content, and which
directories are confined to the canonical root. See
[Inputs](../concepts/inputs.md).

## PACKAGE.ts placement

A `PACKAGE.ts` file defines a package. Its package path is its directory relative
to the workspace root; the root `PACKAGE.ts` defines the package with the empty
path, addressed as `//`.

```text
PACKAGE.ts                     -> //
packages/greeter/PACKAGE.ts       -> //packages/greeter
packages/greeter/test/PACKAGE.ts  -> //packages/greeter/test
```

There is no `subpackages` target and no visibility system. Nesting a `PACKAGE.ts`
inside another package's directory simply creates a second package.

## Lazy evaluation

The workspace imports only the `PACKAGE.ts` modules a command needs.

- An exact label loads the one `PACKAGE.ts` for its package.
- A recursive pattern loads every `PACKAGE.ts` in the selected subtree.
- A direct import inside a `PACKAGE.ts` pulls its dependency's module in through
  the normal ESM module graph.

Imports are cached by the file a module is, not by the name it was reached
under: the canonical path plus the device, inode, size, and modification time.
Within one command the stamp does not move, so a module evaluates at most once
and the target values it exports keep one identity, which is what the planner
uses to match a dependency to its label. Across commands in one process, a
`PACKAGE.ts` that was edited is re-evaluated, and two workspaces that happen to
share a path spelling never share a module.

Besides its `Package` map, a `PACKAGE.ts` may export a `PackageDefaults`
declaration and one `Smithers.Nix.Environment`. The environment
applies to the exporting package and every package below it; the root's is the
workspace's, and a package that exports its own overrides it for that package
alone. Two environment exports in one `PACKAGE.ts` fail the load. See
[Environments](../concepts/environments.md). Workspace configuration belongs in
`.smithers/WORKSPACE.ts` or the root `WORKSPACE.ts` fallback.

Three guards apply. A `PACKAGE.ts` must resolve, inside the canonical workspace
root, to a regular file; a link out of the workspace is refused rather than
imported, because evaluating a `PACKAGE.ts` runs it. Loading a `PACKAGE.ts` that
discovery did not list fails with `PACKAGE.ts is not discoverable`. Exporting one
target value under two labels fails with
`one target value is exported under both <a> and <b>`.

Admitting a `PACKAGE.ts` is still a trust decision, not a sandbox: it is
executable TypeScript that can read any file the user can read and spawn any
process. A workspace you would not run `pnpm install` in is a workspace you must
not point this CLI at. What the confinement targets guarantee is narrower and
still worth having: the code that runs is code the workspace contains.

## Package boundaries

A package's boundary matters in three places.

- **Declared input resolution.** A path or pattern resolves against the package
  directory, unless it starts with `//`, which resolves from the workspace root.
  A value that escapes the workspace is refused. See
  [Inputs](../concepts/inputs.md).
- **Labels.** A target's label is its package path plus its `Package.targets` key.
- **Tool working directory.** Every tool-running target takes a `cwd` attribute
  that names the workspace-relative directory the tool starts in, defaulting to
  the workspace root. That attribute is separate from the package path: a
  package-level `PACKAGE.ts` passes its own directory explicitly.

## Default-target synthesis

A directory without its own `PACKAGE.ts` can still produce targets. The root
`PACKAGE.ts` exports a `PackageDefaults` declaration, and the workspace applies it to
every matching directory.

```ts
import { buildAndCheckPackage } from "./package-targets.ts"
// PACKAGE.ts
import { Smithers } from "@smthrs/targets"

export const packageDefaults = Smithers.PackageDefaults({
  directories: "packages/*",
  macro: buildAndCheckPackage
})

export const Package = Smithers.Package({ targets: {} })
```

A directory is eligible when all three hold:

- it contains the `marker` file,
- it does not contain the `unless` file, which defaults to `PACKAGE.ts`,
- it matches the declaration's `directories` glob, resolved against the package
  that declared it.

The first eligible declaration wins. Its macro receives `{ cwd: <directory>, ...attrs }`,
so a synthesized package runs its tools inside itself, and declared `attrs` still
override `cwd`. Every target in the returned object is registered under a
path-derived label, with names sorted so synthesis is deterministic. A macro that
returns no targets fails with `default target synthesized no targets for //<dir>`.

The root `PACKAGE.ts` is always loaded before any synthesis decision, so
workspace-level declarations are in scope. See
[Default targets](../extending/default-rules.md).

## Host state

Two directories are never part of the workspace as far as discovery, globs, and
digests are concerned.

| Path                                              | What it holds                                                                                             | Configurable                                                       |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| The resolved cache directory, `.flows` by default | The CLI result cache under `<cacheDirectory>/cache`, and target scratch such as the generated knip config | Yes, through `Workspace` in a `WORKSPACE.ts` file or `--cache-dir` |
| `.flows/store/<manager>`                          | Package-manager store populated by fetch                                                                  | No                                                                 |

The store stays fixed because fetch declares it as a `TreeArtifact` boundary, and
a declared boundary is key material that must mean the same thing on every
machine.

## Next

- [Writing build files](writing-build-files.md)
- [Configuration](configuration.md)
- [Labels](../concepts/labels.md)
