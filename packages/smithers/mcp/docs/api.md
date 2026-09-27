---
title: "API reference"
description: "Every public export of @smthrs/mcp: sessions, limits, safe errors, private host diagnostics, and tool flow projections."
---

`@smthrs/mcp` exports four modules from its root entry point, and each is also
importable from `@smthrs/mcp/<Module>`:

```ts
import { Diagnostics, McpClient, McpError, McpFlows } from "@smthrs/mcp"
// or
import * as McpClient from "@smthrs/mcp/McpClient"
```

`@smthrs/mcp/internal/*` and `@smthrs/mcp/*/index` are not public, so the
JSON-RPC codec and the stdio transport are not importable.
`@smthrs/mcp/package.json` is exported.

`McpError` is a namespace under both import forms. The error class is
`McpError.McpError`.

For the flow-binding contract this package implements, see the
[`@smthrs/harness` reference](/api/harness). For the action vocabulary
`McpFlows.capabilities` is derived from, see the
[`@smthrs/capability` reference](/api/capability).

## Example

```ts
import * as McpFlows from "@smthrs/mcp/McpFlows"
import { Effect } from "effect"

const program = Effect.scoped(Effect.gen(function*() {
  const source = yield* McpFlows.connected({ server: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] })
  return yield* source.bindings()
}))
```

## McpClient

A minimal MCP client covering the `initialize` handshake, `tools/list`, and
`tools/call` over stdio. It is deliberately not a general MCP SDK: resources,
prompts, sampling, and roots are not wired up.

### McpClient.connect

```ts
const connect: (
  options: ConnectOptions
) => Effect.Effect<McpClient, McpError, ChildProcessSpawner | Scope.Scope>
```

Spawns the server, completes the handshake, and fetches its tool catalog once,
up front, following `nextCursor` across pages.

Requires `ChildProcessSpawner` and a `Scope`. The connection's lifetime is the
scope's lifetime: closing the scope tears the process down, and every request
pending at that moment fails with `connection_closed`.

Fails with `spawn_failed` when the process will not start, `protocol_error` when
an option is invalid or negotiation fails, and `invalid_response` when the
catalog breaks one of the rules in
[Bound an untrusted server](./guides/bound-an-untrusted-server.md).

### McpClient.McpClient

A live session.

```ts
interface McpClient {
  readonly server: string
  readonly tools: ReadonlyArray<ToolDescription>
  readonly callTool: (
    name: string,
    args: Record<string, unknown>
  ) => Effect.Effect<ToolResult, McpError>
}
```

