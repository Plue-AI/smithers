---
title: "@smthrs/build"
description: "Dependency installation as a keyed flow: the measure, fetch, and link actions behind smithers build, plus the runtime and package-manager seams that hold a host to what a workspace declared."
---

`@smthrs/build` turns installing a project's dependencies into a build step you
can plan, key, and cache. It exports the `install` flow and the two seams that
flow runs against: the interpreter a workspace declared, and the package manager
that does the work.

This site is also the manual for **smithers build**, the Bazel-style build
orchestrator those pieces belong to. A workspace declares its packages and
targets in `PACKAGE.ts` files, a `WORKSPACE.ts` file declares the toolchain once,
and the `smithers-build` command plans and runs whatever a label selects.

## The problem it solves

In most build graphs, `pnpm install` is a hole. Nothing describes what it read,
nothing keys what it produced, and a build that depends on `node_modules`
depends on whatever the last person ran. `@smthrs/build` closes that hole with
three declared actions in one round:

1. **measure** records the content the install is keyed on: the lockfile digest
   and the credential-free `.npmrc` digest.
2. **fetch** populates the content-addressed store under `.flows/store/<manager>`
   from the lockfile alone, without writing `node_modules`.
3. **link** reconciles `node_modules` from that store, offline where the manager
   supports it.

The manager version and the host platform are not content. They come from the
`PackageManager` and `Runtime` services, which measure the host and fail when it
does not satisfy what the workspace declared. A declaration that nothing checks
is a comment.

## The shortest real example

Declare the toolchain once, in the workspace declaration:

```ts
// .smithers/WORKSPACE.ts
import { Smithers as S } from "@smthrs/targets"

const packageJson = S.file("//package.json")

export const runtime = S.Runtime.Node({ version: ">=26.4.0" })
export const packageManager = S.PackageManager.Pnpm({ version: "11.21.0", runtime })

export const Workspace = S.Workspace("demo", {
  repository: "git+https://example.invalid/demo.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime,
  packageManager,
  nodeModules: S.Npm.NodeModules({ packageJson })
})
```

Then install:

```bash
pnpm exec smithers-build install
```

That command plans the `install` flow under the declared manager's layer and
runs measure, fetch, and link. Only pnpm performs work today; a Bun declaration
resolves the service and refuses every operation with a typed `unsupported`
error rather than approximating a verified fetch.

## Where this package sits

Three packages make up smithers build, and each has its own documentation:

| Package                                                                                                   | What it holds                                                                                                         |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `@smthrs/build`                                                                                           | This package: the `install` flow, and the `PackageManager` and `Runtime` host seams.                                  |
| [`@smthrs/targets`](https://github.com/smithersai/smithers/tree/main/packages/smithers/build/targets)     | The declaration surface `PACKAGE.ts` and `WORKSPACE.ts` files import: `S.Workspace`, `S.Package`, and target catalog. |
| [`@smthrs/build-cli`](https://github.com/smithersai/smithers/tree/main/packages/smithers/build/build-cli) | The `smithers-build` binary: discovery, the planner, the executor, the caches, and the query and graph output.        |

All three sit under [`@smthrs/cli`](/api/cli), the `smthrs` command line and the
package everything in Smithers hangs off. That CLI runs durable flows:
`smthrs flow plan`, `smthrs flow start`, `smthrs runs list`. The `install` flow this package
declares is one of those flows, built with the same `Flow.make` and executed by
the same engine, which is why an install has a content key at all. If you
arrived here from a search result and want the whole product rather than its
build system, start at [`@smthrs/cli`](/api/cli).

## Read next

- [What is smithers build](about/what-is-smithers-build.md): the model, and how
  it compares with Bazel, Turborepo, and nx.
- [Install](getting-started/install.md) and [First build](getting-started/first-build.md):
  get the CLI into a workspace, then run every verb against one package.
- [Install](concepts/install.md): the measure round, the fetch and link split,
  and why a linked tree is never restored from another machine.
- [API reference](api.md): the exports of this package.

## The rest of the manual

### Workspace

| Page                                                                 | Description                                                                       |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [Structure](workspace/structure.md)                                  | Discovery, `PACKAGE.ts` placement, package boundaries, default-target synthesis.  |
| [Writing build files](workspace/writing-build-files.md)              | Targets, target calls, import edges, and macros.                                  |
| [Configuration](workspace/configuration.md)                          | The workspace declaration, the cache directory, and confinement.                  |
| [Running targets](workspace/running-targets.md)                      | `install`, the target verbs, `ci`, and what actually executes.                    |
| [Querying](workspace/querying.md)                                    | `query`, `deps()`, and `graph`.                                                   |
| [Caching](workspace/caching.md)                                      | Content keys, the result cache, and what re-keys a target.                        |
| [Remote caching](workspace/remote-caching.md)                        | The HTTP read-through cache and the `/ac` and `/cas` services.                    |
| [The Smithers Cloud-hosted cache](workspace/smithers-cloud-cache.md) | Coming soon: zero-config discovery, committed public read tokens, and publishing. |
| [Adoption](workspace/adoption.md)                                    | What the Smithers monorepo runs through smithers build, as a worked case.         |

### Concepts

| Page                                                         | Description                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| [Labels](concepts/labels.md)                                 | The `//pkg:target` grammar, package defaults, and `//...` patterns.       |
| [Target definitions and targets](concepts/targets.md)        | A target is a flow with planner metadata.                                 |
| [Inputs](concepts/inputs.md)                                 | `file()`, `glob()`, `gitDiff()`, and when they are digested.              |
| [Dependencies](concepts/dependencies.md)                     | Import edges, `deps` attributes, and transitive planning.                 |
| [Actions and boundaries](concepts/actions-and-boundaries.md) | Sealed actions, `TreeArtifact` writes, host state, and confinement.       |
| [Install](concepts/install.md)                               | The measure round, fetch key material, and manager-as-layer.              |
| [Environments](concepts/environments.md)                     | The declared Nix closure tools resolve from, and what it makes cacheable. |
| [Ownership](concepts/ownership.md)                           | `owners` on a package, and the generated CODEOWNERS and OWNERS files.     |

### Extending

| Page                                                       | Description                                                                        |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Writing target definitions](extending/writing-targets.md) | `Target.make`: the attrs schema, the plan-time implementation, and typed failures. |
| [Writing macros](extending/writing-macros.md)              | `buildAndCheckPackage` as the worked example.                                      |
| [Default targets](extending/default-rules.md)              | `PackageDefaults`, `directories`, `marker`, `unless`, and `macro`.                 |

### Reference

| Page                                          | Description                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| [API reference](api.md)                       | The `Install`, `PackageManager`, and `Runtime` exports of this package.                |
| [CLI](reference/cli.md)                       | Every verb, flag, output shape, and exit code.                                         |
| [Terminal output](reference/cli-output.md)    | The `--ui` renderers, what a person sees on a terminal, and the prior art they follow. |
| [Workspace](reference/config.md)              | The workspace declaration and its exact validation rules.                              |
| [Target catalog](reference/targets/README.md) | One page per target, with attribute tables and execution status.                       |
| [FAQ](about/faq.md)                           | Short answers to the questions the design raises.                                      |
