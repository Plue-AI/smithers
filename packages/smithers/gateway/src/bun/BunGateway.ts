/** Bun HTTP adapter for the same authenticated workspace gateway protocol.
 * @since 1.0.0
 */

import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { Cause, Effect, Layer } from "effect"
import type { HttpServer } from "effect/unstable/http/HttpServer"
import type { ServeError } from "effect/unstable/http/HttpServerError"
import { GatewayError } from "../GatewayError.ts"
import type * as GatewayServer from "../GatewayServer.ts"
import * as NativeGateway from "../internal/NativeGateway.ts"

export { bearerPrincipal } from "../internal/NativeGateway.ts"

/** TCP bind and existing gateway policy options supported by the Bun host.
 * @since 1.0.0
 * @category models
 */
export type ServerOptions = Pick<
  NativeGateway.ServerOptions,
  "host" | "port" | "allowedHosts" | "listen" | "credential" | "heartbeatMillis" | "maxRequestBodyBytes"
>

const native = NativeGateway.makeLayer((options) =>
  BunHttpServer.layerServer({
    // Shared listenOptions has already supplied and admitted the bind host.
    hostname: options.host!,
    port: options.port ?? 7331
  }).pipe(Layer.catchCause((cause): Layer.Layer<HttpServer, ServeError | GatewayError> => {
    const failure = Cause.squash(cause)
    const code = typeof failure === "object" && failure !== null && "code" in failure ? failure.code : undefined
    if (Cause.hasInterruptsOnly(cause) || !["EADDRINUSE", "EACCES", "EADDRNOTAVAIL"].includes(String(code))) {
      return Layer.effectContext<HttpServer, ServeError | GatewayError, never>(Effect.failCause(cause))
    }
    // The errno is safe to keep: NativeGateway logs it for the operator and
    // strips it from the refusal every bearer holder sees.
    return Layer.effectContext<HttpServer, ServeError | GatewayError, never>(Effect.fail(
      new GatewayError({
        code: "bind_failed",
        message: "The gateway socket could not be bound",
        cause: { _tag: "BunServeError", code: String(code) }
      })
    ))
  }))
)

/** Serves the existing HTTP/WebSocket gateway using Bun.serve in the caller's scope.
 * @since 1.0.0
 * @category layers
 */
export const layer = (health: GatewayServer.Health, options: ServerOptions = NativeGateway.defaultServerOptions) =>
  native(health, options)