| Member     | Meaning                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server`   | The name this session was connected under. It is the default flow-name prefix and appears in every error message.                                                         |
| `tools`    | The catalog as fetched at connect time, in the order the server listed it. A snapshot: this client never re-polls it.                                                     |
| `callTool` | Calls one catalogued tool. An unknown name fails with `tool_not_found` before a JSON-RPC frame is written. Declared structured output is validated before it is returned. |

### McpClient.ToolDescription

One remote tool as the server describes it.

| Field          | Type                                   | Meaning                                                                    |
| -------------- | -------------------------------------- | -------------------------------------------------------------------------- |
| `name`         | `string`                               | The tool's name. Never empty, never containing `/` or a control character. |
| `description`  | `string \| undefined`                  | The server's description, when it sent a string.                           |
| `inputSchema`  | `Record<string, unknown>`              | The tool's parameter shape, a JSON Schema document with `type: "object"`.  |
| `outputSchema` | `Record<string, unknown> \| undefined` | The tool's structured result shape, when the server disclosed one.         |

### McpClient.ToolResult

The result of one `tools/call`.

| Field               | Type                                     | Meaning                                                                                           |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `content`           | `ReadonlyArray<Record<string, unknown>>` | The tool's content blocks, passed through by shape. `[]` for a structured-only result.            |
| `isError`           | `boolean`                                | Whether the tool reported a problem. A successful call may carry `true`; this is not a failure.   |
| `structuredContent` | `Record<string, unknown> \| undefined`   | The tool's structured result, validated against its declared `outputSchema` when it declared one. |

### McpClient.ConnectOptions

| Field                   | Type                                               | Meaning                                                                                                   |
| ----------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `server`                | `string`                                           | The name this server is known by, for flow naming and error messages. Required.                           |
| `command`               | `string`                                           | The executable to spawn. Required.                                                                        |
| `args`                  | `ReadonlyArray<string>`                            | Its arguments. Required.                                                                                  |
| `cwd`                   | `string \| undefined`                              | The child's working directory.                                                                            |
| `env`                   | `Record<string, string \| undefined> \| undefined` | Values overlaid on the bootstrap child environment.                                                       |
| `handshakeTimeoutMs`    | `number \| undefined`                              | Deadline for each `initialize` and `tools/list` request. Default 10000.                                   |
| `requestTimeoutMs`      | `number \| undefined`                              | Deadline for each later tool request. Default 120000.                                                     |
| `queueCapacity`         | `number \| undefined`                              | Maximum outbound frames waiting to be written. Default 64.                                                |
| `maxFrameBytes`         | `number \| undefined`                              | Maximum UTF-8 bytes in one inbound JSON-RPC frame. Default 1048576.                                       |
| `maxOutboundFrameBytes` | `number \| undefined`                              | Maximum UTF-8 bytes in one outbound JSON-RPC frame. Default 1048576.                                      |
| `maxStderrBytes`        | `number \| undefined`                              | Maximum diagnostic stderr bytes retained in memory and rendered after credential redaction. Default 2048. |
| `maxTools`              | `number \| undefined`                              | Maximum tools accepted across every catalog page. Default 256.                                            |
| `maxToolNameBytes`      | `number \| undefined`                              | Maximum UTF-8 bytes in a tool name. Default 128.                                                          |
| `maxCatalogPages`       | `number \| undefined`                              | Maximum `tools/list` pages walked. Default 32.                                                            |

Every numeric field must be a positive safe integer. Anything else fails with
`protocol_error` naming the option, before the process is spawned.

The bootstrap child environment contains only `PATH`, `HOME`, `USER`, `LANG`,
`LC_*`, `TERM`, `TMPDIR`, and `SHELL`. Other ambient names are withheld;
entries in `env` are explicit declarations and are applied last.

### McpClient.ConnectOptionsSchema

```ts
const ConnectOptionsSchema = Schema.Struct({
  server: Schema.NonEmptyString,
  command: Schema.NonEmptyString,
  args: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.NonEmptyString),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  // every limit, each a positive integer
  handshakeTimeoutMs: Schema.optional(PositiveInteger)
  // ...
})
```

The authoritative decoder for a persisted MCP server entry. It requires
non-empty `server` and `command` strings, string `args`, an optional
string-valued `env` record, and positive integers for every limit. Use it
wherever connection options arrive from a file or a database.

### McpClient.clientInfo

```ts
const clientInfo: { readonly name: string; readonly version: string }
```

The frozen identity disclosed to every server during initialization:
`name` is `"smithers"` and `version` is this package's version. Not
configurable.

### McpClient.supportedProtocolVersions

```ts
const supportedProtocolVersions: ReadonlyArray<string>
```

The MCP revisions whose `tools/list` and `tools/call` shapes this client
decodes, frozen, always proposing the first entry:
`["2025-06-18", "2025-03-26", "2024-11-05"]`.

### Limit defaults

Each option's default is exported as a constant, so a caller can read or
adjust one without restating a literal.

| Constant                       | Value   | Option                  |
| ------------------------------ | ------- | ----------------------- |
| `defaultHandshakeTimeoutMs`    | 10000   | `handshakeTimeoutMs`    |
| `defaultRequestTimeoutMs`      | 120000  | `requestTimeoutMs`      |
| `defaultQueueCapacity`         | 64      | `queueCapacity`         |
| `defaultMaxFrameBytes`         | 1048576 | `maxFrameBytes`         |
| `defaultMaxOutboundFrameBytes` | 1048576 | `maxOutboundFrameBytes` |
| `defaultMaxStderrBytes`        | 2048    | `maxStderrBytes`        |
| `defaultMaxTools`              | 256     | `maxTools`              |
| `defaultMaxToolNameBytes`      | 128     | `maxToolNameBytes`      |
| `defaultMaxCatalogPages`       | 32      | `maxCatalogPages`       |

`McpClient.maxJsonDepth` is a fixed safety limit of **128 nested containers**,
including the JSON-RPC envelope. Arrays and objects each count as one container;
scalar values do not. Both incoming messages and outgoing arguments obey it.
An inbound violation closes the connection with `protocol_error`; invalid
arguments fail before dispatch without closing an otherwise healthy session.
Incoming JSON numbers that overflow to infinity are also rejected.

Before copying arguments, the client accounts for their expanded JSON size
against `maxOutboundFrameBytes`. Reusing the same object under several properties
does not bypass that accounting. The transport additionally checks the exact
UTF-8 size of the full encoded frame. Neither bound limits a caller's own
already-allocated input object or time spent in caller-provided Proxy traps.

## McpError

The single typed error returned by the client and the flow adapter. Ordinary
tool outcomes stay in the success channel; this error is reserved for failures
of the MCP session itself.

### McpError.McpError

```ts
class McpError extends Schema.TaggedError<McpError>()("flows/mcp/McpError", {
  code: Code,
  message: Schema.String,
  server: Schema.optional(Schema.String)
}) {}
```

| Field     | Type                  | Meaning                                                                                                                                                                             |
| --------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`    | `Code`                | The stable, model-facing failure code.                                                                                                                                              |
| `message` | `string`              | A fixed failure summary naming the configured server, with a remote numeric error code when available. No child stderr, remote error prose/data, or user-controlled property paths. |
| `server`  | `string \| undefined` | The server the failure belongs to.                                                                                                                                                  |

