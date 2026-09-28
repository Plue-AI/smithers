/**
 * RPC server layers for the control service.
 *
 * @since 0.1.0
 */

import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { RpcServer } from "effect/unstable/rpc"
import { Control } from "./Control.ts"
import { ControlPrincipal, ControlRpcs } from "./ControlRpcs.ts"

/**
 * Control RPC handlers delegating to the transport-independent service.
 *
 * Every mutation that records who asked reads `ControlPrincipal` and stamps
 * it, rather than forwarding whatever the client sent. The identity the
 * middleware authenticated is the only one the server can stand behind, and it
 * is what reaches the journal, `RunSummary.cancellation`, and a steer's
 * notification provenance.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = ControlRpcs.toLayer(
  Effect.gen(function*() {
    const control = yield* Control
    return ControlRpcs.of({
      Plan: Effect.fn("Control.plan")((input) => control.plan(input)),
      Run: Effect.fn("Control.run")((input) =>
        Effect.gen(function*() {
          const principal = yield* ControlPrincipal
          return yield* control.run({ ...input, principal })
        })
      ),
      Approve: Effect.fn("Control.approve")((input) =>
        Effect.gen(function*() {
          const principal = yield* ControlPrincipal
          return yield* control.approve({ ...input, principal })
        })
      ),
      Deny: Effect.fn("Control.deny")((input) =>
        Effect.gen(function*() {
          const principal = yield* ControlPrincipal
          return yield* control.deny({ ...input, principal })
        })
      ),
      Steer: Effect.fn("Control.steer")((input) =>
        Effect.gen(function*() {
          const principal = yield* ControlPrincipal
          // A steer carries a principal on the wire because an in-process
          // caller names one that is not an operator: `agent/send` attributes
          // a child's steer to the parent flow. A remote client may not, so
          // the authenticated identity replaces whatever arrived. It reaches
          // the notification's `sourceActor` and the run transcript, which is
          // exactly where a spoofed name would be read as truth.
          return yield* control.steer({ ...input, message: { ...input.message, principal } })
        })
      ),
      Signal: Effect.fn("Control.signal")((input) =>
        Effect.gen(function*() {
          const principal = yield* ControlPrincipal
          return yield* control.signal({ ...input, principal })
        })
      ),
      Cancel: Effect.fn("Control.cancel")((input) =>
        Effect.gen(function*() {
          const principal = yield* ControlPrincipal
          return yield* control.cancel({ ...input, principal })
        })
      ),
      Resume: Effect.fn("Control.resume")((input) =>
        Effect.gen(function*() {
          const principal = yield* ControlPrincipal
          return yield* control.resume({ ...input, principal })
        })
      ),
      List: Effect.fn("Control.list")((input) => control.list(input)),
      Watch: (input) => control.watch(input)
    })
  })
)

/**
 * Whether a request's `Origin` may reach the control mounts.
 *
 * Non-browser clients send no `Origin`. A browser always sends one, on POST
 * and on the WebSocket upgrade, and a cross-site page cannot forge it. Refusing
 * any `Origin` whose authority differs from `Host` stops a page on another site
 * from riding a credential that a proxy or cookie attaches on the victim's
 * behalf (cross-site WebSocket hijacking of the `Watch` stream).
 */
const sameOrigin = (headers: Readonly<Record<string, string>>): boolean => {
  const origin = headers.origin
  if (origin === undefined) return true
  const host = headers.host
  const parsed = URL.parse(origin)
  return host !== undefined && parsed !== null &&
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.origin === origin && parsed.host === host.toLowerCase()
}

/**
 * Route middleware on the two control mounts only, so the router's own path
 * matching decides what it guards, and a host's stricter global policy (the
 * gateway's ingress) still answers first with its own typed refusal.
 */
const originGuard = HttpRouter.middleware((httpEffect) =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (sameOrigin(request.headers)) return yield* httpEffect
    return HttpServerResponse.text("The browser Origin must match the control server Host", { status: 403 })
  })
).layer

const server = RpcServer.layer(ControlRpcs, {
  disableFatalDefects: true
})

const http = server.pipe(
  Layer.provide(layer),
  Layer.provideMerge(RpcServer.layerProtocolHttp({ path: "/rpc" }).pipe(Layer.provide(originGuard))),
  Layer.fresh
)

const websocket = server.pipe(
  Layer.provide(layer),
  Layer.provideMerge(RpcServer.layerProtocolWebsocket({ path: "/rpc/ws" }).pipe(Layer.provide(originGuard))),
  Layer.fresh
)

/**
 * Mounts control RPC on the ambient `HttpRouter`: unary procedures over POST
 * `/rpc` and the `watch` stream over WebSocket `/rpc/ws`. Both protocols are
 * mounted together because `ControlClient` projects the same `Control` vtable
 * across the two transports.
 *
 * A request carrying a browser `Origin` that does not match its `Host` is
 * refused with 403 before authentication, so a page on another site cannot
 * open the socket or post to `/rpc` with a credential a proxy attaches.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerHttp = Layer.mergeAll(
  http,
  websocket
)
