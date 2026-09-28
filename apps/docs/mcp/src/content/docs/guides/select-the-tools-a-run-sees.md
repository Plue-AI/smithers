---
title: "Select the tools a run sees"
description: "Narrow a server's catalog with include and exclude, rename the flow prefix with namePrefix, and choose between the checked and total projection constructors."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/mcp/docs/guides/select-the-tools-a-run-sees.md"
---

A fifty-tool server projects fifty flows, and every one of them is disclosed to
the model in its context window. `ProjectionOptions` narrows and renames the
projection before any descriptor exists, so the tools a run never needs cost it
nothing.

## Project only the tools you need

`include` is an exact-name allowlist. An omitted or empty `include` means every
tool:

```ts
const source = yield * McpFlows.connected({
  server: "github",
  // Installed with --ignore-scripts at an exact version; see Connect a server.
  command: "/path/to/mcp-servers/node_modules/.bin/mcp-server-github",
  args: [],
  include: ["create_issue", "get_issue", "list_issues"]
})
```

`exclude` is an exact-name blocklist, applied after `include`. Use it to keep a
mostly useful server's one dangerous tool out of reach:

```ts
const source = McpFlows.mcp(client, { exclude: ["delete_repository"] })
```

Both match exact names. Neither accepts a pattern, because a pattern that
matched a tool the server added later would widen the run's reach without
anybody deciding to.

Filtering happens in catalog order, so the projected flows keep the order the
server listed them in.

## Rename the prefix

`namePrefix` replaces the default `mcp/<server>` prefix for the source and every
flow in it:

```ts
namePrefix: "github"
```

Those three tools then become `github/create_issue`, `github/get_issue`, and
`github/list_issues`.

Two cautions. Duplicate flow names fail catalog composition, so a prefix shared
with another source is a composition error rather than a silent override. And
the default prefix is what keeps two servers offering a tool of the same name
apart, so a custom prefix has to stay unique on its own.

## Pick the constructor that fails the way you want

The two constructors differ in exactly one thing: whether the options are
checked against a real catalog.

| Constructor          | Shape                                            | Validates                                                                                                                                |
| -------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `McpFlows.connected` | `(ConnectOptions & ProjectionOptions) => Effect` | Fails with `tool_not_found` when `include` names a tool the server does not offer, and with `protocol_error` when `namePrefix` is empty. |
| `McpFlows.mcp`       | `(client, options?) => Source`                   | Nothing. It is total: it applies exact filters to the catalog it is handed.                                                              |

Use `connected` for a configured server, where a typo in `include` should stop
the run rather than quietly hand the model a smaller toolset than the operator
asked for. Use `mcp` when you already hold a client, which is the case in tests
and in a host that composed `connect` alongside its other scoped services.

```ts
// Checked: a typo in include fails here.
const source = yield * McpFlows.connected({ server, command, args, include: ["create_issue"] })

// Total: the client is a precondition, and the filters are applied as given.
const client = yield * McpClient.connect({ server, command, args })
const alsoSource = McpFlows.mcp(client, { include: ["create_issue"] })
```

The split exists because connecting is scoped and a `Source` is not. A host
composes `connect` once, at the same place it composes every other scoped
service, and passes the live client to `mcp`.

## Next

- [Grant authority to MCP tools](/guides/grant-authority-to-mcp-tools/): what a
  projected source still needs before a cell can call it.
- [Test against a server](/guides/testing/): `mcp` takes any object shaped like a
  client, which is the testing seam.
