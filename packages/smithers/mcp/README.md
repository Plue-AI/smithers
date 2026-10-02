# @smthrs/mcp

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://mcp.smithers.sh

Model Context Protocol client and flow adapter for Smithers.

`@smthrs/mcp` connects to an MCP server over stdio or Streamable HTTP and projects the tools that
server offers as flows a Smithers agent can call. `McpClient` speaks the
protocol: the `initialize` handshake, `tools/list`, and `tools/call`.
`McpFlows` turns the resulting catalog into one `FlowBinding.Binding` per tool,
so a cell calls a remote tool with the same two lines it uses for a filesystem
flow, and nothing downstream needs to know the difference.

## Install

`@smthrs/mcp` is not published to npm yet. Its source is on
[GitHub](https://github.com/smithersai/smithers).

It needs Node.js 26.4.0 or later, [`effect`](https://effect.website), and a
`ChildProcessSpawner`, which `@effect/platform-node` provides on Node. Not on npm yet; see [Installation](https://smithers.sh/docs/installation/).

## Connect a server and read its flows

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

```typescript
import { NodeServices } from "@effect/platform-node"
import * as McpFlows from "@smthrs/mcp/McpFlows"
import { Effect } from "effect"

const program = Effect.scoped(Effect.gen(function*() {
  const source = yield* McpFlows.connected({
    server: "github",
    command: "/path/to/mcp-servers/node_modules/.bin/mcp-server-github",
    args: [],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN },
    include: ["create_issue", "get_issue", "list_issues"]
  })
  const bindings = yield* source.bindings()
  return bindings.map((binding) => binding.descriptor.name)
}))

// [ "mcp/github/create_issue", "mcp/github/get_issue", "mcp/github/list_issues" ]
console.log(await Effect.runPromise(Effect.provide(program, NodeServices.layer)))
```

Each tool becomes a flow named `mcp/<server>/<tool>`. The connection's lifetime
is the scope's lifetime. The child inherits `PATH`, `HOME`, `USER`, `LANG`,
`LC_*`, `TERM`, `TMPDIR`, and `SHELL`; `env` explicitly adds or replaces names.
Other ambient variables, including provider credentials, are withheld.

Catalog tools must declare `inputSchema.type: "object"`. Structured-only tool
results are accepted with `content: []`, and declared `outputSchema` documents
are enforced for the supported keyword subset.

Session errors withhold raw child stderr, remote error text/data, and property
paths. An optional host-only [Diagnostics observer](https://mcp.smithers.sh/reference/api/#diagnostics)
provides credential-redacted `Redacted` details for explicit local inspection,
with child stderr bounded by `maxStderrBytes` (2048 by default). Successful tool
outputs, including `isError: true`, are returned unchanged.

Every projected flow declares the widest authority the capability vocabulary
can express, because an MCP tool is opaque code this package does not control.
Narrowing that declaration to what you actually grant a server is the host's
step, and the one thing standing between a projected source and a cell that can
call it.

This is the client half of Smithers and MCP: a Smithers run calling somebody
else's tools. The other half, an agent such as Claude Code driving Smithers, is
the Smithers MCP server behind `smthrs mcp`.

## Documentation

Full documentation is at [mcp.smithers.sh](https://mcp.smithers.sh):

- [Quickstart](https://mcp.smithers.sh/quickstart/): a real server in its own
  process, two tool calls, and the flows they project.
- [A remote tool as a flow](https://mcp.smithers.sh/concepts/tools-as-flows/):
  what the projection produces, and why nothing downstream knows the flow is
  remote.
- [Grant authority to MCP tools](https://mcp.smithers.sh/guides/grant-authority-to-mcp-tools/):
  the step between a projected source and a cell that can call it.
- [Configure servers for the CLI](https://mcp.smithers.sh/guides/configure-servers-for-the-cli/):
  the `--mcp-config` file the `smthrs` command line reads.
- [API reference](https://mcp.smithers.sh/reference/api/): every public export
  of `Diagnostics`, `McpClient`, `McpError`, and `McpFlows`.
- [Troubleshooting](https://mcp.smithers.sh/troubleshooting/): every failure
  this package reports, with its cause and fix.

## License

MIT. See [LICENSE](./LICENSE).
