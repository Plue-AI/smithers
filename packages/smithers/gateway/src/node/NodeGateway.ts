/** Node HTTP adapter for the shared native gateway policy and protocol.
 * @since 1.0.0
 */

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { createServer } from "node:http"
import * as NativeGateway from "../internal/NativeGateway.ts"

export {
  bearerPrincipal,
  bindRefusal,
  defaultServerOptions,
  ingressOptions,
  isLoopbackHost,
  layerAuth,
  listenOptions,
  scopedPrincipal,
  scopedTokenPaths
} from "../internal/NativeGateway.ts"
/** Node socket and shared gateway policy options.
 * @since 1.0.0
 * @category models
 */
export type ServerOptions = NativeGateway.ServerOptions

/** Hosts the existing workspace gateway on Node's scoped HTTP server.
 * @since 1.0.0
 * @category layers
 */
export const layer = NativeGateway.makeLayer((options) => NodeHttpServer.layer(createServer, options))
