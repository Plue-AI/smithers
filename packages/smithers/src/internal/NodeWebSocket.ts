/**
 * Node WebSocket construction with errors owned through finalization.
 * @since 1.0.0
 */

import { NodeWS } from "@effect/platform-node/NodeSocket"
import type * as Socket from "effect/unstable/socket/Socket"

/**
 * Constructs the transport used by the CLI and its real-socket fault harness.
 * @since 1.0.0
 * @category constructors
 */
export const make = (credential?: string): Socket.WebSocketConstructor["Service"] => (address, options) => {
  const configured = options !== undefined && typeof options !== "string" && !Array.isArray(options)
    ? options
    : undefined
  const protocols = configured === undefined ? options as string | Array<string> | undefined : undefined
  const socket = new NodeWS.WebSocket(address, protocols, {
    ...configured,
    headers: { ...configured?.headers, ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }) }
  })
  // Effect detaches its reader listeners before closing the transport. `ws`
  // emits an asynchronous error when closed during its handshake; without an
  // owner that event crashes Node. This listener lives with the socket and
  // leaves every active Effect error listener in place to report failures.
  socket.on("error", () => {})
  return socket
}
