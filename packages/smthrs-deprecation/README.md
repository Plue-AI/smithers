# smthrs

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

**Documentation:** https://smthrs.smithers.sh

`npx smthrs <verb>` runs the Smithers CLI (`@smthrs/cli`). `npx smthrs tui`
opens the terminal coding agent; it requires [Bun](https://bun.sh).

As a library, `smthrs@1.0.0-rc.0` is a migration notice, not a runtime. An
import that reaches it throws:

```text
smthrs 1.0 is a migration notice, not a runtime.
Smithers 1.0 ships as @smthrs/* packages. Install @smthrs/flows (authoring and engine)
and @smthrs/cli (the `smthrs` command), then run `smthrs migrate` in a 0.x project.
Migration guide: https://smithers.sh/migration/1.0
```

Smithers 0.x published `smthrs` as an umbrella facade over the JSX authoring
API, the renderer, and fourteen `@smthrs/*` packages. Smithers 1.0 removes that
architecture. The name keeps its place on the registry so that an upgrading
project is told where the code went, rather than resolving to a silently
different API. There is no umbrella package at 1.0, no JSX runtime, and no
compatibility shim.

## Upgrading a 0.x project

Read the [migration guide](https://smithers.sh/migration/1.0), install the 1.0
command line, and plan the migration from the project directory. Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#install-the-cli).

```sh
smthrs migrate
```

`smthrs migrate` with no flags plans only. It writes
`.smithers-migrate/report.json` and `.smithers-migrate/report.md` and changes
nothing else. Read the report, then convert the source with
`smthrs migrate --apply --seat provider:model`.

Leave `smthrs` in `package.json` while you do. An apply run migrates the
project one unit at a time: the first unit adds the `@smthrs/*` packages at
1.0.0-rc.0 beside the old ones, and the final unit removes the 0.x packages,
the JSX settings, and the old CLI scripts once nothing depends on them.

Reaching this notice means `smthrs@1.0.0-rc.0` is installed where 0.x used to
be. Reinstall `smthrs@0.35.0` first if the project's `.tsx` sources still have
to compile: 1.0.0-rc.0 publishes no `jsx-runtime`, so nothing that resolves
through `jsxImportSource: "smthrs"` resolves at all.

## Wanted the 1.0 runtime, installed this name

Depend on the `@smthrs/*` packages directly:

```sh
npm remove smthrs
```

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

`@smthrs/flows` is the curated aggregate: the authoring primitives, the durable
engine, and the stores behind one dependency. `@smthrs/cli` owns the `smthrs`
command and its `smithers` alias. Import the `@smthrs/*` package you need.
Nothing at 1.0 re-exports everything.

## `does not provide an export named` instead of the notice

The module declares no exports, and the notice is thrown while the module body
evaluates. A static named or default import, the way 0.x code is written, is
rejected one step earlier, while Node links the module graph:

```text
SyntaxError: The requested module 'smthrs' does not provide an export named 'Workflow'
```

Only an import that reaches evaluation prints the notice: a bare
`import "smthrs"`, a namespace import, a dynamic `import()`, or a `require`.
Read the SyntaxError as the notice: Smithers 1.0 ships as `@smthrs/*` packages,
so depend on `@smthrs/flows` and `@smthrs/cli`, then run
`smthrs migrate` to rewrite the import.

## `ERR_PACKAGE_PATH_NOT_EXPORTED` instead of the notice

Only the root specifier `smthrs` throws the notice. Every 0.x subpath fails to
resolve at all, with the message Node prints for a subpath a package does not
export:

```text
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './jsx-runtime' is not defined by "exports" in .../node_modules/smthrs/package.json
```

`smthrs/jsx-runtime` and `smthrs/jsx-dev-runtime` are the two a 0.x project hits
first, because `jsxImportSource: "smthrs"` makes every `.tsx` file resolve one
of them before anything imports the bare name. `smthrs/ui`, `smthrs/gateway-react`,
and the rest of the 0.x subpaths fail the same way. The failure means what the
notice means: 1.0 publishes no JSX runtime and no umbrella subpaths, so there is
nothing behind those specifiers to import. The fix is the same too: migrate, and
let `smthrs migrate` rewrite the imports and drop the `jsxImportSource` setting
for you.

## What this package used to export, and what replaces it

Nothing in the table below has a source-compatible replacement; each row names
the concept to rewrite against.

| Removed from `smthrs`                                                       | Replacement in 1.0                                                                                                                             |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `smthrs/jsx-runtime`, `smthrs/jsx-dev-runtime`, `jsxImportSource: "smthrs"` | No JSX authoring API. Author a flow in TypeScript with `Flow` and `Action` from `@smthrs/flow`, or in Markdown as `flows/<name>/flow.mdx`.     |
| `Workflow` and `Task` components                                            | `Flow.make` and `Action.make` (`@smthrs/flow`). A model-backed step is `AgentAction.make` (`@smthrs/agent`).                                   |
| `Sequence`, `Parallel`, `Branch` components                                 | `Node.andThen`, `Node.all`, and `Node.branch` (`@smthrs/plan`).                                                                                |
| `Loop`, `Ralph`, `ReviewLoop` components                                    | `ReviewLoop.run`, or `Recursion.recurse` with an explicit fuel, depth, and fanout envelope (`@smthrs/patterns`).                               |
| `SmithersRenderer`, `createSmithers`, `runWorkflow`, the React reconciler   | `FlowEngine` and `FlowProxy` (`@smthrs/engine`), composed through `@smthrs/flows/NodeRuntime`.                                                 |
| `Approval`, `HumanTask`, `Wait`, `Signal` components                        | `DurableDeferred`, `HumanTask`, `WaitFor`, and `Sleep` (`@smthrs/flow`), with approvals and steering on the control plane (`@smthrs/control`). |
| Output accessors and workflow context hooks                                 | Journal projections and the run store (`@smthrs/journal`, `@smthrs/run-store`).                                                                |
| `mdx-plugin`, JSX workflow loaders and templates                            | Flow descriptor discovery (`@smthrs/registry`).                                                                                                |
| Backend selection and direct database helpers                               | `@smthrs/database` and `@smthrs/engine-store`. SQLite is the only backend supported at 1.0.0-rc.0.                                             |
| The `smithers` binary published by `smthrs`                                 | `@smthrs/cli`, which owns both the `smthrs` and `smithers` spellings of one executable. `smthrs` still ships `smthrs`, which runs that CLI.    |

Smithers 1.0.0-rc.0 does not migrate live or in-flight 0.x runs. Finish,
archive, or discard them before upgrading.

`smthrs@0.35.0` stays on the `latest` dist-tag until Smithers 1.0.0 is final.
Release candidates publish under the `next` dist-tag.
