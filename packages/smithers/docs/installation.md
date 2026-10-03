---
title: "Installation"
description: "Install the smthrs executable, the Node version it requires, the runners it supports, and the import forms of the library."
sidebar:
  order: 1
---

## Install the CLI

The 1.0 release candidate is not published to npm. Use Node.js 26.4.0 or later, pnpm 11.25.0, Git, and the Rust toolchain pinned in `rust-toolchain.toml`.

```bash
git clone https://github.com/smithersai/smithers.git
cd smithers
pnpm install
cargo build --locked --release -p smithers-ffi --bin smithers-jj-export
export PATH="$PWD/node_modules/.bin:$PATH"
smthrs --version
```

The Rust command builds the filesystem helper that confined flow commands require. The PATH line selects this checkout's `smthrs` and `smithers` executables for the current shell. `smthrs --version` prints `1.0.0-rc.1`. Change to your project directory before running `smthrs init`.

Target declarations and the CLI must resolve the same physical Effect and Smithers packages. A separately installed CLI can fail with `declaration_dependency_mismatch` even when its versions match. Use the checkout's CLI and workspace dependency graph.

## Verify the install

```bash
smthrs doctor
```

`doctor` checks flow discovery, local state and database compatibility, the Node.js version, Jujutsu availability, and provider configuration without running a flow. It exits 1 when a check fails.

## Stay current

From the source checkout:

```bash
git pull
pnpm install
cargo build --locked --release -p smithers-ffi --bin smithers-jj-export
```

`smthrs update` reads npm's dist-tags for `@smthrs/cli` and never installs anything.

## Install the executable

install from the source checkout using [Install the CLI](#install-the-cli).

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
- A configured subscription seat for model flows and their completion judge.
  For Codex, install the vendor CLI and run `codex login --device-auth`.
  A `codex:sol` seat runs `codex exec --json -m gpt-6-sol -` with the prompt
  on stdin and Smithers tools over MCP. Only Codex reads or refreshes its login;
  Smithers holds no Codex token. Set `SMITHERS_OPENAI_AUTH=chatgpt` to select
  Codex automatically or to run existing `openai:` seats through Codex.
  A signed-out host refuses the seat and names `codex login --device-auth`.
  For Claude, install Claude Code and run `claude auth login`; with no
  `ANTHROPIC_API_KEY` set, the `opus`, `sonnet` and `fable` seats (and their
  `claude-code:` forms) run on your own Claude Code, which signs its own
  requests. They run flows only; the completion judge needs a Codex seat.
  Team hosts use connected accounts through the existing account pool.
  No provider API key or gateway key is required; a failed subscription never
  falls back to an API key.

## Runners

The shebang in `bin/smithers.mjs` pins Node, because the durable engine is
not supported on Bun. Running the CLI with `bun --bun` overrides the shebang
and is not supported.

## The terminal UI

`smthrs tui` opens the terminal coding agent in the current directory. It
runs on Node 26.4 or later or on Bun. Under Node, the CLI starts the TUI with
`--experimental-ffi`, which OpenTUI needs to load its renderer. Set
`SMITHERS_BUN` to a Bun executable to run the TUI on Bun instead. The launcher
tries `SMITHERS_TUI_BIN`, an installed compiled binary, Bun, then Node.
Interactive startup in compiled builds loads the OpenTUI shared library from a writable, executable `TMPDIR`. If `/tmp` is mounted `noexec`, loading it can fail with `Operation not permitted`. Alpine also needs `libstdc++`.

If your home filesystem allows execution:

```bash
mkdir -p "$HOME/.cache/smithers/tmp"
export TMPDIR="$HOME/.cache/smithers/tmp"
smthrs tui /path/to/project
```

`--help` and `--print` do not load OpenTUI, so their success does not verify interactive startup. Launch without either flag in a terminal to check it.

The CLI package ships its native editor; keep the package intact when moving
a Node installation. Compiled binaries embed the editor. Installation does not
require Zig.

```bash
smthrs tui                       # open the TUI here
smthrs tui ../repo -c            # continue the latest conversation in ../repo
smthrs tui -m openai:gpt-6-sol   # choose the chat model
smthrs tui -p "Summarize README" # print one answer and exit
smthrs tui --approve ask        # ask before consequential calls
```

## Workspace target commands

Global and one-off installations can initialize a project and operate its flows.
To load `WORKSPACE.ts` and `PACKAGE.ts`, install the CLI and declaration packages
in that workspace ([Install the CLI](./installation.md#install-the-cli)), then
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

## Agent skill

Run `smthrs skills add` to install or refresh the packaged Smithers authoring skill in detected agents. The skill comes from the installed CLI package, regardless of your current directory.
