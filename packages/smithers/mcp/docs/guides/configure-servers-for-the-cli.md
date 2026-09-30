---
title: "Configure servers for the CLI"
description: "Write the --mcp-config file the Smithers CLI reads, know which fields it validates, and understand when a bad entry fails."
sidebar:
  order: 7
---

The CLI composes this package behind one flag. `smthrs --mcp-config <path>`
names a file of MCP servers that the local executor connects at startup and
projects into a run's flow catalog, so a flow can call them.

`SMITHERS_MCP_CONFIG` sets the same path. The flag wins when both are present,
and omitting both configures no MCP servers.

## Install the server

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

## The file

A JSON array. Each entry is a stdio server (`command`) or a Streamable HTTP
server (`url`), never both, plus `McpFlows.ProjectionOptions`:

```json
[
  {
    "server": "github",
    "command": "/path/to/mcp-servers/node_modules/.bin/mcp-server-github",
    "args": [],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." },
    "exclude": ["delete_repository"],
    "namePrefix": "github"
  },
  {
    "server": "reports",
    "command": "node",
    "args": ["./tools/reports-server.mjs"],
    "cwd": "/srv/reports",
    "requestTimeoutMs": 30000
  }
]
```

By default, tools arrive as flows named `mcp/<server>/<tool>`. With the custom
`namePrefix` above, GitHub tools arrive as `github/<tool>`.

## Remote servers

A remote server takes a `url` instead of a `command`. Its bearer token is
never written in the file: `bearerTokenEnv` names the environment variable the
CLI reads it from.

```json
[
  {
    "server": "tracker",
    "url": "https://mcp.tracker.example/mcp",
    "bearerTokenEnv": "TRACKER_MCP_TOKEN",
    "namePrefix": "tracker"
  }
]
```

Export `TRACKER_MCP_TOKEN` from your secret store in the shell that runs
`smthrs`; never type the token on the command line.

Requests go through the host's egress client, so its proxy settings and
capability grants apply. A grant that denies `net:post` to the server's origin
stops the executor before the first request is sent.

## What the flag validates

The CLI decodes every stdio entry with `McpClient.ConnectOptionsSchema` and
every HTTP entry with `McpClient.HttpConnectOptionsSchema` before any layer is
built. A bad file is a usage error naming the flag and path.

A stdio entry:

| Field                                                               | Requirement                       |
| ------------------------------------------------------------------- | --------------------------------- |
| `server`, `command`                                                 | Required non-empty strings.       |
| `args`                                                              | Required array of strings.        |
| `cwd`                                                               | Optional non-empty string.        |
| `env`                                                               | Optional object of string values. |
| `handshakeTimeoutMs`, `requestTimeoutMs`                            | Optional positive integers.       |
| `queueCapacity`, `maxFrameBytes`, `maxOutboundFrameBytes`           | Optional positive integers.       |
| `maxStderrBytes`, `maxTools`, `maxToolNameBytes`, `maxCatalogPages` | Optional positive integers.       |
| `maxToolDocumentBytes`                                              | Optional positive integer.        |

An HTTP entry:

| Field                                                                      | Requirement                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `server`                                                                   | Required non-empty string.                                          |
| `url`                                                                      | Required absolute `http:` or `https:` URL without user or password. |
| `bearerTokenEnv`                                                           | Optional environment variable name, set and non-empty at startup.   |
| `handshakeTimeoutMs`, `requestTimeoutMs`, `maxFrameBytes`                  | Optional positive integers.                                         |
| `maxOutboundFrameBytes`, `maxTools`, `maxToolNameBytes`, `maxCatalogPages` | Optional positive integers.                                         |
| `maxToolDocumentBytes`                                                     | Optional positive integer.                                          |

Four failures are usage errors that name the path: the file is missing, it
cannot be read, it is not valid JSON, or it is not an array of entries accepted
by the schemas. For example, `maxTools: 0` fails here before connecting a server.
An unset `bearerTokenEnv` variable is a usage error naming the server and the
variable.

## Select and name tools

The CLI preserves these projection fields and passes them to
`McpFlows.connected`:

| Field        | Meaning                                                                   |
| ------------ | ------------------------------------------------------------------------- |
| `include`    | Optional array of exact tool names. Omitted or empty includes every tool. |
| `exclude`    | Optional array of exact tool names to drop, applied after `include`.      |
| `namePrefix` | Optional replacement for the default `mcp/<server>` flow-name prefix.     |

The checked projection constructor rejects an empty `namePrefix` before
spawning and unknown `include` names after reading the catalog. These are
projection errors, separate from the connection schema's file validation.

## When a bad server fails

Every configured server is connected when the executor starts, because naming it
in the file is an operator opting into it. A server that fails to spawn, is
denied by the egress grants, or refuses the handshake takes the executor down
loudly rather than leaving a run silently short of the tools it was configured
to have.

That is the right trade for a configured dependency and the wrong one for an
experiment. Try a new server in a scratch config before adding it to the one a
production run uses.

## The flag does nothing under --remote

Under `--remote`, the executor is not this process's to configure, so
`--mcp-config` is meaningless. Configure MCP servers where the executor actually
runs.

## The other direction

This flag is Smithers calling somebody else's tools. The reverse, an agent such
as Claude Code driving Smithers, is the Smithers MCP server: see
[`smthrs mcp`](/cli/mcp) and
[Wire the MCP server into an agent](/pkg/cli/guides/wire-the-mcp-server). The two
share a name and nothing else.

## Next

- [Bound an untrusted server](./bound-an-untrusted-server.md): what the numeric
  fields do.
- [Select the tools a run sees](./select-the-tools-a-run-sees.md): narrowing a
  large catalog and choosing a projection constructor.
