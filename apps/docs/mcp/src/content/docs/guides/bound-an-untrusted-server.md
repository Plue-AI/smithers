---
title: "Bound an untrusted server"
description: "The ten limits McpClient enforces on a remote server, their default values, what each one protects, and the rules a tool name must satisfy."
sidebar:
  order: 6
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/mcp/docs/guides/bound-an-untrusted-server.md"
---

The server sizes the frames it sends, the catalog it declares, and the flow
names a model reads. All three are inputs from a process you do not control, so
every one of them is bounded, and every bound is an option with an exported
default constant.

You rarely need to change these. Read this page when a real server trips one, or
when you are deciding what to allow a server you do not trust.

## The ten limits

| Option                  | Default | Constant                                 | What it bounds                                      |
| ----------------------- | ------- | ---------------------------------------- | --------------------------------------------------- |
| `handshakeTimeoutMs`    | 10000   | `McpClient.defaultHandshakeTimeoutMs`    | Each `initialize` and `tools/list` exchange.        |
| `requestTimeoutMs`      | 120000  | `McpClient.defaultRequestTimeoutMs`      | Each later `tools/call` exchange.                   |
| `queueCapacity`         | 64      | `McpClient.defaultQueueCapacity`         | Outbound frames waiting to be written.              |
| `maxFrameBytes`         | 1048576 | `McpClient.defaultMaxFrameBytes`         | One inbound JSON-RPC frame, in UTF-8 bytes.         |
| `maxOutboundFrameBytes` | 1048576 | `McpClient.defaultMaxOutboundFrameBytes` | One outbound JSON-RPC frame, in UTF-8 bytes.        |
| `maxTools`              | 256     | `McpClient.defaultMaxTools`              | Tools accepted across every catalog page.           |
| `maxToolNameBytes`      | 128     | `McpClient.defaultMaxToolNameBytes`      | UTF-8 bytes in one tool name.                       |
| `maxToolDocumentBytes`  | 65536   | `McpClient.defaultMaxToolDocumentBytes`  | One tool's description plus JSON `inputSchema`.     |
| `maxCatalogPages`       | 32      | `McpClient.defaultMaxCatalogPages`       | `tools/list` pages walked while following a cursor. |
| `maxStderrBytes`        | 2048    | `McpClient.defaultMaxStderrBytes`        | Child stderr retained as a diagnostic tail.         |

Every one must be a positive safe integer. A zero, a negative number, a fraction,
or a number above `Number.MAX_SAFE_INTEGER`
fails with `protocol_error` naming the option, before the process is spawned.

```ts
const client = yield * McpClient.connect({
  server: "large",
  command: "node",
  args: ["server.mjs"],
  maxTools: 512,
  maxFrameBytes: 4 * 1024 * 1024
})
```

## What each one is actually protecting

**The two frame sizes** protect memory. The stdout reader never retains more
than one bounded partial frame, so a server that writes a gigabyte without a
newline fails at the limit rather than growing the heap. The outbound bound
catches the mirror case: a tool argument large enough to be its own problem is
refused before it is written.

**`queueCapacity`** bounds outbound frames waiting on a server that has stopped
reading its stdin. Past capacity, an offer blocks until the deadline for that
request expires.

**`maxTools`, `maxToolNameBytes`, `maxToolDocumentBytes`, and
`maxCatalogPages`** bound the catalog, which is the part a model reads.
`maxToolDocumentBytes` counts the UTF-8 bytes of a tool's description plus its
JSON-encoded `inputSchema`, so one tool cannot flood the model's context with
server-authored text. A catalog past `maxTools` fails with
`invalid_response` rather than being truncated, because a silently truncated
toolset is worse than a refused connection. `maxCatalogPages` and a repeated
cursor both end a cursor walk that would otherwise never finish.

