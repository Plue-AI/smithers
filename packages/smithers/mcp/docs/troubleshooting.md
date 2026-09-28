---
title: "Troubleshooting"
description: "The failures @smthrs/mcp reports, by the message you saw: startup, handshake, catalog, call, argument, limit, and capability problems, each with its cause and fix."
---

Every failure this package reports is an `McpError` carrying a stable code, the
server name, and a message. Find the message you saw. The full error schema is
on the [API reference](./api.md).

One failure is not an `McpError` at all, and it is the most common one: see
[capability_refused](#capability_refused) at the end.

## Failed to start MCP server "..."

**Code.** `spawn_failed`.

**What happened.** The process could not be started. Raw process details are
withheld. For local debugging, install a trusted
[Diagnostics observer](./api.md#diagnostics) before opening the connection.

**What to change.** Check that `command` is on the parent process's `PATH`, that
`cwd` exists, and that the entry file is readable. The child receives `PATH`
from the bootstrap allowlist even when `env` declares other names, so a wrong
`command` usually is the cause. For a server started through `npx`, run the same
command by hand first.

## ... speaks an unsupported protocol version; this client speaks ...

**Code.** `protocol_error`.

**What happened.** The server answered `initialize` with a revision outside
`McpClient.supportedProtocolVersions`, which is `2025-06-18`, `2025-03-26`, and
`2024-11-05`.

**What to change.** Upgrade or downgrade the server to a revision on that list.
The list is frozen: this client decodes the `tools/list` and `tools/call` shapes
of those three revisions and cannot claim a fourth.

## ... does not serve tools

**Code.** `protocol_error`.

**What happened.** The server's `initialize` result declared no `tools`
capability.

**What to change.** This package projects tools and nothing else. A server that
serves only resources, prompts, or sampling has nothing to project, and the
connection is refused rather than left useless.

## ... returned a malformed initialize result

**Code.** `protocol_error`.

**What happened.** The handshake result was not an object, its `protocolVersion`
was not a string, or its `capabilities` was not an object. The message names
which.

**What to change.** Fix the server's `initialize` reply. If it is not your
server, check whether it is writing something other than JSON-RPC to stdout on
startup; the reply itself must be one line of JSON.

## ... returned a tools/list result with no tools array

**Code.** `invalid_response`.

**What happened.** The catalog reply had no `tools` array. The nearby messages
`returned tools[N], which is not an object` and `returned tools[N] with no name`
cover the same class of defect one element deeper.

**What to change.** Fix the server's `tools/list` reply.

## ... returned a tool whose inputSchema is not a JSON Schema object of type "object"

**Code.** `invalid_response`.

**What happened.** A catalog entry's `inputSchema` was missing, was not an
object, or declared a `type` other than `"object"`.

**What to change.** Give every tool an `inputSchema` with `"type": "object"`.
The requirement is not pedantry: that document is disclosed to the model as the
tool's parameter shape, and a tool without one would be advertised as if it had
one. `outputSchema`, when present, must also be a JSON object.

## ... returned more than N tools, or more than N tools/list pages

**Code.** `invalid_response`.

**What happened.** The catalog exceeded `maxTools` (256 by default) or the
cursor walk exceeded `maxCatalogPages` (32 by default). The related message
`repeated a tools/list cursor` means the server sent a cursor it had
already sent, which would loop forever.

**What to change.** For a genuinely large server, raise `maxTools` or
`maxCatalogPages`, and narrow the projection with `include` so the model is not
shown hundreds of flows. For a repeated cursor, fix the server's paging. A
catalog is refused rather than truncated on purpose: a silently smaller toolset
is worse than a failed connection. See
[Bound an untrusted server](./guides/bound-an-untrusted-server.md).

## ... returned a tool name longer than N bytes, or that is "." or "..", or contains "/" or an invisible or control character

**Code.** `invalid_response`.

**What happened.** A tool name exceeded `maxToolNameBytes` (128 by default), or
was `.` or `..`, or contained `/`, a control character (C0, U+007F, C1), a
format character such as a zero-width or bidi mark, U+2028, U+2029, or a lone
surrogate.

**What to change.** Rename the tool on the server. The name is embedded in the
flow name `mcp/<server>/<tool>` and in the journal's declaration digest, so `/`
would make it ambiguous and an invisible or control character would make it
read as a different tool. `returned a duplicate tool name at catalog index N` is the same class: a duplicate makes the
flow name ambiguous.

## ... returned a tool description and inputSchema longer than N bytes

**Code.** `invalid_response`.

**What happened.** One tool's description plus its JSON-encoded `inputSchema`
exceeded `maxToolDocumentBytes` (65536 by default).

**What to change.** Shorten the tool's description or schema on the server, or
raise `maxToolDocumentBytes` for a server you trust. The text is authored by the
server and read by a model, so it is bounded like the rest of the catalog.

## ... did not answer METHOD within Nms

**Code.** `timeout`.

**What happened.** The deadline for that method expired.
`handshakeTimeoutMs` (10 seconds by default) bounds `initialize` and
`tools/list`; `requestTimeoutMs` (120 seconds by default) bounds `tools/call`.
The message indicates when a stderr diagnostic was withheld; it never echoes
the child's output.

**What to change.** For a slow tool, raise `requestTimeoutMs`. For a handshake
that never completes, inspect the private stderr diagnostic through a trusted
host observer: a server that reports a crash is not merely slow.

If the request was still queued, the writer skips it. If it was already handed
to the writer, one best-effort `notifications/cancelled` is sent, unless the
outbound queue is full or the method is `initialize`.

## MCP server "..." connection scope closed, stdout closed, stdin closed, or exited with code N

**Code.** `connection_closed`.

**What happened.** The session ended. Every request pending at that moment
failed with this one error, and every later request fails with it too. A clean
child exit ends stdout successfully, so an ordinary exit reads as "stdout
closed" or "exited with code N". Closing a healthy connection's scope reports
"connection scope closed" before I/O teardown can report "stdin closed".

**What to change.** "Connection scope closed" is usually the caller's own bug:
the scope was closed while a call was still running, or a client was used after
its `Effect.scoped` block returned. Hold the connection for the life of the
session rather than per call. For a server that exited on its own, inspect the
private stderr diagnostic through a trusted host observer.

## MCP frame exceeded N bytes

**Code.** `protocol_error`.

**What happened.** One inbound line exceeded `maxFrameBytes` (1 MiB by default).
The limit is inclusive and counts UTF-8 bytes, excluding the newline and an
optional preceding carriage return. Chunk boundaries do not affect the limit.
The stdout reader retains one bounded partial frame plus at most one pending
carriage return, so this also fires when a server writes too much output
without a newline. Each byte is scanned once and each frame is decoded once.

**What to change.** For a tool that genuinely returns megabytes, raise
`maxFrameBytes`. Otherwise check that the server terminates each JSON-RPC
message with a newline. The mirror message, `tried to send a METHOD frame larger
than N bytes`, means your own arguments exceeded `maxOutboundFrameBytes`.

## ... sent a malformed JSON-RPC reply

**Code.** `protocol_error`.

**What happened.** A line that claimed JSON-RPC by carrying a `jsonrpc` property
was not a valid reply: the wrong version, no id, an invalid id, neither `result`
nor `error`, both of them, or a malformed error object. This closes the connection.

Reply ids must be integers or canonical decimal strings. A valid error reply
with `id: null` is the exception: its details go to the private diagnostic
observer as `remote-error`, then it is dropped without closing the connection.
Pending requests still wait for their own replies or deadlines. A result with
`id: null` is malformed.

**What to change.** Fix the server's framing. Note what does **not** cause this:
a blank line, invalid JSON, a JSON scalar or array, and any object without a
`jsonrpc` property are treated as log noise and dropped, so ordinary server
logging on stdout is safe. Only a message that claims to be protocol traffic is
held to protocol rules.

## MCP option "..." must be a positive integer

**Code.** `protocol_error`.

**What happened.** A limit was zero, negative, or fractional. This is raised
before the process is spawned.

**What to change.** Pass a positive integer.

## MCP server "..." option "namePrefix" must not be empty

**Code.** `protocol_error`.

**What happened.** `McpFlows.connected` was given an empty prefix. This is
raised before the process is spawned.

**What to change.** Pass a non-empty `namePrefix`, or omit it to use
`mcp/<server>`.

## MCP server "..." has no requested tool

**Code.** `tool_not_found`.

**What happened.** `callTool` was given a name that is not in the catalog. The
check runs before any frame is written.

**What to change.** Read `client.tools` for the names the server actually
offers. Remember the catalog is a snapshot taken at connect time: a tool the
server added afterwards is not there until you reconnect. The variant
`offers no requested include tool` is the same mistake in
`ProjectionOptions.include`.

## ... failed tools/call (CODE); remote details withheld

**Code.** `tool_failed`, or `tool_not_found`.

**What happened.** The server answered the call with a JSON-RPC error rather
than a result. It becomes `tool_not_found` only when the JSON-RPC code is
`-32601` or `-32602` **and** the message combines the word `tool` with
`unknown`, `unrecognized`, `no such`, or `not found`. Everything else, including
an ordinary invalid-arguments rejection, is `tool_failed`.

**What to change.** Read the numeric code. Remote message text and data are
available only through the private diagnostic observer, not passed through to
the caller. A `tool_failed` from bad arguments means the model or the caller
sent a value the tool's `inputSchema` rejects.

Do not confuse this with a tool that ran and reported a problem. That comes back
as a **successful** call with `isError: true`. See
[Handle a failed tool call](./guides/handle-a-failed-tool-call.md).

## ... was sent a tool argument that is not JSON: REASON; property path withheld

**Code.** `protocol_error`.

**What happened.** The arguments contained something that cannot cross a JSON
boundary: a function, a symbol, a bigint, `undefined`, a non-finite number, a
cyclic reference, an object with a non-plain prototype, an accessor property, a
symbol-keyed property, or a `toJSON` method. The error names the reason but
withholds the path and value. A private diagnostic can identify the path without
re-evaluating an accessor or proxy.

**What to change.** Send plain JSON. Accessors are rejected rather than invoked,
so a getter that would have produced a fine value still fails; compute it before
the call.

## ... returned structuredContent that its own outputSchema rejects: REASON; property path withheld

**Code.** `invalid_response`.

**What happened.** The tool declared an `outputSchema` and returned
`structuredContent` that violates it, checked against the supported keyword
subset: `type`, `required`, `properties`, single-schema `items`, and `enum`.

**What to change.** Fix the server, which is disagreeing with its own published
contract. Unsupported keywords are ignored rather than enforced, so this is
never a false positive from a constraint the validator half-implements. See
[Validate structured output](./guides/validate-structured-output.md).

## ... returned a tools/call result with no content array

**Code.** `invalid_response`.

**What happened.** The result carried neither `content` nor
`structuredContent`, or its `content` was not an array.

**What to change.** Return at least one of them. A structured-only result is
valid and comes back with `content: []`.

## capability_refused

**Not an McpError.** This is the cell boundary refusing the call, and the tool
never ran.

**What happened.** Every projected flow declares `McpFlows.capabilities`, one
entry per host action at resource `**`. The refusal names the first declared
capability the run's envelope does not cover, which under a read-only envelope
is `fs:write:**`.

**What to change.** Do not widen the envelope to `*:*`. Re-declare the source's
flows under the authority you actually grant this server, and put that same
string in the run's envelope. The recipe is in
[Grant authority to MCP tools](./guides/grant-authority-to-mcp-tools.md).

## A duplicate flow name fails catalog composition

**Not an McpError.** `FlowBinding.catalog` refuses two sources that offer the
same flow name, rather than dispatching one descriptor to another
implementation.

**What to change.** The default prefix `mcp/<server>` keeps two servers apart, so
this usually means two entries share a `server` name, or a custom `namePrefix`
collides with another source. Give each server a distinct name.

## Recovering from connection setup failure

`McpClient.connect` and `McpFlows.connected` release the subprocess and I/O
fibers before returning a failed or interrupted setup attempt. This includes
negotiation, catalog, and projection validation failures. Catching failures or
retrying inside an open scope does not retain failed connections. Successful
connections remain open until the caller scope closes.
