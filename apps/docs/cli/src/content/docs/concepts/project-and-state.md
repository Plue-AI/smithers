---
title: "The project and its state"
description: "How an invocation decides which project it is running in, what lives under .flows/, and how the CLI reports Smithers 0.x state it finds beside a project."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/docs/concepts/project-and-state.md"
---

Every command that touches durable state resolves the same project root the
same way. Smithers 0.x's most reported operational surprise was two commands
in one repository disagreeing about which database they meant, so rc.0 makes
the decision once, before any layer is built, and hands the answer to every
handler as the `Project.ProjectRoot` service.

## How the root is resolved

`Project.root(explicit, cwd)` applies three rules in order:

1. An explicit `--root`, resolved against the invocation directory.
2. Otherwise the nearest ancestor that anchors a project.
3. Otherwise the invocation directory itself.

A directory anchors a project when it holds `.flows/`, or when it holds
`flows/` beside a `package.json`, `.git`, or `.jj`. The two rules differ
because `.flows/` is written by Smithers and nothing else, while `flows` is an
ordinary directory name: requiring a project marker next to a bare `flows/`
keeps the anchor on the directory a project actually starts at.

The upward walk stops at the repository root, inclusive, on `.git` or `.jj`.
Without that bound, a command run in a repository under `$HOME` would keep
climbing into the home directory, and rc.0 reads no global state at all.

## What lives under the root

| Path | What it holds |
| --- | --- |
| `flows/` | The flow sources this project discovers. One directory per flow. |
| `.flows/` | Everything Smithers writes. Add it to `.gitignore`; `smthrs init` does that for you in a repository. |
| `.flows/control.db` | The control plane: runs, plans, approvals, memory, and the journal. |
| `.flows/engine.db` | The durable engine: executions, attempts, cache entries, and wake state. |
| `.flows/logs/<run-id>.log` | One detached run's output. |

Embedded native hosts can set `Application.Config.stateRoot` outside the
checkout. The control and engine databases then live under
`<stateRoot>/.flows/`, with their WAL files, while discovery, grants, and run
workspace access remain rooted in the project. It defaults to `root` and has no
CLI flag. This keeps database writes from changing a live checkout's tree.

The two databases are separate files with separate connections and separate
migration ownership. `NodeControl.databasePath` and
`NodeControl.executionDatabasePath` are the database projections; other state
paths start with `Project.stateDirectory`. Workspace routing uses the same pure
projections through internal modules to avoid importing its NodeControl host.
Nothing assembles `.flows` paths at a call site.

Local control and operator commands share one database initialization layer.
On POSIX systems it restricts the state directory to `0700` before opening
SQLite, then restricts the control database and its WAL and shared-memory files
to `0600` before exposing the store. This also applies when `credentials add` or
a memory command creates the first state in a project, and when reopening state
with broader permissions.

Within one local invocation there is exactly one durable engine, and its SQLite
connection is shared by the control runtime, the journal, the run store, and
the memory store. Building those layers independently would open several
writers on one file.

`smthrs doctor` prints the resolved root, both database paths, and how many
migrations each file has recorded, which is the fastest way to confirm that a
command is acting on the project you think it is.

## Discovery

`NodeControl.layerRegistry` discovers flows from one source: `flows/` under
the project root, named by path. A project with no `flows/` directory simply
has no flows, and `smthrs flow list` says so. Any other discovery failure, such as an
unreadable root or a malformed entry, is a startup failure rather than a
silently empty catalog.

## Smithers 0.x state beside a project

rc.0 never loads a 0.x run database. It detects one so it can say so once
instead of failing obscurely later.

`Project.legacyMarkers` are the names it looks for: `.smithers`,
`smithers.db`, and that database's WAL and shared-memory files. Two different
questions are asked about them, and they are gated differently on purpose:

- **The notice.** `Project.legacyState` skips any directory that already holds
  `.flows/`, because a repository mid-migration would otherwise print the
  notice on every command forever. The sample is taken while the layers are
  still being described, before anything opens the control database, since
  opening it creates `.flows/` and would erase the very condition being tested.
