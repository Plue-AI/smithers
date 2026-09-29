/**
 * The request/notify surface both MCP transports provide, and the failure
 * wording they share. {@link McpClient} speaks to this interface only; stdio
 * and Streamable HTTP differ in how a frame travels, not in what it means.
 *
 * @since 1.0.0-rc.1
 */

import { Effect, Stream } from "effect"
import { McpError } from "../McpError.ts"
import * as Limits from "./Limits.ts"
import type * as Rpc from "./Rpc.ts"

/**
 * One live connection to an MCP server.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Transport {
  /** Sends a request and resolves with its `result`, or fails with the server's `error`. */
  readonly request: (method: string, params?: unknown, timeoutMs?: number) => Effect.Effect<unknown, McpError>
  /** Sends a notification, bounding delivery by the optional positive-integer deadline. */
  readonly notify: (method: string, params?: unknown, timeoutMs?: number) => Effect.Effect<void, McpError>
}

/**
 * Default request deadline.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultRequestTimeoutMs = 120_000

/**
 * Default maximum inbound JSON-RPC frame size (one MiB).
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxFrameBytes = 1024 * 1024

/**
 * Default maximum outbound JSON-RPC frame size (one MiB).
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxOutboundFrameBytes = 1024 * 1024

/**
 * The reason sent with a best-effort `notifications/cancelled`.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export const cancellationReason = "request no longer awaited"

/**
 * A `connection_closed` failure naming the server.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export const closed = (server: string, reason: string): McpError =>
  new McpError({ code: "connection_closed", message: `MCP server "${server}" ${reason}`, server })

/**
 * A `timeout` failure naming the server, method and deadline.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export const timeout = (server: string, method: string, timeoutMs: number): McpError =>
  new McpError({
    code: "timeout",
    message: `MCP server "${server}" did not answer ${method} within ${timeoutMs}ms`,
    server
  })

/**
 * The model-facing failure for a correlated JSON-RPC error reply. Remote text
 * is withheld; the caller reports it to Diagnostics.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export const replyError = (
  server: string,
  method: string,
  reply: Extract<Rpc.Reply, { readonly _tag: "Error" }>
): McpError => {
  // Servers do not standardize unknown-tool prose, so this heuristic stays
  // limited to the two MCP error codes and an explicit tool plus absence phrase.
  const remoteUnknownTool = (reply.code === -32_601 || reply.code === -32_602) &&
    /\btool\b/i.test(reply.message) &&
    /\b(?:unknown|unrecognized|no such|not found)\b/i.test(reply.message)
  return new McpError({
    code: method === "tools/call"
      ? remoteUnknownTool ? "tool_not_found" : "tool_failed"
      : "protocol_error",
    message: `MCP server "${server}" failed ${method} (${reply.code}); remote details withheld`,
    server
  })
}

/**
 * Splits a byte stream into lines in linear time, retaining one bounded
 * partial line. Lines end at LF, with a CR before the LF dropped; with
 * `crTerminates`, as server-sent events require, a lone CR also ends a line.
 * Blank lines are kept: server-sent events use them as delimiters.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const lines = <E>(
  server: string,
  maxLineBytes: number,
  stream: Stream.Stream<Uint8Array, E>,
  options: { readonly crTerminates?: boolean } = {}
): Stream.Stream<string, E | McpError> => {
  type PartialLine = { pieces: Array<Uint8Array>; bytes: number; skipLf: boolean }
  const crTerminates = options.crTerminates === true
  const decoder = new TextDecoder()
  const decode = (partial: PartialLine): string => {
    const joined = new Uint8Array(partial.bytes)
    let offset = 0
    for (const piece of partial.pieces) {
      joined.set(piece, offset)
      offset += piece.byteLength
    }
    const end = joined[partial.bytes - 1] === 0x0d ? partial.bytes - 1 : partial.bytes
    return decoder.decode(joined.subarray(0, end))
  }
  const terminator = (chunk: Uint8Array, from: number): number => {
    if (!crTerminates) return chunk.indexOf(0x0a, from)
    for (let index = from; index < chunk.byteLength; index += 1) {
      if (chunk[index] === 0x0a || chunk[index] === 0x0d) return index
    }
    return -1
  }
  const tooLong = () => Effect.fail(Limits.protocolError(server, `MCP frame exceeded ${maxLineBytes} bytes`))
  return stream.pipe(
    Stream.mapAccumEffect(
      (): PartialLine => ({ pieces: [], bytes: 0, skipLf: false }),
      (partial, chunk) => {
        const complete: Array<string> = []
        const append = (piece: Uint8Array): boolean => {
          if (piece.byteLength === 0) return true
          const bytes = partial.bytes + piece.byteLength
          // A final CR may be the first half of CRLF. Allow that one byte
          // beyond the cap, but count it if more frame content follows.
          const contentBytes = bytes - (piece[piece.byteLength - 1] === 0x0d ? 1 : 0)
          if (contentBytes > maxLineBytes) return false
          partial.pieces.push(piece)
          partial.bytes = bytes
          return true
        }
        // The LF of a CRLF split across chunks ends nothing new.
        let start = partial.skipLf && chunk[0] === 0x0a ? 1 : 0
        partial.skipLf = false
        for (let end = terminator(chunk, start); end !== -1; end = terminator(chunk, start)) {
          if (!append(chunk.subarray(start, end))) return tooLong()
          complete.push(decode(partial))
          partial = { pieces: [], bytes: 0, skipLf: false }
          start = end + 1
          if (chunk[end] === 0x0d) {
            if (start === chunk.byteLength) partial.skipLf = true
            else if (chunk[start] === 0x0a) start += 1
          }
        }
        if (!append(chunk.subarray(start))) return tooLong()
        return Effect.succeed([partial, complete] as const)
      },
      { onHalt: (partial) => partial.bytes === 0 ? [] : [decode(partial)] }
    )
  )
}