The tag is `"flows/mcp/McpError"`, so `Effect.catchTag("flows/mcp/McpError", ...)`
matches it.

### McpError.Code

```ts
const Code = Schema.Literals([
  "spawn_failed",
  "connection_closed",
  "timeout",
  "protocol_error",
  "tool_not_found",
  "tool_failed",
  "invalid_response"
])

type Code = typeof Code.Type
```

| Code                | Meaning                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `spawn_failed`      | The server process would not start.                                                              |
| `connection_closed` | The process exited or a pipe closed while a request was outstanding.                             |
| `timeout`           | The server did not answer within the deadline for that method.                                   |
| `protocol_error`    | Negotiation failed, an envelope was malformed, or an option was invalid.                         |
| `tool_not_found`    | The catalog lacks a tool, `include` names a missing tool, or the server rejects an unknown tool. |
| `tool_failed`       | The server rejected a `tools/call` with a JSON-RPC error.                                        |
| `invalid_response`  | A well-formed reply carried a `tools/list` or `tools/call` payload this client rejects.          |

For which JSON-RPC errors become which code, see
[Handle a failed tool call](./guides/handle-a-failed-tool-call.md).

## Diagnostics

Optional host-only diagnostics, separate from the model-facing `McpError`.
Install `Diagnostics.layer(report)` around the effect that opens the connection.
The connection captures that observer once. Without it, private details are
discarded rather than logged.

```ts
import { Diagnostics } from "@smthrs/mcp"

// A host-owned, bounded sink; this is not an agent or journal callback.
const privateDiagnostics = Diagnostics.layer((event) => {
  retainForLocalInspection(event)
})
```

`Diagnostics.Diagnostics` is the optional Context service. Its `report` callback
takes one `Diagnostics.Event`:

| Field       | Meaning                                                                        |
| ----------- | ------------------------------------------------------------------------------ |
| `server`    | The host-configured server alias. Do not put credentials in aliases.           |
| `source`    | `spawn`, `stderr`, `remote-error`, `invalid-response`, or `invalid-arguments`. |
| `detail`    | `Redacted.Redacted<string>`, at most 16 KiB of UTF-8. May contain secrets.     |
| `truncated` | Whether this event's private detail exceeded that 16 KiB bound.                |

Ordinary JSON serialization and inspection hide `detail`. A trusted local host
can explicitly unwrap it with `Redacted.value`; it must control access and
retention and must never forward that value to agents, journals, traces, or
routine logs. The callback is synchronous: it must not block or retain an
unbounded event history. Callback and serialization exceptions are isolated
from the MCP connection. Diagnostic delivery is best effort, not an audit log.
On process or stdio closure, pending requests wait up to 250 ms for the stderr
reader to finish before receiving the terminal error. Request deadlines and
scope interruption can end that wait sooner. A pipe held open beyond that
budget contributes only the tail already read; it cannot hold shutdown open.
The separate `maxStderrBytes` limit applies before the observer sees a stderr
tail, so `truncated: false` does not imply the entire child output is present.

