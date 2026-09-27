---
title: "Wire the MCP server into an agent"
description: "Connect the canonical MCP command surface and keep approval decisions independent."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/docs/guides/wire-the-mcp-server.md"
---

`smthrs --mcp` serves the Smithers MCP server on stdio, over the same control
plane the verbs use. An agent can inspect flows, plan work, execute an already
approved plan, and observe runs. Approval decisions are excluded by default.

## Register it

```bash
smthrs mcp add --agent claude
smthrs mcp add --agent codex
smthrs mcp add                  # every agent it knows
```

`--agent` is a flag, not a positional argument. `mcp add` writes an
`mcpServers` entry named `smithers` into the agent's own configuration:

| Agent | File |
| --- | --- |
| `claude` | `~/.claude.json` |
| `codex` | `~/.codex/mcp.json` |

`smthrs mcp add` with no `--agent` wires every agent it knows. An unknown agent
name is a usage error that lists the known ids. `smthrs mcp` on its own prints
the group's help; `add` is its only subcommand.

The entry records the current executable and entry path verbatim, not a package
runner. An installed CLI therefore registers its own installed path, and a
local development install registers itself. Smithers 0.x registered
`bunx smthrs --mcp`, which silently pointed every agent at the last published
build.

The write is a temp-file-plus-rename under a lock file, with the original
file's mode preserved, so a crash mid-write cannot leave a half-written
configuration. The lock names the process holding it, so one left by a process
that has since died is reclaimed rather than blocking every later run. If the file already holds the exact entry, nothing is written
and the result says `unchanged`. Add `--json` for one array of registration results,
with `agent`, `path`, and `status` fields. Registration does not open a workspace
database. If every target fails, the command prints
manual instructions to stderr and exits 1.

## Serve it by hand

```bash
smthrs --mcp
```

`--mcp` is a mode, not a verb, because every MCP client configures a launch
command rather than a subcommand. The flag is read from the raw argument vector
before the command tree parses anything.

## Canonical tools and independent approval

The executable uses the unified command tree through Incur's MCP discovery
tools: `search_tools`, `get_tool_details`, `call_read_tool`, and
`call_write_tool`. Discover canonical names such as `flow_list`, `flow_plan`,
`flow_execute`, `runs_show`, and `approvals_list`; fetch their schema before
invoking them. Every command declares `readOnlyHint`: call a `true` tool such
as `flow_list` or `runs_show` through `call_read_tool`, and a `false` tool such
as `flow_plan`, which records the plan and its approval token, through
`call_write_tool`. A local `flow_list` reads the discovery snapshot and opens no
project database.

`approvals_approve`, `approvals_deny`, and `flow_start` are absent from both
discovery and dispatch. `flow_start` is excluded because it implicitly approves
the plan. The operator can instead review the payload and use
`smthrs approvals approve` or `smthrs approvals deny` locally. An agent can then
execute the approved plan. Changing `--audience` changes presentation, not
approval authority. MCP invocations carry the local actor `mcp/agent`.

This is an approval boundary, not an operating-system sandbox. Do not grant
arbitrary host shell, code execution, or database write access to an actor that
must not bypass a human gate.

## The other direction

`--mcp-config <path>` is not this feature. It names a JSON array of MCP servers
that the local executor connects at startup and projects into a run's flow
catalog, so a flow can call them. The file is an array of
`{ server, command, args, cwd?, env?, handshakeTimeoutMs?, requestTimeoutMs?,
queueCapacity?, maxFrameBytes? }` entries. A path that is missing, unreadable,
malformed, or wrongly shaped is a usage error naming the flag, never a silent
change to the executor's tool catalog.

It is meaningless under `--remote`, where the executor is not this process's to
configure.

## See also

- [`smthrs mcp`](https://smithers.sh/docs/reference/cli/mcp/): the per-verb reference.
- [MCP setup](https://smithers.sh/docs/guides/mcp-setup/): the product guide.
- [`@smthrs/mcp`](https://mcp.smithers.sh/reference/api/): the client and the flow projection.
