/**
 * The single typed error returned by the MCP client and flow adapter.
 *
 * @since 1.0.0-rc.0
 */

import { Schema } from "effect"

/**
 * Stable, model-facing failure codes for MCP operations.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const Code = Schema.Literals([
  "spawn_failed",
  "connection_closed",
  "timeout",
  "protocol_error",
  "tool_not_found",
  "tool_failed",
  "invalid_response"
])

/**
 * Stable, model-facing failure codes for MCP operations.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Code = typeof Code.Type

/**
 * A recoverable MCP client or flow-adapter failure.
 *
 * Handlers keep ordinary tool outcomes (the remote tool's own `isError`
 * result) in the success channel; this error is reserved for failures of the
 * MCP session itself: the server would not exist, the pipe closed, a
 * response could not be parsed.
 *
 * Client-created messages withhold raw process/remote diagnostics and
 * user-controlled property paths. Trusted hosts can opt into Diagnostics for
 * bounded Redacted details. Successful tool output is not scrubbed.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class McpError extends Schema.TaggedError<McpError>()("flows/mcp/McpError", {
  code: Code,
  message: Schema.String,
  server: Schema.optional(Schema.String)
}) {}
