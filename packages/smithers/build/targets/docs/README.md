---
title: "@smthrs/targets"
description: "The declaration surface a smithers build workspace is written in: typed target rules that record what a build step reads, what it produces, and what it may reach, without running anything."
---

`@smthrs/targets` is the vocabulary a **smithers build** workspace is written
in. A `WORKSPACE.ts` file declares the toolchain once, each `PACKAGE.ts` file
declares that package's targets, and both import one namespace from this
package.

Every constructor here is pure. `Smithers.Vitest({ ... })` reads no file,
spawns no process, and runs no test. It validates the attrs, records the inputs
and dependencies the declaration named, and returns a declaration with planner
metadata attached. Running that declaration is the job of
[`@smthrs/build-cli`](https://github.com/smithersai/smithers/tree/main/packages/smithers/build/build-cli).

## The problem it solves

A `package.json` script is an opaque string. Nothing records which files it
read, so nothing can key it. Nothing records what it wrote, so nothing can
verify or cache it. Nothing records what it may reach, so nothing can confine
it. Every rule in this catalog turns those three facts into data a planner can
read:

- **Declared inputs.** `Smithers.file`, `Smithers.glob`, `Smithers.gitDiff`,
  and `Smithers.pnpmWorkspace` name what a target reads. Their content digests
  are the target's key, so an edit anywhere else stays a cache hit.
- **Declared outputs.** A target states the tree one execution produces. A tool
  that exits zero without producing a declared output fails the target instead
  of passing.
- **Declared permissions.** `Smithers.Secret("GITHUB_TOKEN")` names an
  environment variable, never a value, and `Smithers.HttpSecret` binds it to
  the exact origins allowed to receive it. `Smithers.SecretOrigin(origin)`
  gives the tool a loopback origin that forwards there with the value
  substituted. A sandbox policy rides the declaration rather than the command
  line.

Because the declaration is data rather than a script, the same plan runs the
same way on a laptop and in CI, and a label is all a command needs.

## Install

Install it alongside the binary that runs what it declares. Not on npm yet; see [Installation](/docs/installation/#use-the-libraries).

```json
{
  "devDependencies": {
    "@smthrs/build-cli": "1.0.0-rc.1",
    "@smthrs/targets": "1.0.0-rc.1"
  }
}
```

It ships dual ESM/CommonJS output, targets Node.js 26.4.0 or later, and takes
the exact Effect RC as a peer dependency.

## The shortest real example

Declare the toolchain once, in the workspace declaration at the repository
root:

```ts
// .smithers/WORKSPACE.ts
import { Smithers as S } from "@smthrs/targets"

const runtime = S.Runtime.Node({ version: ">=26.4.0" })

export const Workspace = S.Workspace("demo", {
  repository: "git+https://example.invalid/demo.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime,
  packageManager: S.PackageManager.Pnpm({ version: "11.21.0", runtime }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
})
```

Then declare the package’s test target:

```ts
import { Smithers } from "@smthrs/targets"

const test = Smithers.Vitest({
  tests: [Smithers.glob("test/**/*.test.ts")],
  sources: [Smithers.glob("src/**/*.ts")],
  deps: [],
  config: null,
  environment: "node",
  passWithNoTests: false,
  cwd: "packages/example"
})

export const Package = Smithers.Package({ targets: { test } })
```

Each map key is the target's name in a label, so the suite above is
`//packages/example:test`:

```bash
pnpm exec smithers-build test //packages/example:test
```

Neither file names `pnpm` or `node` in an argv. Every tool-running rule asks
the workspace declaration for its interpreter and its package manager, so
switching either is one edit to `WORKSPACE.ts`.

## What the catalog covers

The catalog holds 105 rules. They group roughly like this:

| Family                  | Rules                                                                          |
| ----------------------- | ------------------------------------------------------------------------------ |
| TypeScript and Node.js  | `Typecheck`, `TsBuild`, `DtsBuild`, `Vitest`, `NodeTest`, `EsLint`             |
| Rust and Go             | the `Cargo` and `Go` families, plus their toolchain declarations               |
| Containers and services | `Docker.Build`, `Docker.Bake`, `Docker.Serve`, `Shell.Serve`                   |
| Publishing              | `Npm.Pack`, `JsrPublish`, `Changesets.Version` (`Npm.Publish` is unsupported)  |
| Generated files         | `Generate`, `Tsconfig`, `FactoryProjection`, `TargetIndex`, `PackageJsonWrite` |
| Agents and model review | `Agent.Lint`, `Agent.Diff`, `Agent.Pr`, `LlmLint`                              |
| Composition             | `Filegroup`, `Suite`, `Alias`, `Test`, `Materialize`                           |

[Catalog rules](./rules.md) lists all 105 with the verbs each one joins,
whether its result may be replayed from the cache, and whether it declares an
output tree.

## Where this package sits

Three packages make up smithers build. This is the one a workspace author
writes against.

[`@smthrs/build`](https://github.com/smithersai/smithers/tree/main/packages/smithers/build) is the package above it. It owns the
`install` flow and the host seams that hold a machine to what a workspace
declared, and its site is the manual for the build system as a whole. The
relationship is concrete rather than nominal: `Smithers.Install`, the
`node_modules` rule declared here, plans that package's install flow, and the
runtime and package-manager declarations a `WORKSPACE.ts` writes are what that
flow measures the host against. Read
[`@smthrs/build`](https://github.com/smithersai/smithers/tree/main/packages/smithers/build) first for the model, then come back here
for the constructors.

[`@smthrs/build-cli`](https://github.com/smithersai/smithers/tree/main/packages/smithers/build/build-cli) is the third package: the
`smithers-build` binary that discovers the workspace, plans a declaration, keys
it, consults the cache, and runs whatever is missing.

All three sit under [`@smthrs/cli`](/api/cli), the `smthrs` command line every
part of Smithers hangs off. That CLI runs durable agent flows with
`smthrs flow plan`, `smthrs flow start`, and `smthrs runs list`, and smithers build is the target
graph for the repository those flows work in. Start there for the product as a
whole.

## Repository homepage

A repository can declare its workspace chat homepage in `.smithers/FACTORY.ts`:

```ts
export const home = Smithers.Factory.Home({
  blocks: [
    Smithers.Home.Prompt({ title: "What should we work on?", placeholder: "Ask Smithers…" }),
    Smithers.Home.App({ flow: "issue.implement", title: "Fix an issue", picture: "issue" }),
    Smithers.Home.App({ flow: "prs.triage", title: "Review a PR", picture: "review" }),
    Smithers.Home.App({ flow: "wiki.ask", title: "Ask the codebase", picture: "wiki" }),
    Smithers.Home.App({ flow: "triggers.register", title: "Run it every night", picture: "schedule" })
  ]
})
```

An app is a featured flow with a picture: `flow` names a slash flow or one of
the repository's own flows, and `picture` is one of `issue`, `review`, `wiki`
or `schedule`. The app shows the apps as a grid of tiles under the prompt's
`title`; a tile with a last result shows that result, otherwise its picture.
Opening a tile renders the flow's form, then the run card.

`Smithers.Home.Flows({ title })` lists the featured flows,
`Smithers.Home.Markdown({ path })` a repository Markdown file,
`Smithers.Home.Links({ links })` links, `Smithers.Home.Text({ text })` plain
text, and `Smithers.Home.Stack()` the repository's live mythical stack. The
factory projection writes `.smithers/home.json`; the server resolves Markdown
files at `main`. When that file is absent, the chat shows `README.md` if
present.

## Where to go next

- [API reference](./api.md), the module surface and what each layer owns.
- [Catalog rules](./rules.md), every rule with its verbs, caching, and route.
- [Workspace toolchains](./guides/toolchains.md), what `S.Workspace` accepts.
- [Nested repositories](./guides/local-repositories.md), for a workspace that
  contains other workspaces.
