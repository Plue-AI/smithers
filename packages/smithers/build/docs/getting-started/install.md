---
title: "Install"
description: "What smithers build requires, how the three packages reach a workspace, and how to ignore the cache directory before the first run."
sidebar:
  order: 1
---

smithers build is three packages: `@smthrs/build`, the install flow and the host
seams; [`@smthrs/targets`](https://github.com/smithersai/smithers/tree/main/packages/smithers/build/targets), the surface your declaration files
import; and [`@smthrs/build-cli`](https://github.com/smithersai/smithers/tree/main/packages/smithers/build/build-cli), which supplies the
`smithers-build` binary.

## Requirements

- Node.js 26.4.0 or newer, which is what the packages declare in `engines`.
- An npm-compatible package manager. Your workspace declaration names the one
  targets run their tools through: pnpm or Bun. The install flow
  has a live implementation only for pnpm, and a Bun declaration fails with a
  typed `unsupported` error.
- Git, for the parts of a run that read the tree. Discovery prefers
  `git ls-files`; outside a worktree it falls back to a `.gitignore` walker.

## Add the dependencies

Declare the CLI and the authoring package as devDependencies of your workspace
root. Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/apps/site/docs/installation.mdx).

```json
{
  "devDependencies": {
    "@smthrs/build-cli": "1.0.0-rc.1",
    "@smthrs/targets": "1.0.0-rc.1"
  }
}
```

Install once. The `smithers-build` bin is then on `pnpm exec` at the workspace
root:

```bash
pnpm exec smithers-build --version
```

Declaration files import the authoring surface by bare specifier:

```ts
import { Smithers as S } from "@smthrs/targets"
```

## Run the CLI

```bash
# From the workspace root.
pnpm exec smithers-build query //...
```

Or point the CLI at a workspace explicitly, from anywhere:

```bash
smithers-build query //... --workspace /path/to/workspace
```

`--workspace` defaults to the process working directory. The current directory
also decides which package a relative `:target` label resolves in. See
[Labels](../concepts/labels.md).

## Ignore the cache directory

smithers build keeps its result cache and target scratch files under a
workspace-relative directory. The workspace declaration names it:

```ts
// .smithers/WORKSPACE.ts
import { Smithers as S } from "@smthrs/targets"

const packageJson = S.file("//package.json")
const runtime = S.Runtime.Node({ version: ">=26.4.0" })
const packageManager = S.PackageManager.Pnpm({ version: "11.21.0", runtime })

export const Workspace = S.Workspace("demo", {
  repository: "git+https://example.invalid/demo.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime,
  packageManager,
  nodeModules: S.Npm.NodeModules({ packageJson })
})
```

Add that directory to your `.gitignore`. It is host state: discovery drops it,
globs refuse to descend into it, and its name never reaches a content key. See
[Configuration](../workspace/configuration.md).

The ordinary target verbs accept another configured directory through
`--cache-dir`. The dedicated `smithers-build install` verb requires `.flows`,
because its declared pnpm store boundary is fixed at `.flows/store/pnpm`.

## Next

- [First build](first-build.md)
- [Workspace structure](../workspace/structure.md)
