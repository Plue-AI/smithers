# @smthrs/mcp

## [Unreleased]

### Changed

- Enforce a fixed 128-container JSON nesting limit, including the wire envelope,
  before recursive consumers; reject incoming numeric overflow. Bound argument
  expansion before copying shared-reference trees, require an object argument
  root, and reject unsafe-integer limit options. Violations are typed failures.
- Deep-freeze the public catalog and schemas so caller edits cannot change
  subsequent tool dispatch or validation. Copy them before making local edits.
- **Breaking error prose:** session errors no longer echo child stderr, spawn
  details, remote error text/data, invalid protocol versions, duplicate tool
  names, cursors, or argument/result property paths. Stable `McpError` codes and
  remote numeric error codes remain available. Successful tool output is unchanged.

### Added

- Optional `Diagnostics.layer(report)` for trusted local host inspection.
  Details are bounded to 16 KiB UTF-8 and wrapped in `Redacted`; JSON/log
  inspection does not expose them. No implicit raw logging, and callback
  failures cannot fail the connection. Hosts own access, retention, and any
  explicit unwrapping.

### Fixed

- Stderr diagnostics are redacted one complete line at a time before the
  `maxStderrBytes` cap. Capping raw bytes first could cut a credential's
  recognizable prefix and hand its remainder to the private diagnostic observer
  unredacted. A stderr line longer than 64 KiB is withheld whole.

- Distinguish inbound server requests from notifications. Reply to `ping` with
  an empty result and unsupported methods with `-32601`, preserving exact ids
  independently of active client requests. Server responses obey the outbound
  frame, queue, and admission-deadline bounds.
- Keep a timed-out request's cancellation notification best-effort, dropping
  it when the bounded outbound queue is full instead of blocking past the
  deadline it reports.
- Snapshot tool arguments through guarded property descriptors. Accessors are
  never invoked, proxy reflection failures remain typed `McpError` failures,
  and non-enumerable properties are omitted like `JSON.stringify`.
- Point the package README at mcp.smithers.sh. The Markdown files under
  `docs/` stay out of the published tarball.
- Require every tool `inputSchema` to declare `type: "object"`, and reject C1
  control characters in tool names alongside C0 controls and U+007F.
- Drop stdout that does not claim JSON-RPC as server log noise, while closing
  the connection when a tagged envelope has the wrong version or is missing a
  reply id.
- Map a server's explicit `-32601` or `-32602` unknown-tool rejection to
  `tool_not_found` while retaining `tool_failed` for ordinary tool failures.
- Validate `structuredContent` against the tool's declared `outputSchema` for
  the supported `type`, `required`, `properties`, `items`, and `enum` subset,
  and accept structured-only results with an empty `content` array.
- Freeze the exported client identity and supported protocol revision list so
  consumers cannot mutate later initialization frames.

## [1.0.0-rc.0] - 2026-09-01

### Added

- Added `@smthrs/mcp`: a stdio MCP client (`McpClient`) and a
  `FlowBinding.Source` projector (`McpFlows`) that turns a connected server's
  tool catalog into one flow per tool, so an MCP tool call is an ordinary flow
  call with no second registration path alongside `@smthrs/std`'s filesystem and
  shell flows.
- Added negotiation of the `initialize` result: the server's `protocolVersion`
  must be one this client decodes and its `capabilities.tools` must be present
  before the handshake completes.
- Added `tools/list` pagination, following `nextCursor` across pages under a
  page cap, with duplicate names rejected across the whole catalog.
- Added bounds on what an untrusted server can size: `maxTools`,
  `maxToolNameBytes`, `maxCatalogPages`, `maxOutboundFrameBytes`, and
  `maxStderrBytes`, each with an exported default constant.
- Added `include`, `exclude`, and `namePrefix` projection options so a host
  chooses which of a server's tools reach the model and under what names.
- Added `notifications/cancelled` for a timed-out or interrupted `tools/call`,
  so remote work declared `irreversible` is not abandoned mid-flight.
- Added pass-through of MCP 2025-06-18 structured tool output: a tool's
  `outputSchema` on `ToolDescription` and `structuredContent` on `ToolResult`
  and on the flow's own `Result` schema.
- Added package-owned documentation under `docs/`, generated into
  `docs/reference.md` by `scripts/docs.mjs`.

### Changed

- Declare authority as one exact `namespace:operation:resource` string per
  `Capability.Action`, derived from `Capability.Action.literals` and frozen. The
  bare `"*"` this module used to declare parsed as nothing, and an unparseable
  declaration is treated as unauthorized, so every MCP tool was refused with
  `capability_refused` before it ran even under an unrestricted envelope.
- Close the stdio transport without racing a separate terminal signal.
- Identify to remote servers as `smithers` at this package's version rather than
  as `flows` at `0.1.0`.
- Drain the child's stderr into a bounded tail and append it to `spawn_failed`,
  `timeout`, and `connection_closed` messages, so a startup failure explains
  itself instead of surfacing as an unexplained handshake deadline.

### Fixed

- Merge `env` into the inherited child environment instead of replacing it. A
  server spawned with a credential received no `PATH`, so the canonical
  `{ command: "npx", env: { TOKEN } }` entry failed to spawn at all.
- Validate every JSON-RPC envelope before correlating it: a reply must carry a
  valid id and exactly one of `result` or `error`, and an error must carry an
  integer code and a string message. An `error: null` reply used to kill the
  reader fiber and hang every pending request until its deadline.
- Map a JSON-RPC error by the method that failed, keeping the numeric code in
  the message, instead of reporting every failure as `tool_failed`.
- Decode `tools/list` and `tools/call` payloads instead of casting them. A
  `null` catalog entry used to throw a `TypeError` out of the declared error
  channel, a non-object content block used to surface as a flow-authored schema
  failure that named no server, and a missing `inputSchema` used to be
  fabricated rather than rejected.
- Reject duplicate tool names at the adapter. A server that repeated a name used
  to fail the host's entire flow catalog, including flows unrelated to MCP.
- Snapshot tool arguments to plain JSON before a request id is registered, so a
  getter, a proxy, a cycle, or a non-finite number fails with a typed error and
  a bounded path instead of a defect.
- Bound the `notifications/initialized` step by `handshakeTimeoutMs` rather than
  by the 120 second tool-call deadline.
