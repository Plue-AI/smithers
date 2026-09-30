/**
 * RPC server layers for the control service.
 *
 * @since 0.1.0
 */

import { Cause, Effect, Layer, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { RpcServer } from "effect/unstable/rpc"
import { Control } from "./Control.ts"
import { Unauthorized } from "./ControlError.ts"
import { ControlPrincipal, ControlRpcs, RunVisibility } from "./ControlRpcs.ts"

/**
 * Logs the raw defect of a failed RPC handler on the server, and nothing for
 * a typed failure or an interruption. `ControlRpcs.ControlDefect` sends
 * clients only the designed sentence, so this log is where the detail lives.
 * Pass it to `Effect.tapCause` or `Stream.tapCause` around a handler.
 *
 * @category logging
 * @since 1.0.0
 */
export const logDefect = (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  Cause.hasDies(cause) ? Effect.logError("A control RPC handler died", cause) : Effect.void

const logged = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.tapCause(effect, logDefect)

/**
 * Control RPC handlers delegating to the transport-independent service.
 *
 * Every mutation that records who asked reads `ControlPrincipal` and stamps
 * it, rather than forwarding whatever the client sent. The identity the
 * middleware authenticated is the only one the server can stand behind, and it
 * is what reaches the journal, `RunSummary.cancellation`, and a steer's
 * notification provenance.
 *
 * `List` and `Watch` read it too: a principal `ControlRpcs.RunVisibility`
 * does not make an operator reads only the runs it launched.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = ControlRpcs.toLayer(
  Effect.gen(function*() {
    const control = yield* Control
    // A reader that is not an operator is restricted to the runs its own
    // principal launched. `reader` is not on the wire, so only this stamp sets
    // it. The authentication middleware provides the rule with the principal.
    const reader = Effect.gen(function*() {
      const principal = yield* ControlPrincipal
      const visibility = yield* RunVisibility
      return visibility.seesAllRuns(principal) ? {} : { reader: principal }
    })
    return ControlRpcs.of({
      Plan: Effect.fn("Control.plan")((input) => control.plan(input), logged),
      Run: Effect.fn("Control.run")((input) =>
        Effect.gen(function*() {
          const principal = yield* ControlPrincipal
          return yield* control.run({ ...input, principal })
        }), logged),
      Approve: Effect.fn("Control.approve")((input) =>
        Effect.gen(function*() {
          const principal = yield* ControlPrincipal
          if (principal.id === "loopback" && principal.kind === "anonymous") {
            return yield* new Unauthorized({ message: "An operator credential is required" })
          }
          return yield* control.approve({ ...input, principal })
        }), logged),
      Deny: Effect.fn("Control.deny")((input) =>
        Effect.gen(function*() {
          const principal = yield* ControlPrincipal
          if (principal.id === "loopback" && principal.kind === "anonymous") {
            return yield* new Unauthorized({ message: "An operator credential is required" })
          }
          return yield* control.deny({ ...input, principal })
        }), logged),
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
        }), logged),
      Signal: Effect.fn("Control.signal")((input) =>
        Effect.gen(function*() {
          const principal = yield* ControlPrincipal
          return yield* control.signal({ ...input, principal })
        }), logged),
      Cancel: Effect.fn("Control.cancel")((input) =>
        Effect.gen(function*() {
          const principal = yield* ControlPrincipal
          return yield* control.cancel({ ...input, principal })
        }), logged),
      Resume: Effect.fn("Control.resume")((input) =>
        Effect.gen(function*() {
          const principal = yield* ControlPrincipal
          return yield* control.resume({ ...input, principal })
        }), logged),
      List: Effect.fn("Control.list")(
        (input) => Effect.flatMap(reader, (restriction) => control.list({ ...input, ...restriction })),
        logged
      ),
      Watch: (input) =>
        Stream.tapCause(
          Stream.unwrap(Effect.map(reader, (restriction) => control.watch({ ...input, ...restriction }))),
          logDefect
        )
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