This protects session errors, not successful tool output. `content`,
`structuredContent`, and tool-reported `isError: true` results remain unchanged;
the host must choose which tool outputs it may expose.

## McpFlows

Projects a connected session's tool catalog as an ordinary
`FlowBinding.Source`, one flow per tool.

### McpFlows.connected

```ts
const connected: (
  options: McpClient.ConnectOptions & ProjectionOptions
) => Effect.Effect<FlowBinding.Source, McpError, ChildProcessSpawner | Scope.Scope>
```

Connects and projects in one step. This is the checked entry point: it validates
the projection options against the freshly fetched catalog, failing with
`tool_not_found` when `include` names a tool the server does not offer, and with
`protocol_error` when `namePrefix` is empty.

### McpFlows.mcp

```ts
const mcp: (
  client: McpClient.McpClient,
  options?: ProjectionOptions
) => FlowBinding.Source
```

Projects an already-connected session. Total: it applies exact filters to the
catalog it is given and validates nothing.

The client is a precondition rather than a parameter this constructor resolves,
because connecting is scoped and a `Source` is not. A host composes
`McpClient.connect` once, where it composes its other scoped services, and
passes the live client here.

### McpFlows.ProjectionOptions

| Field        | Type                                 | Meaning                                                         |
| ------------ | ------------------------------------ | --------------------------------------------------------------- |
| `include`    | `ReadonlyArray<string> \| undefined` | Exact tool names to project. Omitted or empty means every tool. |
| `exclude`    | `ReadonlyArray<string> \| undefined` | Exact tool names to drop, applied after `include`.              |
| `namePrefix` | `string \| undefined`                | Replaces the default `mcp/<server>` flow-name prefix.           |

### McpFlows.Args

```ts
const Args = Schema.Record(Schema.String, Schema.Unknown)
```

The decoded input accepted by every MCP tool flow. It is permissive because the
remote server, not this adapter, owns argument validation. The registry still
discloses the real parameter shape: each binding carries the server's own
`inputSchema` as its input document.

### McpFlows.Result

```ts
const Result = Schema.Struct({
  content: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  isError: Schema.Boolean,
  structuredContent: Schema.optional(Schema.Record(Schema.String, Schema.Unknown))
})
```

The decoded output returned by every MCP tool flow. `structuredContent` is
absent, not null, when the tool sent none.

### McpFlows.capabilities

```ts
const capabilities: ReadonlyArray<string>
```

The authority every MCP tool flow declares: one exact
`namespace:operation:resource` string per host action, at resource `**`, derived
from `Capability.Action.literals` and frozen.

```ts
;[
  "fs:read:**",
  "fs:write:**",
  "net:get:**",
  "net:post:**",
  "model:call:**",
  "memory:read:**",
  "memory:write:**",
  "proc:spawn:**",
  "jj:status:**",
  "jj:diff:**",
  "jj:snapshot:**",
  "jj:restore:**",
  "jj:workspace-add:**",
  "jj:workspace-forget:**",
  "jj:root:**",
  "jj:revert:**",
  "jj:op-restore:**"
]
```

It is enumerated rather than written as a wildcard because the cell boundary
parses each declaration with `Capability.parse`, which requires exactly three
colon-separated components and treats anything else as unauthorized. Narrowing
this to what a host actually grants is the host's job; see
[Grant authority to MCP tools](./guides/grant-authority-to-mcp-tools.md).

### McpFlows.effects

```ts
const effects: Effects.Declaration // from @smthrs/core/Effects
```

The conservative effect envelope every MCP tool flow declares:

```ts
{
  reads: ["**"],
  writes: ["**"],
  mode: "expected",
  onConflict: "serialize",
  tier: "irreversible"
}
```

The irreversible tier is why an abandoned `tools/call` sends one
`notifications/cancelled` rather than being left in flight.
