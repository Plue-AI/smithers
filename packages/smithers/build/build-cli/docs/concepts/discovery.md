---
title: "Workspace discovery"
description: "How the CLI finds a workspace, which declaration files it admits, what the walk prunes and refuses, and how a pattern turns into a set of targets."
sidebar:
  order: 2
---

Every workspace command starts by building a target index. The index
is the only thing a verb resolves labels against, so what discovery admits is
what the CLI can run.

## Finding the workspace

Discovery resolves `--workspace` to an absolute path and walks up looking for
a workspace declaration. Two spellings are accepted, in this order:

1. `.smithers/WORKSPACE.ts`
2. `WORKSPACE.ts` at the same directory

The nearest ancestor holding either one is the workspace root. A directory
with neither, and no ancestor with either, fails the command with
`not a workspace; create .smithers/WORKSPACE.ts`.

The loader first scans the workspace's static relative imports and checks for
conflicting runtime installations. It then evaluates the workspace declaration
before walking the package tree. The declaration names
the shared facts of the tree: the runtime, the package manager, the toolchains,
the sandbox mechanisms, the cache directory and its remote, the git hook
bindings, the opaque child repositories, and the `discovery.prune` paths.
Three of those, the cache directory, the child repositories, and the prune
paths, are discovery boundaries, which is why they cannot be read from the
same walk they bound.

## Finding the packages

The walk then lists every `PACKAGE.ts` in the tree. It is ignore-blind: it
never consults git, so gitignore status is irrelevant and a generated
`PACKAGE.ts` participates exactly like a committed one.

The walk prunes these boundaries and never descends into them:

- `.git`
- `node_modules`
- `dist`, the distribution output directory at any depth
- any directory whose own listing holds `.git` or `.jj`, that is, a nested
  checkout, a linked worktree, or a jj workspace
- any directory whose own listing holds `CACHEDIR.TAG`, the Cache Directory
  Tagging convention Cargo writes into `target/`
- the resolved cache directory
- the fixed `.flows/store` subtree
- every workspace-relative path in the declaration's `discovery.prune`

Because the walk is ignore-blind, a gitignored cache with no `CACHEDIR.TAG`
costs its full size on every command. Name it in `discovery.prune`:

```ts
export const Workspace = S.Workspace("app", {
  // ...
  discovery: { prune: [".pnpm-store", ".artifacts", "tmp"] }
})
```

A prune path must be relative and stay inside the workspace. Each walked
directory costs one confined resolve and one confined listing, about five
filesystem calls, and every child is classified from that listing without
further probes.

Distribution output can contain copied fixture declarations and can be replaced
by a concurrent release build. It is never a declaration source, so discovery
prunes it before probing or reading its contents. Other generated declarations
remain discoverable regardless of gitignore status.

No path inside the cache directory is ever listed, so cache contents cannot
feed input discovery or a digest, and the directory's name never enters a
cache key.

Three refusals guard the walk:

- A symlinked declaration file is rejected outright.
- The name must match exactly. The walk compares against the directory
  listing, so `Package.ts` is not found even where the filesystem would open
  it.
- A nested workspace that the root declaration did not declare fails with
  `nested_workspace_undeclared`, naming the `S.LocalRepository` entry to add.

The walk holds hard ceilings, and a workspace past one fails rather than
silently truncating: 100,000 directories, 256 levels of depth, and 1,000,000
entries.

## From a pattern to a set of targets

Each `PACKAGE.ts` exports exactly one `S.Package({ targets })`, and each key of
`targets` becomes a label. The label grammar is Bazel's, in five spellings:

| Spelling         | Selects                                                     |
| ---------------- | ----------------------------------------------------------- |
| `:name`          | That target in the package holding the working directory.   |
| `//pkg`          | The default target of `pkg`.                                |
| `//pkg:name`     | Exactly that target.                                        |
| `//pkg/...`      | Every target under the subtree.                             |
| `//pkg/...:name` | The target named `name` in every package under the subtree. |

The last spelling is the Bazel-natural form of a matrix each package opts into
one at a time: packages declare a target under a shared key and the pattern
names that key, instead of a central file listing which packages are in.

`//...` is the whole workspace. A `:name` label needs a working directory
inside the workspace, and a directory outside one is refused with
`current directory is outside workspace`. Absolute labels and patterns never
need one.

The pattern never narrows what is loaded. Every admitted `PACKAGE.ts` is
evaluated and validated first, and the index is built from the whole graph;
the pattern then selects rows out of that finished index. A declaration that
fails to evaluate or to validate therefore refuses the command even when the
pattern names one target in an unrelated package, and the fault is reported
against the file that broke, not against the label you typed.

A direct import between declaration modules is an ordinary ESM edge. It
declares a relationship, not a loading order, and it creates a dependency edge
between the importing and imported targets.

## Repository targets

A `Repo.Target` names a target in a child workspace declared as
`S.LocalRepository(path)`. Resolving one asks the child CLI for its inert plan
rather than reading across the boundary.

When the child cannot answer, because the label does not exist there or the
child refuses, the row carries a `refusal`. `query` and `graph` both render it
for a person and carry it in the envelope, so an unresolvable child is visible
rather than silently absent.

A child repository never inherits the parent's cache credentials. Every child
spawn drops `SMITHERS_CACHE_URL`, `SMITHERS_CACHE_TOKEN`, and each variable the
parent workspace names for its remote-cache tokens, so a child that uses a
remote cache needs a credential under a name the parent does not declare.

## Where this leaves you

- What a verb can run is exactly what the index holds. If `query '//...'` does
  not list a target, no verb will find it either, and the fault is in
  discovery, not in the verb.
- For the rules a `PACKAGE.ts` is built from, see
  [`@smthrs/targets`](https://github.com/smithersai/smithers/tree/main/packages/smithers/build/targets) and the
  [build-file guide](/pkg/smithers-build/workspace/writing-build-files).
- For what happens once targets are selected, see
  [Target execution](./execution.md).
