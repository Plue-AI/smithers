---
title: "Installation"
description: "Install the smthrs executable, the Node version it requires, the runners it supports, and the import forms of the library."
sidebar:
  order: 1
---

## Install the executable

Not on npm yet; see [Installation](/docs/installation/#install-the-cli).

`smthrs` is the package to install. Its `smthrs` executable runs this package,
`@smthrs/cli`, which it installs as a dependency. Inside a workspace,
`@smthrs/cli` also provides `smthrs` and its `smithers` alias from
`bin/smithers.mjs`. Do not install both packages globally: npm refuses the
second `smthrs` link.

The executable declares `@effect/sql-sqlite-node@4.0.0-rc.115` as a required
peer because its default runtime opens SQLite. Modern npm and pnpm install
that peer with the CLI, along with its required Effect Node adapter. The
database library itself keeps SQLite optional for driver-neutral consumers.

Confirm what you got, and what the registry offers, with the CLI itself:

```bash
smthrs --version
smthrs update
```

`smthrs update` compares `Version.packageVersion` against the `next` and
`latest` dist-tags and prints the `npm install` line for the newer one. It
changes nothing, and it prefers `next`, so an rc install is never told to
downgrade to a 0.x `latest`.

## Requirements

- Node 26.4.0 or later. The durable engine requires it, `smthrs doctor`
  reports a `fail` outside this range. `Doctor.supportedNodeRange` matches the
  published manifest.
- A project directory. Commands that touch durable state resolve a project
  root and write `.flows/` under it. See
  [The project and its state](./concepts/project-and-state.md).
- A provider credential, for flows that call a model. `smthrs doctor` reports
  which of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
  `MOONSHOT_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, and `CEREBRAS_API_KEY` are set, and names any that are exported but empty. The
  doctor check reports presence without printing credential values.
- `AI_GATEWAY_API_KEY`, to run an agent. The agent loop's last brake on a
  completion asks Jev whether the claim the run wrote matches the evidence the
  run produced, and it never falls back: without the key every run fails at its
  first completion with `completion_unjudged`. Flows that call no agent do not
  need it.

## Runners

The shebang in `bin/smithers.mjs` pins Node, because the durable engine is
not supported on Bun. Running the CLI with `bun --bun` overrides the shebang
and is not supported.

## The terminal UI

`smthrs tui` opens the terminal coding agent in the current directory. It
runs on Node 26.4 or later or on Bun. Under Node, the CLI starts the TUI with
`--experimental-ffi`, which OpenTUI needs to load its renderer. Set
`SMITHERS_BUN` to a Bun executable to run the TUI on Bun instead.

```bash
smthrs tui                       # open the TUI here
smthrs tui ../repo -c            # continue the latest session in ../repo
smthrs tui -m openai:gpt-6-sol   # choose the chat seat
smthrs tui -p "Summarize README" # print one answer and exit
smthrs tui --approve ask        # ask before consequential calls
```

## Workspace target commands

Global and one-off installations can initialize a project and operate its flows.
To load `WORKSPACE.ts` and `PACKAGE.ts`, install the CLI and declaration packages
in that workspace ([Install the CLI](/docs/installation/#install-the-cli)), then
select its local binary:

```bash
smthrs init hello
pnpm exec smthrs targets
```

The loader and declarations must resolve the same physical Effect and Smithers
packages. A separately installed global CLI can report
`declaration_dependency_mismatch` even when versions match. Before publication,
use the checkout's workspace dependency graph. The
[first-target tutorial](https://smithers.sh/docs/tutorials/first-target/) walks
through local planning, execution, and cache reuse.

## Using the library

The package is also importable. The root entry point re-exports every module
as a namespace:

```ts
import { Command, NodeControl, Output, Verb } from "@smthrs/cli"
```

Each module is also importable from its own subpath, which is the form the
[API reference](./api.md) uses:

```ts
import * as NodeControl from "@smthrs/cli/NodeControl"
import * as Verb from "@smthrs/cli/Verb"
```

`@smthrs/cli/package.json` is exported. Two subpath forms are not public and
are blocked in the export map: `@smthrs/cli/internal/*` and
`@smthrs/cli/*/index`.

The package depends on the whole Smithers stack, including
[`@smthrs/control`](/api/control), [`@smthrs/engine`](/api/engine),
[`@smthrs/agent`](/api/agent), [`@smthrs/gateway`](/api/gateway), and
[`@smthrs/journal`](/api/journal). Installing it installs them, so a host that
embeds the command tree adds no further packages. See
[Embed the command tree](./guides/embed-the-command-tree.md).

## Next step

Run one project from `init` to a settled run in the [Quickstart](./quickstart.md).
