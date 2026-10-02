---
title: "smthrs"
description: "The unscoped smthrs package on npm. At 1.0 it publishes a migration notice instead of a runtime: importing it throws and names the @smthrs/* packages that replaced the 0.x umbrella."
---

`smthrs` is the npm name that Smithers 0.x published as one umbrella package:
the JSX authoring API, the renderer, and fourteen `@smthrs/*` packages behind
a single dependency. Smithers 1.0 removed that architecture. The name keeps
its place on the registry, and what it publishes at `1.0.0-rc.0` is a
migration notice rather than code. The module declares no exports. An
import that reaches it throws:

```text
smthrs 1.0 is a migration notice, not a runtime.
Smithers 1.0 ships as @smthrs/* packages. Install @smthrs/flows (authoring and engine)
and @smthrs/cli (the `smthrs` command), then run `smthrs migrate` in a 0.x project.
Migration guide: https://smithers.sh/migration/1.0
```

That is what a bare `import "smthrs"`, a namespace import, a dynamic
`import()`, and a `require` print. A static named or default import, the way
0.x code is written, never reaches the module body: Node rejects
`import { Workflow } from "smthrs"` while it links the module graph, with a
`does not provide an export named` SyntaxError and no notice.
[Troubleshooting](./troubleshooting.md) covers that error.

## Why a package that only throws

Nobody adds this package to a project on purpose. You reach it one of two
ways: an upgrade pulled `smthrs@next` into a 0.x project, or you searched npm
for Smithers, found the shortest name, and installed it.

Throwing is the point. Smithers 1.0 shares no source-compatible API with 0.x,
so a package that resolved to an empty module would fail later and somewhere
else, as an undefined value with no explanation attached. An import that
evaluates the module gets the error at the import that caused it, carrying the
four lines that say where the code went. A static named import fails at the
same statement, one step earlier, with the missing-export error instead.

`npm install smthrs` does not reach the notice. `smthrs@0.35.0` holds the
`latest` dist-tag until Smithers 1.0.0 is final, so an unattended install
still gets 0.x. Release candidates publish under `next`, which makes
`smthrs@next` and `smthrs@1.0.0-rc.0` the two specifiers that reach this
package.

## Upgrade a 0.x project

Install the 1.0 command line and plan the migration from the project
directory. Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/apps/site/docs/installation.mdx).

```bash
smthrs migrate
```

With no flags, `smthrs migrate` plans only. It writes
`.smithers-migrate/report.json` and `.smithers-migrate/report.md` and changes
nothing else. Read the report, then convert the source:

```bash
smthrs migrate --apply --seat provider:model
```

Leave `smthrs` in `package.json` while you do. An apply run migrates the
project one unit at a time: the first unit adds the `@smthrs/*` packages
beside the old ones, and the final unit removes the 0.x dependency, the JSX
settings, and the old CLI scripts once nothing depends on them.

If the project's `.tsx` sources still have to compile while you work,
reinstall `smthrs@0.35.0` first. Version 1.0.0-rc.0 publishes no
`jsx-runtime`, so nothing that resolves through `jsxImportSource: "smthrs"`
resolves at all.

## Start on 1.0 instead

If you wanted the runtime and installed this name, depend on the `@smthrs/*`
packages directly:

```bash
npm remove smthrs
```

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/apps/site/docs/installation.mdx).

## Where the code went

Smithers 1.0 has no umbrella package. The runtime is a set of `@smthrs/*`
packages, each with its own documentation site. Two of them are the entry
points a project starts from:

- [`@smthrs/cli`](/api/cli) publishes the `smthrs` executable, with `smithers`
  as an alias of the same binary. It owns `smthrs migrate`.
- [`@smthrs/flows`](/api/flows) is the curated aggregate: the authoring
  primitives, the durable engine, and the stores behind one dependency.

Underneath those sit the packages you import by name once you know which part
you need:

- [`@smthrs/flow`](/api/flow): flows, actions, durable waits, and retry
  policy, the authoring model that replaced `Workflow` and `Task`.
- [`@smthrs/plan`](/api/plan): the keyed action graph that replaced
  `Sequence`, `Parallel`, and `Branch`.
- [`@smthrs/engine`](/api/engine): the runtime that executes a flow, in place
  of the React reconciler and `SmithersRenderer`.
- [`@smthrs/agent`](/api/agent): the agent loop, and `AgentAction` for a
  model-backed step.
- [`@smthrs/patterns`](/api/smithers-patterns): review loops and bounded recursion, in
  place of the `Loop`, `Ralph`, and `ReviewLoop` components.
- [`@smthrs/control`](/api/control): approvals and steering on the control
  plane.
- [`@smthrs/journal`](/api/journal) and [`@smthrs/run-store`](/api/run-store):
  run history and run state, in place of the 0.x output accessors.
- [`@smthrs/database`](/api/database): the SQL contract behind those stores.
- [`@smthrs/registry`](/api/registry): flow descriptor discovery, in place of
  the JSX workflow loaders.
- [`@smthrs/migrate`](/api/migrate): the library behind `smthrs migrate`.

## Read next

- [Why importing smthrs throws](./notice.md) reads the notice line by line and
  explains the publication decisions that carry it to a person rather than to
  a log.
- [What replaced the 0.x umbrella](./replacements.md) maps every construct the
  facade exported to the 1.0 package and concept to rewrite it against.
- [Troubleshooting](./troubleshooting.md) covers the failures that never print
  the notice: the missing-export error on a static named import, and the
  subpath error most 0.x projects hit first.
- The [1.0 migration guide](/migration/1.0) is the full procedure and the
  complete removal list.
