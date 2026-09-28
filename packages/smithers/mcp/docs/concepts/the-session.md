---
title: "The life of a session"
description: "How an MCP session starts, what it holds, when it ends, and what happens to in-flight requests: the handshake, the catalog snapshot, scope-bound teardown, and cancellation."
sidebar:
  order: 2
---

An MCP session is a subprocess. Everything surprising about this package follows
from that: the process has to be started, negotiated with, bounded, and torn
down, and any of those steps can end the session in the middle of a call.

## Starting

`McpClient.connect` performs five steps before it returns, and a failure at any
of them fails the whole effect:

1. Spawn the command with `stdin`, `stdout`, and `stderr` piped. A spawn that
   fails is `spawn_failed`.
2. Send `initialize`, proposing `2025-06-18` and disclosing the frozen
   `McpClient.clientInfo` identity: name `"smithers"` and this package's
   version.
3. Validate the result. The server's `protocolVersion` must be one of
   `McpClient.supportedProtocolVersions`, and its `capabilities` must declare a
   `tools` object. A server that serves no tools is refused with
   `protocol_error` rather than connected and left useless.
4. Send `notifications/initialized`. This is a notification, not a request: the
   server never replies, and the handshake is not complete until the client
   sends it.
5. Walk `tools/list`, following `nextCursor` until the server stops sending one.

Steps 2 through 5 are each bounded by `handshakeTimeoutMs`, which defaults to 10
seconds and is separate from the deadline later tool calls get.

## Holding

What the session holds is small: the server name, the tool catalog, and a way to
call one entry of it.

The catalog is a **deeply frozen snapshot**, including tool entries and their
schemas. Editing the public catalog cannot change future dispatch or validation;
make a separate copy if a consumer needs a mutable view. It is fetched once and
never refreshed. A server
that later announces `notifications/tools/list_changed` is not re-polled, and
server-initiated notifications are received and dropped. To pick up a changed
catalog, close the scope and connect again.

That choice is what makes the projection stable. `McpFlows` derives flow
declarations from the catalog, and a declaration digest that changed underneath a
running cell would be refused by the boundary that recorded it.

`callTool` checks the name against that snapshot before it writes anything: an
unknown tool fails with `tool_not_found` without a JSON-RPC frame reaching the
server.

## Ending

The connection is scoped, and the scope is the lifetime. Closing it tears the
process down. Four other events end a session, and all five are the same
terminal transition:

| Event                        | The error every waiter gets                    |
| ---------------------------- | ---------------------------------------------- |
| The scope closes.            | `connection_closed`, "connection scope closed" |
| The child exits.             | `connection_closed`, "exited with code N"      |
| Its stdout reaches EOF.      | `connection_closed`, "stdout closed"           |
| Its stdin closes.            | `connection_closed`, "stdin closed"            |
| A tagged reply is malformed. | `protocol_error`, naming what was malformed    |

Whichever arrives first wins. It closes the connection once, fails every pending
request with that one error, and rejects all later traffic with the same error,
so a caller never waits on a reply that can no longer come. A clean child exit
is still a closed session: Node reports an ordinary exit by ending stdout
successfully. When a healthy connection's scope closes, its terminal reason is
recorded before I/O teardown, so cleanup does not report "stdin closed".

For `spawn_failed`, `timeout`, and `connection_closed`, the message withholds
process details. A child's stderr may contain credentials, including fragments
whose identifying prefix was removed by truncation. The bounded,
whitespace-collapsed tail is available only to an explicitly installed
[private host diagnostic observer](../api.md#diagnostics); it is never appended
to the ordinary error. Without that observer, private details are discarded.

## Noise and protocol traffic on stdout

MCP servers commonly log to stdout, so this client distinguishes noise from
protocol:

- A blank line, invalid JSON, a JSON scalar, an array, `null`, or a JSON object
  with no own `jsonrpc` property is **noise**, and is dropped.
- An object that does carry `jsonrpc` is **protocol traffic**. Its version must
  be exactly `"2.0"`. A valid method-bearing envelope without an id is a
  notification and is dropped; with an id it is a server request. Anything
  else must be a valid reply with an id and exactly one of `result` or `error`.

Server `ping` requests receive `{ result: {} }`, preserving the exact string or
integer id, including while a tool call is pending. Unsupported server methods
receive JSON-RPC `-32601` (`Method not found`); they are never silently dropped.
Server-request ids are independent of client-request ids. Reply frames use the
same outbound byte and queue bounds, with `requestTimeoutMs` limiting queue
admission; a blocked response closes the connection instead of hanging the
reader. This implements the negotiated
[MCP ping contract](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/ping).

A malformed tagged envelope closes the connection with `protocol_error`. A
well-formed reply for an id nobody is waiting on is dropped. The raw frame is
never attached to the error.

A valid error reply with `id: null` cannot be correlated to a request. Its code,
message, and data go only to the private diagnostic observer as `remote-error`,
then the reply is dropped. The connection stays open and pending requests keep
waiting for their own replies or deadlines. A null id on a result, or a malformed
error object with a null id, still closes the connection with `protocol_error`.

## Cancelling

Every MCP tool flow is declared `irreversible`, so an abandoned in-flight
mutation is a durability problem rather than a tidiness one. When a `tools/call`
times out or its fiber is interrupted before dispatch, the writer skips its
queued frame. Once handed to the writer, an abandoned request triggers one
best-effort `notifications/cancelled` for that request id.

The notification is best effort. A full outbound queue drops it rather than
delaying the deadline it reports, because a cancellation that made a timeout
late would defeat the timeout. `initialize` is never cancelled, and a request
that already received a reply, whether a result or a JSON-RPC error, is never
cancelled either.

## Next

- [Connect a server](../guides/connect-a-server.md): the options that shape all
  of this.
- [Bound an untrusted server](../guides/bound-an-untrusted-server.md): the ten
  limits and what each one protects.
