---
title: "Connect a server"
description: "Spawn an MCP server over stdio or reach a remote one over Streamable HTTP: the command or URL, credentials, the working directory, how env overlays a bootstrap allowlist, and which protocol revisions the handshake accepts."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/mcp/docs/guides/connect-a-server.md"
---

Use `McpClient.connect` when you want the session itself, and
`McpFlows.connected` when you want the session and its projected flows in one
step. Both take the same connection options and require a `Scope`, plus
`ChildProcessSpawner` for a `command` or `HttpClient` for a `url`.

Install a reviewed server version and its dependencies before supplying any
credentials. This example pins the deprecated GitHub server to `2025.4.8`;
review it for your use before running it. Use a dedicated directory, review and
retain `package.json` and `package-lock.json`, then install from that lockfile:

```bash
mkdir -p /path/to/mcp-servers
env -u GITHUB_TOKEN -u GITHUB_PERSONAL_ACCESS_TOKEN npm install --prefix /path/to/mcp-servers --package-lock-only --ignore-scripts --save-exact @modelcontextprotocol/server-github@2025.4.8
# Review the pinned package and lockfile before installing.
env -u GITHUB_TOKEN -u GITHUB_PERSONAL_ACCESS_TOKEN npm ci --prefix /path/to/mcp-servers --ignore-scripts
```

Both npm commands remove the GitHub credential variables from their environment.
Launch the installed executable directly and supply the token only in the
server's `env`. This server reads `GITHUB_PERSONAL_ACCESS_TOKEN`.

```ts
import { NodeServices } from "@effect/platform-node"
import * as McpClient from "@smthrs/mcp/McpClient"
import { Effect } from "effect"

const program = Effect.scoped(Effect.gen(function*() {
  const client = yield* McpClient.connect({
    server: "github",
    command: "/path/to/mcp-servers/node_modules/.bin/mcp-server-github",
    args: [],
    cwd: "/path/to/repo",
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN }
  })
  return client.tools.map((tool) => tool.name)
}))

await Effect.runPromise(Effect.provide(program, NodeServices.layer))
```

## Connect a remote server over HTTP

Give `url` instead of `command` to reach a server that speaks MCP Streamable
HTTP. Requests go through the `HttpClient` in context, so compose the host's
egress client: its proxy and capability checks apply, and a URL the egress
policy denies fails with `connection_closed` before any request is sent.

```ts
import * as McpClient from "@smthrs/mcp/McpClient"
import { Effect, Redacted } from "effect"

const program = Effect.scoped(Effect.gen(function*() {
  const client = yield* McpClient.connect({
    server: "linear",
    url: "https://mcp.example.com/mcp",
    authProvider: { token: Effect.sync(() => Redacted.make(process.env.LINEAR_TOKEN ?? "")) }
  })
  return client.tools.map((tool) => tool.name)
}))
```

`authProvider.token` runs once per HTTP message and is sent as
`Authorization: Bearer`, so a provider may refresh it between messages. The URL
itself must not carry credentials.

The session id the server issues at `initialize` is sent with every later
message, and closing the scope ends the session with a `DELETE`. A server that
answers `404` for an established session has ended it: the call fails with
`connection_closed` and is not replayed, so reconnect to continue. This client
does not open the optional server-initiated `GET` stream or resume a broken
event stream.

## Name the server

`server` is not cosmetic. It is the default flow-name prefix (`mcp/<server>`)
and it appears in every error message this package produces. Pick the name you
want a model to read, and keep it stable: changing it renames every flow the
server offers.

## Scope the connection

`connect` is a scoped effect because it owns a subprocess or an HTTP session. Compose it once,
where the host composes its other scoped services, and let the scope's lifetime
be the session's lifetime.

Do not wrap each call in its own scope. Reconnecting per call pays the handshake
and the catalog walk every time, and it discards the snapshot the projected flow
declarations were derived from.

## Set the working directory

`cwd` is passed to the child process unchanged. A server that resolves paths
relative to its own directory needs it; most do.

## Declare the server environment

The child inherits only `PATH`, `HOME`, `USER`, `LANG`, `LC_*`, `TERM`,
`TMPDIR`, and `SHELL`. This keeps a bare executable such as `node` resolvable
without exposing every provider credential held by the Smithers process.
`env` values are explicit declarations applied on top of that bootstrap set.

```ts
// The child gets the bootstrap environment plus GITHUB_PERSONAL_ACCESS_TOKEN.
env: {
  GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN
}
```

A credential-shaped name is delivered when it appears in `env`, because the
declaration is the caller's explicit authority for this server. Undeclared
ambient names are withheld.

## Know which revisions the handshake accepts

`McpClient.supportedProtocolVersions` is frozen and always proposes
`2025-06-18` first:

```ts
;["2025-06-18", "2025-03-26", "2024-11-05"]
```

The server answers with the revision it chose. Any answer outside that list
fails with `protocol_error` naming both sides, because this client decodes the
`tools/list` and `tools/call` shapes of those three revisions and cannot
honestly claim a fourth.

The server must also declare a `tools` capability in its `initialize` result. A
server that serves only resources or prompts is refused: this package projects
tools and nothing else.

## Identify yourself

Every connection discloses the frozen `McpClient.clientInfo`: `name` is
`"smithers"` and `version` is this package's version.

It is not configurable. A server that varies its behavior by client should see
one honest answer.

## Choose the deadlines

The handshake and later tool calls have separate deadlines, because they are
different questions. `handshakeTimeoutMs` (10 seconds by default) bounds each
`initialize` and `tools/list` exchange, so a server that never answers fails
instead of hanging. `requestTimeoutMs` (120 seconds by default) bounds each
`tools/call`, where a slow answer is often a correct one.

For every other limit, see
[Bound an untrusted server](/guides/bound-an-untrusted-server/).

## Next

- [Select the tools a run sees](/guides/select-the-tools-a-run-sees/).
- [The life of a session](/concepts/the-session/): what happens after
  `connect` returns.
