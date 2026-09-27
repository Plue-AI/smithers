---
title: "@smthrs/cli"
description: "The smthrs command line: plan, approve, run, and inspect durable agent runs from a shell, a CI job, an MCP client, or your own Node program."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/docs/README.md"
---

`@smthrs/cli` installs `smthrs`, the command line for Smithers. Smithers is a
control plane for long agent runs: it keeps a run, its plan, its approvals, and
its events as durable state, so the run survives the process that started it.
Use `smthrs` to start such a run, decide the approvals it asks for, and read
back what it did. [smithers.sh](https://smithers.sh/docs/) is the product documentation.

## What it solves

A long agent run is not a shell command. It outlives the terminal that started
it, it stops halfway to ask whether it may push a branch, and when it fails you
need to know which step failed and what it had already done. Smithers keeps
that run in two SQLite files beside your project, so the run is a durable record
rather than terminal scrollback. `smthrs` is how you talk to it: start runs,
list them, follow their events, approve what they ask for, and cancel them.

Flow control, run management, and approvals can use a hosted control plane with
`--remote https://host:3000`. Target execution and local operator commands use
the selected workspace; history, memory, triggers, credentials, integrations,
and evaluations refuse remote access.

Four callers use it. You run flows from a shell. Scripts and CI jobs call it
with `--json` and branch on its exit codes. Agents drive the same control plane
through `smthrs --mcp`, the stdio MCP server the executable also hosts. Hosts
that embed Smithers import the command tree and run it inside a program of
their own.

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#install-the-cli).

Node 26.4.0 or later is required. The package installs one
executable under two names, `smthrs` and its `smithers` alias. For the runner
matrix and the import forms of the library, see
[Installation](/installation/).

## The shortest real example

Scaffold a flow, plan it, approve the plan, and run it:

```bash
smthrs init hello
smthrs flow list
approval="$(smthrs flow plan hello --json | jq -c '.approval')"
smthrs approvals approve "$approval" --scope run --json
smthrs flow execute "$approval" --json
smthrs runs list
```

`smthrs flow plan` creates no run. It prints a plan card whose `approval`
member is the payload `approvals approve`, `approvals deny`, and `flow execute`
accept unchanged, which is why the same string appears twice above.
`smthrs flow start hello` collapses all three steps into one command. [Quickstart](/quickstart/) walks the loop to a settled run
and reads its events back.

## The binary at a glance

One executable answers in three modes, chosen before the command tree parses
anything:

| Invocation | What it does |
| --- | --- |
| `smthrs --help`, `smthrs --version` | Prints a document. Resolves no project, opens no database. |
| `smthrs --mcp` | Serves the Smithers MCP server on stdio over the same control plane the verbs use. |
| `smthrs <verb> ...` | Runs one command handler against the control plane. |

The commands group by the job they do:

| Job | Commands |
| --- | --- |
| Plan and launch | `flow list`, `flow plan`, `flow start`, `flow execute`, `runs resume` |
| Decide an approval | `approvals list`, `approvals approve`, `approvals deny` |
| Steer a live run | `runs signal`, `runs steer` |
| End a run | `runs cancel`, `runs cancel-all` |
| Read what happened | `runs list`, `runs show`, `runs logs`, `runs output` |
| Set a project up | `init`, `suggest`, `doctor`, `migrate` |
| Host and integrate | `serve`, `mcp` |
| Maintain | `gc`, `memory`, `update`, `bug`, `completions` |

Smithers 0.x spellings that were removed refuse with one sentence and a
migration link rather than a parser error, so a script written against 0.x is
told what replaced each one. The per-command reference, generated from
`--help`, is at [smithers.sh/docs/reference/cli](https://smithers.sh/docs/reference/cli/).
See [the command surface](/concepts/command-surface/) for how the shipped
list and the removed list are both kept closed.

## The package at a glance

`@smthrs/cli` is also a library. A host that wants the Smithers commands inside
its own Node program imports the command tree and the layer that satisfies it
rather than shelling out. The root entry point exports every module as a
namespace, and each is also importable from `@smthrs/cli/<Module>`:

| Namespace | What it is |
| --- | --- |
| `Command` | The Effect CLI command tree: every shipped verb with a handler, every removed one with a refusal. |
| `NodeControl` | The complete Node host for that tree: configuration, registry, durable engine, executor, output, and the served gateway. |
| `Application` | The transport-neutral half of that composition: local control plane or RPC client, chosen from `Config`. |
| `Output` | Deterministic rendering, and the receipt-to-exit-code mapping. |
| `Ui` | Interactive terminal rendering, with a plain-line fallback for pipes and CI. |
| `CliError` | The four failures the command line adds, and the status each exits on. |
| `Verb`, `Unsupported` | The shipped verb catalog, and the removed verbs, flags, and reserved flow ids. |
| `Project`, `Environment` | Where an invocation decides it is running, and the closed set of variables it reads. |
| `Detached` | The `flow start -d` launch, and the admission line its child prints. |
| `Doctor`, `Forensics`, `NodeOutput`, `Legacy` | Readiness, run diagnosis, node outputs, and the 0.x database guard. |
| `McpServer`, `Agents` | The stdio MCP server, and the agent configurations `mcp add` writes it into. |
| `Serve` | The gateway bind rule, the mount list, and the banner rendered from it. |
| `Init`, `Suggest`, `Providers` | Scaffolding, the guided suggestion pass, and the seats this machine can run. |
| `Gc`, `Update`, `Bug`, `ClaudeMirror`, `CodexAuth`, `ExecutorOwnership`, `Version` | Retention, version checks, bug reports, the Claude Code mirror protocol, the Codex credential store, executor ownership, and the installed version. |

Every export of every namespace is on the [API reference](/reference/api/), and
[Embed the command tree](/guides/embed-the-command-tree/) is the guide.

## The packages underneath

`@smthrs/cli` is the top of the Smithers package tree. Installing it installs
the whole stack, so a host that embeds the command tree adds no further
dependencies. Each package below is published on its own and documented on its
own site; reach for one directly when you want that layer without the command
line.

| Package | What it is |
| --- | --- |
| [`@smthrs/control`](https://control.smithers.sh/reference/api/) | The control plane every verb talks to: plans, approvals, runs, events, and their RPC projections. |
| [`@smthrs/flow`](https://flow.smithers.sh/reference/api/) | The flow authoring model: flows, actions, durable waits, and retry policy. |
| [`@smthrs/engine`](https://engine.smithers.sh/reference/api/) | The runtime that executes those flows durably, and its HTTP and RPC transports. |
| [`@smthrs/flows`](https://flows.smithers.sh/reference/api/) | One barrel over the whole durable flow engine, for a host that wants it in a single import. |
| [`@smthrs/agent`](https://agent.smithers.sh/reference/api/) | The agent loop the executor runs, with the adapters for control-plane runs and typed workflow steps. |
| [`@smthrs/model`](https://model.smithers.sh/reference/api/) | Model protocols, routes, and streaming events: the seats a flow names. |
| [`@smthrs/memory`](https://memory.smithers.sh/reference/api/) | The durable cross-run facts behind `smthrs memory`. |
| [`@smthrs/journal`](https://journal.smithers.sh/reference/api/) | The immutable run history behind `smthrs runs logs`, including the redaction every write passes through. |
| [`@smthrs/plan`](https://plan.smithers.sh/reference/api/) | The persisted plan a plan card renders: a keyed action graph, its store, and its diff. |
| [`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/) | The capability kernel that confines what a run may touch on the filesystem and the shell. |
| [`@smthrs/gateway`](https://gateway.smithers.sh/reference/api/) | The server `smthrs serve` hosts, and the projections a client subscribes to. |
| [`@smthrs/mcp`](https://mcp.smithers.sh/reference/api/) | The MCP client that projects a remote server's tools into a run's flow catalog. |
| [`@smthrs/migrate`](https://migrate.smithers.sh/reference/api/) | The Smithers 0.x project upgrade behind `smthrs migrate`. |
| [`@smthrs/create-app`](https://create-app.smithers.sh/reference/api/) | Declaring a Smithers app: file-routed flows, panes, and deploy targets. |
| [`@smthrs/testing`](https://testing.smithers.sh/reference/api/) | The testing and conformance library for flows. |

## Where to go next

- [Installation](/installation/): requirements, executables, and the import
  forms of the library.
- [Quickstart](/quickstart/): one project from `init` to a settled run.
- Concepts: [the command surface](/concepts/command-surface/),
  [the project and its state](/concepts/project-and-state/),
  [local and remote control planes](/concepts/local-and-remote/), and
  [output and exit codes](/concepts/output-and-exit-codes/).
- Guides: [script the CLI](/guides/script-the-cli/),
  [launch a detached run](/guides/launch-a-detached-run/),
  [diagnose a run](/guides/diagnose-a-run/),
  [serve the workspace gateway](/guides/serve-the-workspace-gateway/),
  [wire the MCP server into an agent](/guides/wire-the-mcp-server/), and
  [embed the command tree](/guides/embed-the-command-tree/).
- [The CLI reference](/reference/cli/): every verb, and the three
  that start a run in depth.
- [Troubleshooting](/troubleshooting/): the refusals this CLI prints, and
  what to change.
