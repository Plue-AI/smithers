---
title: "Installation"
description: "What the smithers-build binary requires: Node 26.4, a workspace dependency, the tsx loader it boots, and the TypeScript syntax declaration modules may use."
sidebar:
  order: 1
---

For the full picture of the three packages, see the
[smithers build install page](/pkg/smithers-build/getting-started/install).

## Requirements

- Node.js 26.4.0 or later, which is what the package declares in `engines`.
- An npm-compatible package manager. The workspace declaration names the one
  targets run their tools through, pnpm or Bun.
- Git, for the parts of a run that read the tree: write-set confinement, the
  gitignored census, `owners --diff`, and `Git.Commit` targets. Declaration
  discovery itself never asks git anything.

## Add the dependency

Declare the CLI and the authoring package as devDependencies of the workspace
root. Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/docs/installation.md#install-the-cli).

```json
{
  "devDependencies": {
    "@smthrs/build-cli": "1.0.0-rc.1",
    "@smthrs/targets": "1.0.0-rc.1"
  }
}
```

After the install, the `smithers-build` bin is on `pnpm exec` at the workspace
root:

```bash
pnpm exec smithers-build --version
```

Declaration modules then import the authoring surface by bare specifier:

```ts
import { Smithers as S } from "@smthrs/targets"
```

## What the binary boots

The `bin` entry is `src/main.js`, and it runs before any TypeScript is loaded.
It does two things:

1. Registers the declaration loaders, including tsx's CommonJS loader. The
   current ESM loader still shares the CLI's runtime through resolve hooks.
   Before evaluation, a separate check refuses conflicting physical workspace
   installations instead of allowing the hooks to conceal them.
2. Imports `src/main.ts` through the programmatic `tsx` loader that ships as a
   CLI dependency, which is what lets the CLI's own modules and your
   `WORKSPACE.ts` and `PACKAGE.ts` files be TypeScript with no build step.

The public library entry points resolve to compiled ESM and CommonJS output.
The executable keeps a small JavaScript bootstrap because it must register the
TypeScript declaration loader before importing its command module.

## What declaration modules may contain

A declaration is an ordinary TypeScript ES module. The loader reports
`format: "module"` for every declaration, so a workspace whose nearest
`package.json` declares no `type` still evaluates its declarations as ES
modules.

Two constraints come from discovery rather than from the loader. A declaration
must be a real file, because a symlinked declaration is rejected outright, and
its name must be spelled exactly `WORKSPACE.ts` or `PACKAGE.ts`: the walk
compares against the directory listing, so `Package.ts` is not found even on a
case-insensitive filesystem.

The workspace and CLI must select the same physical `effect`, `@smthrs/targets`,
`@smthrs/plan`, `@smthrs/core`, and `@smthrs/flow` installations wherever these
packages are installed. Matching version strings alone are insufficient.
`declaration_dependency_mismatch` names the importing file and both package
locations. Install matching dependencies and invoke the workspace-local CLI.

The existing ESM bootstrap path still permits missing workspace dependencies.
CommonJS callers must supply their own dependencies through ordinary Node
resolution. No private Node CommonJS resolver is patched by build-cli.
For the checked boundary and evaluation lifetime, see
[Declaration loading](./concepts/declaration-loading.md).

## Programmatic use

A program that embeds the build imports the same modules the binary does:

```ts
import { makeCli } from "@smthrs/build-cli"
```

Every module is also importable by its own path, for example
`@smthrs/build-cli/Planner`. `@smthrs/build-cli/internal/*` is not public. See
[Embed the CLI in another program](./guides/embed-the-cli.md).

## Next

[Quickstart](./quickstart.md) declares a workspace and runs a target end to
end.
