---
title: "A remote tool as a flow"
description: "What McpFlows projects from a tool catalog: the flow name, the input document, the result shape, and the declaration every MCP tool flow shares."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/mcp/docs/concepts/tools-as-flows.md"
---

The whole adapter is one idea: a remote MCP tool is a flow declaration plus the
code that runs it, which is what every other flow already is. Nothing about the
harness, the registry, or the cell loop learns that a given flow proxies a
remote `tools/call`. A cell that reads a file and a cell that calls an MCP tool
run the identical two lines: find the flow in `ctx.flows`, invoke it with
`ctx.call`.

That is why this package is small. It is a client and a projector, not a second
capability system.

## What one tool becomes

`McpFlows.mcp` walks the catalog and produces one `FlowBinding.Binding` per
tool. Each binding declares:

| Field           | Value                                                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | `<prefix>/<tool>`, where the prefix defaults to `mcp/<server>`.                                                                                                             |
| `description`   | `MCP tool "<tool>" on server "<server>"`, followed by `. Server-supplied description: <text>` when the server sent one, so the model reads the text as the remote server's. |
| `input`         | `McpFlows.Args`, a permissive `Record<string, unknown>`.                                                                                                                    |
| `inputDocument` | The server's own `inputSchema` document, carried by value.                                                                                                                  |
| `output`        | `McpFlows.Result`: `content`, `isError`, and optional `structuredContent`.                                                                                                  |
| `capabilities`  | `McpFlows.capabilities`, the same frozen list for every tool.                                                                                                               |
| `effects`       | `McpFlows.effects`, the same conservative envelope for every tool.                                                                                                          |

The name is scoped by server so two servers may offer a tool of the same name
without colliding. A tool name may not contain `/`, which is what keeps
`mcp/<server>/<tool>` unambiguous.

## Two schemas, on purpose

The runtime decode and the disclosed parameter shape are different documents,
and the difference is deliberate.

`input` is `McpFlows.Args`, which accepts any string-keyed record. The adapter
does not validate arguments, because the remote server owns that decision: its
schema is the authority, and a second validator here would either duplicate it
or disagree with it.

`inputDocument` is the server's own JSON Schema, passed through unchanged. That
is what a caller reading `ctx.flows` sees, and what a model is shown. So the
model gets the real parameter shape while the boundary stays out of the
server's way.

This is why every catalog entry must declare an `inputSchema` whose `type` is
exactly `"object"`. A tool with no usable parameter document would be disclosed
to a model as if it had one, so the catalog is rejected at connect time
instead.

## A tool-level failure is data

A `tools/call` that reaches the server and comes back is a success, whatever it
says. MCP distinguishes "the call failed" from "the tool ran and reported a
problem", and the second one arrives as `{ isError: true }` on a successful
reply. The binding returns it in the success channel.

`McpError` is the other channel entirely, reserved for failures of the session:
the server would not start, the pipe closed, a reply could not be parsed.
The binding explicitly publishes `McpError.message` as a catchable
`flow_failed` result. The client authors this model-facing text with remote
error bodies and process diagnostics withheld. Custom clients must preserve
that public-message contract. See
[Handle a failed tool call](/guides/handle-a-failed-tool-call/).

## One declaration for every tool

Every projected flow declares the same authority and the same effects, because
an MCP tool is opaque code this adapter does not control. Guessing narrower
would be a claim nobody can back.

`McpFlows.effects` declares `reads: ["**"]`, `writes: ["**"]`,
`mode: "expected"`, `onConflict: "serialize"`, and `tier: "irreversible"`. The
irreversible tier is why a timed-out call sends a cancellation: an abandoned
in-flight mutation is a durability problem.

`McpFlows.capabilities` is one exact `namespace:operation:resource` string per
host action, at resource `**`, derived from `Capability.Action.literals`. It is
spelled out one action at a time rather than as a wildcard because the cell
boundary parses a declared capability with `Capability.parse`, which requires
exactly three colon-separated components. A bare `"*"` parses as nothing, and an
unparseable declaration counts as unauthorized, so a wildcard would refuse every
MCP tool before it ran, under every envelope including an unrestricted one.

Deriving the list rather than restating it means a new action in
[`@smthrs/capability`](https://capability.smithers.sh/reference/api/) cannot be silently dropped from what an
MCP tool declares.

The consequence for a host is that the projected declaration is a ceiling, not a
recommendation. Narrowing it is the host's decision and its own step; see
[Grant authority to MCP tools](/guides/grant-authority-to-mcp-tools/).

## Where the source goes

`FlowBinding.Source` is the same type `StandardFlows.filesystem` and
`StandardFlows.shell` return, so a projected server composes with them in one
array:

```ts
const catalog = yield * FlowBinding.catalog([
  StandardFlows.filesystem(filesystemServices),
  StandardFlows.shell(shellServices),
  mcpSource
])
```

Duplicate flow names fail composition rather than dispatching one descriptor to
another implementation, which is another reason the default prefix carries the
server name. For the harness side of this, see
[Bind flows](https://harness.smithers.sh/guides/bind-flows/).