**`maxStderrBytes`** bounds a diagnostic buffer. Child stderr is drained
continuously and only the tail is retained, so a chatty server cannot fill
memory through the channel that exists to explain its failures.
The tail never enters an ordinary error. Only an explicitly installed
[private diagnostic observer](/reference/api/#diagnostics) may receive it, wrapped in
`Redacted`. This per-event bound does not bound memory retained by a host's own
observer; that observer must also limit its history.

**The two deadlines** are separate because they answer different questions. A
server that never completes a handshake is broken and should fail fast; a tool
that takes a minute may be working.

## JSON depth and expansion

Bytes alone do not make recursive consumers safe. All incoming JSON-RPC messages
are checked iteratively before catalog/result validation, and may contain at
most `McpClient.maxJsonDepth` (128) nested object/array containers, counting the
wire envelope. This bound is fixed, not increased by raising `maxFrameBytes`.
Outgoing arguments have the same bound: their root object already counts as
container three, inside the envelope and `params`. A scalar adds no container.
An oversized depth or numeric overflow to infinity is a typed `protocol_error`,
not a stack-overflow defect.

Argument copying also stops when a lower bound on its expanded encoded size
exceeds `maxOutboundFrameBytes`. A compact JavaScript graph with shared children
can expand exponentially as JSON; each repeated occurrence consumes the budget.
Exact UTF-8 frame sizing, including escapes and protocol overhead, still runs
before writing. The argument root must be a JSON object. A rejected argument
does not send a request or close the session.

The host still owns memory it allocated before calling this library and any
executable Proxy traps it supplies. Incoming frames are parsed before the
iterative depth check, with parse allocation bounded by `maxFrameBytes`; this is
not a constant-memory streaming JSON parser.

## The rules a tool name must satisfy

Beyond the byte length, a tool name may not contain:

- `/`, because the name is embedded in `mcp/<server>/<tool>`.
- A control character (Unicode category Cc): C0 (U+0000 through U+001F),
  U+007F, and C1 (U+0080 through U+009F).
- A format character (Unicode category Cf), which includes zero-width marks
  (U+200B through U+200F, U+2060, U+FEFF), bidi overrides and isolates
  (U+202A through U+202E, U+2066 through U+2069), and the soft hyphen.
- U+2028 or U+2029, the line and paragraph separators.
- A lone UTF-16 surrogate.

The name also may not be exactly `.` or `..`, which read as path segments.

A name that breaks any of these fails the connection with `invalid_response`.
The name reaches a model inside a flow name and the journal inside a declaration
digest. An invisible or reordering character would let one tool read as another
to the model or to a person reviewing an approval, so none of these is cosmetic.

Two tools with the same name in one catalog also fail: a duplicate would make
`mcp/<server>/<tool>` ambiguous.

## The rules a catalog entry must satisfy

- `tools` must be an array, and every element an object.
- `name` must be a non-empty string.
- `inputSchema` must be an object whose `type` is exactly `"object"`. A tool
  with no usable parameter document is refused rather than disclosed to a model
  as if it had one.
- `outputSchema`, when present, must be a JSON object.
- `nextCursor`, when present, must be a non-empty string, and must not repeat a
  cursor already seen.

## Persisting a configuration

`McpClient.ConnectOptionsSchema` is the authoritative decoder for a stored
server entry. It requires a non-empty `server` and `command`, string `args`, a
string-valued `env` record, and positive integers for every limit:

```ts
import * as McpClient from "@smthrs/mcp/McpClient"
import { Schema } from "effect"

const decode = Schema.decodeUnknownSync(McpClient.ConnectOptionsSchema)
const options = decode(JSON.parse(fileContents))
```

Use it wherever connection options arrive from a file or a database, so a bad
entry is a decode failure at the edge rather than a `protocol_error` at connect
time. See
[Configure servers for the CLI](/guides/configure-servers-for-the-cli/).

## Next

- [The life of a session](/concepts/the-session/): what the limits are
  protecting.
- [Troubleshooting](/troubleshooting/): the message each limit produces.
