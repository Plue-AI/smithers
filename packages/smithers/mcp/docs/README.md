---
title: "@smthrs/mcp"
description: "A Model Context Protocol client for Node, and the adapter that projects a remote server's tools into a Smithers run as ordinary flows named mcp/<server>/<tool>."
---

`@smthrs/mcp` connects to a Model Context Protocol (MCP) server over stdio or
Streamable HTTP and
projects the tools that server offers as flows a Smithers agent can call. It is
two halves: `McpClient`, a small JSON-RPC client covering the `initialize`
handshake, `tools/list`, and `tools/call`, and `McpFlows`, which turns a
connected session's catalog into one flow per tool.

## What it solves

MCP is how a service publishes tools to an agent: a GitHub server, a database
server, an internal service somebody on your team wrote. Calling one of those
from an agent run could have been a second kind of capability, with its own
dispatch, its own permission rules, and its own error type. It is not. This
package makes a remote tool an ordinary flow:

- Each tool becomes a flow named `mcp/<server>/<tool>`, so two servers may offer
  a tool of the same name without colliding.
- Each flow carries the server's own JSON Schema as its parameter document, so a
  model reading the catalog sees the real argument shape rather than a
  placeholder.
- A cell calls it with the two lines it already uses for a filesystem flow: find
  the name in `ctx.flows`, invoke it with `ctx.call`.

The client half is deliberately small. Resources, prompts, sampling, and roots
are not implemented, because a projection needs a tool catalog and a way to call
one entry of it, and nothing else.

## Install

`@smthrs/mcp` is not published to npm yet. Its source is on
[GitHub](https://github.com/smithersai/smithers).

It needs Node.js 26.4.0 or later. Opening a connection requires two services
from the caller's environment: Effect's `ChildProcessSpawner`, because an MCP
server is a subprocess, and a `Scope`, because closing the scope tears that
subprocess down. `@effect/platform-node` supplies the spawner on Node. For the
version requirements and the import forms, see
[Installation](./installation.md).

## Connect a server and read its flows

`McpFlows.connected` spawns the server, completes the handshake, fetches the
tool catalog, and returns the projection in one step:

```ts
import { NodeServices } from "@effect/platform-node"
import * as McpFlows from "@smthrs/mcp/McpFlows"
import { Effect } from "effect"

const program = Effect.scoped(Effect.gen(function*() {
  const source = yield* McpFlows.connected({
    server: "github",
    // A reviewed server installed at an exact version with --ignore-scripts.
    command: "/path/to/mcp-servers/node_modules/.bin/mcp-server-github",
    args: [],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN },
    include: ["create_issue", "get_issue", "list_issues"]
  })
  const bindings = yield* source.bindings()
  return bindings.map((binding) => binding.descriptor.name)
}))

console.log(await Effect.runPromise(Effect.provide(program, NodeServices.layer)))
```

```text
[ 'mcp/github/create_issue', 'mcp/github/get_issue', 'mcp/github/list_issues' ]
```

Three details in that program decide how the rest behaves:

- `Effect.scoped` owns the subprocess. The session lasts as long as the scope,
  and every request outstanding when it closes fails with `connection_closed`
  rather than hanging.
- `include` is an exact-name allowlist, checked against the catalog the server
  actually sent, so a typo fails the connection instead of quietly handing the
  model a smaller toolset. Omit it to project every tool.
- `env` is overlaid on a bootstrap allowlist (`PATH`, `HOME`, `USER`, `LANG`,
  `LC_*`, `TERM`, `TMPDIR`, `SHELL`), not on the full host environment, so a
  server receives only the credentials you declare. Install and pin the server
  before giving it one, as
  [Connect a server](./guides/connect-a-server.md) shows.

One step separates that source from a cell that can call it. Every projected
flow declares the widest authority the capability vocabulary can express,
because an MCP tool is opaque code this package does not control, and a host
narrows that declaration to the authority it actually grants the server. The
recipe is in
[Grant authority to MCP tools](./guides/grant-authority-to-mcp-tools.md).

## How this relates to the smithers CLI

`@smthrs/mcp` is one of the packages behind [`@smthrs/cli`](/api/cli), the
`smthrs` command line that plans, runs, and inspects Smithers flows. The CLI
composes this package for you: `smthrs --mcp-config <path>` reads a JSON array
of server entries, connects every one of them when the executor starts, and adds
their tools to the run's flow catalog. Each entry in that file is structurally an
`McpClient.ConnectOptions` with optional `include`, `exclude`, and `namePrefix`
projection fields. The flag supports filtering and renaming tools per server. See
[Configure servers for the CLI](./guides/configure-servers-for-the-cli.md).

Import the package directly when you embed Smithers in a program of your own, or
when you need to customize the projected capability declaration. The
projected `FlowBinding.Source` is the same type the standard flows return, so it
composes with them in one array; that contract belongs to
[`@smthrs/harness`](/api/harness).

The CLI also hosts the mirror image of this package, under a name close enough
to confuse.
`smthrs --mcp-config` is a Smithers run calling somebody else's tools;
[`smthrs mcp`](/cli/mcp) runs Smithers itself as an MCP server, so an agent such
as Claude Code can drive a control plane. For that direction, see
[Wire the MCP server into an agent](/pkg/cli/guides/wire-the-mcp-server).

## Where to go next

- [Installation](./installation.md): requirements, the services a connection
  needs, and the import forms.
- [Quickstart](./quickstart.md): a real server in its own process, two tool
  calls, and the flows they project.
- Concepts: [a remote tool as a flow](./concepts/tools-as-flows.md) and
  [the life of a session](./concepts/the-session.md).
- Guides: [connect a server](./guides/connect-a-server.md),
  [select the tools a run sees](./guides/select-the-tools-a-run-sees.md),
  [grant authority to MCP tools](./guides/grant-authority-to-mcp-tools.md),
  [handle a failed tool call](./guides/handle-a-failed-tool-call.md),
  [validate structured output](./guides/validate-structured-output.md),
  [bound an untrusted server](./guides/bound-an-untrusted-server.md),
  [configure servers for the CLI](./guides/configure-servers-for-the-cli.md),
  and [test against a server](./guides/testing.md).
- [API reference](./api.md): every export of `McpClient`, `McpError`, and
  `McpFlows`.
- [Troubleshooting](./troubleshooting.md): each failure this package reports,
  found by the message you saw.