- **The report and the refusal.** `Project.legacyDatabases` is not gated that
  way. The project an operator actually migrates has already run an rc.0
  command, so it already has `.flows/`, and gating there would answer "nothing
  to finish" for every real migration. `smthrs doctor` and `smthrs migrate`
  read this one.

The notice names the path, states that rc.0 does not load, resume, or migrate
0.x run databases, and tells you to finish or discard those runs with the 0.x
CLI before running `smthrs migrate` on the project source.

`smthrs migrate` resolves a different root again, `Project.legacyRoot`, which
anchors on the 0.x markers rather than on `.flows/`. That keeps
`migrate --apply` on the 0.x project holding those markers, even when it sits
inside a larger repository and carries no repository marker of its own.

## The environment

`Environment.names` is the closed set of `SMITHERS_*` variables rc.0 reads.
Anything outside it is not read, including the 0.x `SMITHERS_HOME`,
`SMITHERS_TOKEN`, and `SMITHERS_WORKFLOW_*` families.

| Variable | Meaning |
| --- | --- |
| `SMITHERS_REMOTE` | The control plane to act on. The environment form of `--remote`. |
| `SMITHERS_API_KEY` | Bearer credential. The environment form of `--credential`. |
| `SMITHERS_MCP_CONFIG` | Path to the `--mcp-config` server array. |
| `SMITHERS_BACKEND` | Database backend. Only `sqlite` is supported. |
| `SMITHERS_OPENAI_AUTH` | `api-key` or `chatgpt`, selecting how `openai` seats authenticate. |
| `SMITHERS_TEST_COMMAND`, `SMITHERS_TEST_CONTAINER`, `SMITHERS_TEST_CWD`, `SMITHERS_TEST_TIMEOUT_MS` | What the `test` flow runs, where, and for how long. |
| `SMITHERS_BASH_CONTAINER` | The one container `bash` may reach. Any other `bash` call fails with `outside_container`, and the host filesystem flows are not offered. |
| `SMITHERS_ASKS` | `park` or `refuse`, what an in-run `ask` does. Unset is `park`: the run waits for `smthrs approvals approve`. `refuse` is for a host nobody answers, such as a benchmark or CI lane: the ask fails at once with `ApprovalUnavailable` and the run continues. Any other value refuses to start. |
| `SMITHERS_MEMORY_DB` | Path of a separate SQLite file for the memory store. Runs that name the same file share one memory bank, and only then does the supervisor write accepted sentences to it. Without it, the bank is named after the workspace and the supervisor writes nothing. |
| `SMITHERS_SUPERVISOR_STANCE` | `careful` or `paranoid`, the stance a judged run is taught. Unset is `careful`; any other value refuses to start. |
| `SMITHERS_BUG_ENDPOINT` | Where `smthrs bug` posts its report. |
| `SMITHERS_JJ_PATH` | Explicit path to the `jj` binary. |
| `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` | Absolute `smithers-jj-export` path for the Node and Bun hosts' filesystem helper. Unset uses the packaged or source-checkout build. `PATH` is never searched. |
| `SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS` | How long `flow start -d` waits for its child's admission line. |
| `SMITHERS_INSIDE_RUN`, `SMITHERS_RUN_ID` | Set on an agent process by the engine. Both keep their 0.x meaning. |

## HTTP proxies

The native Node control host's model HTTP transport reads `http_proxy`,
`https_proxy`, and `no_proxy`, with `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`
as fallbacks. Lowercase values take precedence, including empty strings.
`no_proxy` selects destinations that bypass the proxy. With neither proxy URL
set, the host uses its direct dispatcher. Replacement connection pools apply
the same environment policy.

An empty value is treated exactly like an unset one, because an
exported-but-blank variable is how a shell spells "not configured".
`Environment.readInteger` requires the whole value to be digits, so `30s` and
`30abc` are ignored rather than read as 30.

Provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
and `CEREBRAS_API_KEY`) are not in this set. The seat resolver reads them, not
the CLI, and `smthrs doctor` reports which are present.
