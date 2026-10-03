---
title: "@smthrs/build-cli"
description: "The smithers-build command line: commands that select declared targets by label, plan them, consult a content-addressed cache, and run only what is missing."
---

`@smthrs/build-cli` is the `smithers-build` command line and everything behind
it. You declare what your repository contains in TypeScript, then name a slice
of it on the command line and the CLI runs it:

```bash
pnpm exec smithers-build ci '//packages/...'
```

That command selects CI-safe lint, build, test, and documentation targets under
`packages/`, plans them as one graph, checks a content-addressed cache, and
spawns work only for the targets whose inputs moved.

## The problem it solves

A repository of any size accumulates scripts: a test command per package, a
lint command that differs in three of them, a CI file that lists them in an
order somebody has to maintain. Nothing describes what any of those scripts
reads or writes, so nothing can skip one safely and nothing can confine it.

`smithers-build` replaces the scripts with declarations. A target names its
inputs, its outputs, and the permissions it needs, and carries no per-command
script at all. From those declarations the CLI derives what to run, in what
order, at what concurrency, what it may write, and whether a previous result
still applies. The same plan therefore runs the same way on a laptop and on a
hosted runner, and a second run of an unchanged target spawns nothing.

## The smallest real run

Declare a workspace, declare one target, and run it. Two files:

```ts
// .smithers/WORKSPACE.ts
import { Smithers as S } from "@smthrs/targets"

const packageJson = S.file("//package.json")

export const Workspace = S.Workspace("demo", {
  repository: "git+https://example.invalid/demo.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Pnpm({
    manifest: packageJson,
    lockfile: S.file("//pnpm-lock.yaml")
  }),
  nodeModules: S.Npm.NodeModules({ packageJson })
})
```

```ts
// PACKAGE.ts
import { Smithers as S } from "@smthrs/targets"

const greet = S.Shell.Test({ shell: "echo hello" })

export const Package = S.Package({ targets: { greet } })
```

```bash
pnpm exec smithers-build test '//:greet'
```

The first run prints `hello`. The second reports a cache hit and spawns
nothing. [Quickstart](./quickstart.md) walks the same workspace through
planning, querying, and that cached rerun.

## Where this package sits

Three packages make up smithers build. Their source guides live in each
package's `docs/` tree; aggregate API references are on smithers.sh. They have
no standalone sites in the package docs fleet.

| Package                                                                                               | What it holds                                                                                               |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`@smthrs/targets`](https://github.com/smithersai/smithers/tree/main/packages/smithers/build/targets) | The authoring surface a declaration imports: `S.Workspace`, `S.Package`, and the catalog of target rules.   |
| [`@smthrs/build`](https://github.com/smithersai/smithers/tree/main/packages/smithers/build)           | The dependency `install` flow, and the runtime and package-manager seams that hold a host to a declaration. |
| `@smthrs/build-cli`                                                                                   | This package: the `smithers-build` binary and the run path behind it.                                       |

[`@smthrs/build`](https://github.com/smithersai/smithers/tree/main/packages/smithers/build) is the parent, and its site is the
manual for smithers build as a whole: what a target is, how labels work, how to
write a `PACKAGE.ts`, and the catalog of rules you can declare. Read it when
your question is about the model. Read this site when your question is about
the command: which verb selects what, what a flag does, why a run missed the
cache, and what a refusal means.

The division of labour between the two is worth knowing, because it decides
where a symptom comes from. `@smthrs/build` owns the install round and the
toolchain services; this package owns everything an invocation does after argv
arrives. That means workspace discovery, the planner, the executor, the local
and remote caches, write-set confinement, the sandbox boundary, the service
supervisor, and the query, graph, and terminal renderers. A failed
`pnpm install` under `smithers-build install` is a question for the parent. A
target that ran when you expected a cache hit is a question for this site.

Both sit under [`@smthrs/cli`](/api/cli), the `smthrs` command line and the
package the rest of Smithers hangs off. That CLI runs durable agent flows:
`smthrs flow plan`, `smthrs flow start`, `smthrs runs list`. Targets are opaque, schema-backed
declarations. Build-cli plans their inputs and keys; native rules use package
executors, while declaration bodies cross the explicit `Target.plan` boundary
inside an executor-owned Flow. If you arrived from a search result and want the product
rather than its build system, start at [`@smthrs/cli`](/api/cli).

See [Accepted agent edits](./concepts/agent-edits.md) for publication and hard-link behavior.

## How to get it

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/docs/installation.md#install-the-cli).

```json
{
  "devDependencies": {
    "@smthrs/build-cli": "1.0.0-rc.1",
    "@smthrs/targets": "1.0.0-rc.1"
  }
}
```

After installation, `smithers-build` is on `pnpm exec` at the workspace root.
[Installation](./installation.md) covers the runtime
requirements, the loader the binary boots, and what a declaration module may
contain.

## Who reaches for the library

Anyone running a Smithers workspace uses the binary. Programs that embed the
build, a test harness or a hosted runner, import `makeCli` and `Entry.main`
instead and drive the same commands with injected terminals, an injected
environment, and an `AbortSignal` they own. See
[Embed the CLI in another program](./guides/embed-the-cli.md).

## Commands

The [command reference](./cli.md) is the complete inventory of commands,
aliases, arguments, and options. The [selection guide](./guides/select-targets.md)
helps choose a verb and pattern for a task.

## Where to go next

- [Installation](./installation.md): the runtime, the loader, and the
  TypeScript syntax declaration modules may use.
- [Declaration loading](./concepts/declaration-loading.md): dependency identity,
  early conflict diagnostics, module formats, and evaluation lifetime.
- [Quickstart](./quickstart.md): one workspace, one target, planned, run,
  cached, and queried.
- [Commands](./cli.md): every command, argument, option, and exit code.
- Guides: [select the targets a command runs](./guides/select-targets.md),
  [inspect a workspace without running it](./guides/inspect-a-workspace.md),
  [share results through a remote cache](./guides/share-a-remote-cache.md),
  [scaffold an app](./guides/scaffold-an-app.md), and
  [embed the CLI in another program](./guides/embed-the-cli.md).
- Concepts: [the invocation pipeline](./concepts/invocation.md),
  [workspace discovery](./concepts/discovery.md),
  [output and renderers](./concepts/output.md),
  [caching](./concepts/caching.md), and
  [target execution](./concepts/execution.md).
- [Native file outputs](./concepts/native-file-outputs.md): output admission and publication.
- [Rule contracts and ownership](./concepts/rule-contracts.md): the internal
  architecture and the boundary between declarations and host execution.
- [Troubleshooting](./troubleshooting.md): the refusals this CLI reports, what
  causes each one, and what to change.
- [API reference](./api.md): the exports a program embedding the CLI uses.
