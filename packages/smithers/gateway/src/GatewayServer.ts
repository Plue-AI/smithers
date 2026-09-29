/**
 * The assembled workspace gateway: one HTTP surface carrying the control
 * plane, the sync read path, the served projections, and a health probe.
 *
 * Mounts:
 *
 * | Path | Protocol | Serves |
 * | --- | --- | --- |
 * | `POST /rpc` | RPC over HTTP | `@smthrs/control` `ControlRpcs` |
 * | `/rpc/ws` | RPC over WebSocket | `ControlRpcs`, including a kept-alive `Watch` |
 * | `POST /projections` | RPC over HTTP | `GatewayRpcs` |
 * | `/projections/ws` | RPC over WebSocket | `GatewayRpcs`, including `Projection.Subscribe` |
 * | `POST /sync` | RPC over HTTP | `@smthrs/sync` `SyncRpcs` |
 * | `/sync/ws` | RPC over WebSocket | `SyncRpcs` |
 * | `GET /health` | JSON | `GatewaySchema.GatewayHealth` plus the package version |
 *
 * `/health` is deliberately unauthenticated: a supervisor decides whether to
 * keep or replace a gateway process by asking which workspace it belongs to,
 * and a probe that needed a credential could not answer that question about a
 * gateway it did not start. The response carries identity only: the
 * workspace hash, the gateway id, the protocol version, and the package
 * version. It never carries a token, a run, or a path.
 *
 * @since 1.0.0
 */

import { Control } from "@smthrs/control/Control"
import * as ControlError from "@smthrs/control/ControlError"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import { ControlPrincipal } from "@smthrs/control/ControlRpcs"
import type * as ControlSchema from "@smthrs/control/ControlSchema"
import * as ControlServer from "@smthrs/control/ControlServer"
import { SyncRpcs } from "@smthrs/sync/SyncRpcs"
import * as SyncServer from "@smthrs/sync/SyncServer"
import { Effect, Layer, Schema, Stream, type Types } from "effect"
import * as ByteSize from "effect/ByteSize"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { GatewayError, settingRefusal } from "./GatewayError.ts"
import { GatewayRpcs } from "./GatewayRpcs.ts"
import * as GatewaySchema from "./GatewaySchema.ts"
import { heartbeatIntervalMillis, Projections } from "./Projections.ts"
import * as RuntimeBridge from "./RuntimeBridge.ts"

/**
 * What `GET /health` answers: the `GatewaySchema.GatewayHealth` identity plus
 * the version of the package serving it.
 *
 * @since 1.0.0
 * @category models
 */
export const Health = Schema.Struct({
  ...GatewaySchema.GatewayHealth.fields,
  version: Schema.String,
  runtimeBridge: Schema.optional(RuntimeBridge.Identity)
})

/**
 * What `GET /health` answers.
 *
 * @since 1.0.0
 * @category models
 */
export type Health = typeof Health.Type

const encodeHealth = Schema.encodeUnknownSync(Health)

/**
 * Mounts the unauthenticated health probe.
 *
 * @param health the identity this process serves under
 * @since 1.0.0
 * @category layers
 */
export const layerHealth = (health: Health): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
  HttpRouter.add("GET", "/health", HttpServerResponse.jsonUnsafe(encodeHealth(health)))

/**
 * The gateway's own RPC handlers over the read path and the control plane.
 *
 * @since 1.0.0
 * @category layers
 */
export const layerHandlers = GatewayRpcs.toLayer(
  Effect.gen(function*() {
    const projections = yield* Projections
    const control = yield* Control
    return GatewayRpcs.of({
      "Projection.Snapshot": Effect.fn("Gateway.snapshot")(
        ({ selector, after }) => projections.snapshot(selector, after),
        Effect.tapCause(ControlServer.logDefect)
      ),
      "Projection.Subscribe": ({ after, selector }) =>
        Stream.tapCause(projections.subscribe(selector, after), ControlServer.logDefect),
      /* One operator command. Control owns the atomic decision plus durable
       * resume delegation; the gateway is only a transport adapter. */
      "Approval.Submit": Effect.fn("Gateway.submitApproval")((input) =>
        Effect.gen(function*() {
          // The identity the shared `ControlAuth` middleware authenticated, as
          // `ControlServer` stamps it on `Approve` and `Deny`. This mount is
          // the same decision under a different payload, so it is answerable
          // to the same operator, and a decision journaled under the
          // composition's default operator names the wrong one.
          const principal = yield* ControlPrincipal
          // Answering a human wait uses signal rather than the approval policy.
          // Do not let that alternate mutation path bypass loopback authentication.
          if (principal.id === "loopback" && principal.kind === "anonymous") {
            return yield* new ControlError.Unauthorized({ message: "An operator credential is required" })
          }
          const payload = {
            target: input.target,
            scope: input.scope,
            idempotencyKey: input.idempotencyKey,
            principal
          }
          // A gate that asked a question is answered, not granted, and the
          // PAYLOAD says which kind it is: a human wait carries its durable
          // wait token as the target's digest, and nothing else does. Reading
          // it here rather than trusting the client to have sent `answer` is
          // the difference between a clear refusal and the one an operator
          // actually saw — a client that forgot the answer fell through to
          // `Control.approve`, which looked for a registered approval token,
          // found none, and reported `/control/RunNotFound` for a run that was
          // listed, rendered, and waiting (workspace 4bb93306, run-1).
          //
          // `target.runId` is the run the person opened and `wait.name` the
          // wait point's own name; `Control.signal` routes the pair into the
          // run tree, to whichever execution is holding it.
          const wait = ControlExecutor.answerableWait(input.target)
          if (wait !== undefined && input.target._tag === "Node") {
            // Neither half of a grant answers a question. A denial has nowhere
            // to go — the run is parked on a value, and refusing to supply one
            // leaves it parked until its own attempt budget or deadline ends
            // it — and an approval with no value supplies none.
            if (input.decision === "deny") {
              return yield* new ControlError.InvalidInput({
                issue: `decision: "${wait.name}" asks a question, which is answered rather than denied`
              })
            }
            if (input.answer === undefined) {
              return yield* new ControlError.InvalidInput({
                issue: `answer: "${wait.name}" asks a question, so a decision alone does not answer it`
              })
            }
            const decision = yield* control.signal({
              runId: input.target.runId,
              signal: { name: wait.name, payload: input.answer },
              idempotencyKey: input.idempotencyKey,
              principal
            })
            return { decision }
          }
          const decision = input.decision === "approve"
            ? yield* control.approve(payload)
            : yield* control.deny(payload)
          return { decision }
        }), Effect.tapCause(ControlServer.logDefect))
    })
  })
)

/**
 * The kind a `Watch` keepalive carries.
 *
 * `ControlRpcs.Watch` answers `ControlSchema.ControlEvent` and has no frame of
 * its own for a keepalive, so the gateway publishes one as an event whose kind
 * no emitter uses. A fold that does not know the kind ignores it, which is
 * what every fold in this package and in `@smthrs/cli` `Forensics` already
 * does with an unknown kind.
 *
 * @since 1.0.0
 * @category models
 */
export const watchHeartbeatKind = "control.gateway.heartbeat"

/**
 * Merges a keepalive into a followed `Watch` stream.
 *
 * A followed stream is silent while a run is thinking, and a relay cuts an
 * idle tunnel at 600 s. The Effect RPC client
 * sends its own `Ping` every 5 s, but a non-Effect consumer behind a relay
 * sends nothing, so the keepalive has to come from the server.
 *
 * The keepalive repeats the last delivered sequence and run-scoped cursor,
 * including an expansion offset, so it cannot advance or rewind a checkpoint.
 * It carries the watched run id so a client routing by run keeps routing.
 * A snapshot read (`follow: false`) is left alone: it has to end.
 */
const keptAlive = (
  millis: number,
  filter: ControlSchema.WatchFilter,
  events: Stream.Stream<ControlSchema.ControlEvent, ControlError.ControlError>
): Stream.Stream<ControlSchema.ControlEvent, ControlError.ControlError> => {
  if (filter.follow === false) return events
  let cursor = filter.afterCursor ??
    (filter.afterSequence === undefined ? undefined : { sequence: filter.afterSequence })
  let sequence = cursor?.sequence ?? 0
  const tracked = Stream.map(events, (event) => {
    sequence = event.sequence
    cursor = event.cursor ?? { sequence }
    return event
  })
  const beats = Stream.tick(millis).pipe(
    Stream.drop(1),
    Stream.mapEffect(() =>
      Effect.map(
        Effect.clockWith((clock) => clock.currentTimeMillis),
        (occurredAt): ControlSchema.ControlEvent => ({
          sequence,
          ...(filter.runId === undefined || cursor === undefined ? {} : { cursor }),
          kind: watchHeartbeatKind,
          ...(filter.runId === undefined ? {} : { runId: filter.runId }),
          occurredAt,
          payload: null
        })
      )
    )
  )
  return Stream.merge(tracked, beats, { haltStrategy: "left" })
}

/**
 * The control service the `/rpc` mounts read through: the ambient one, with
 * the keepalive merged into `watch`.
 *
 * Wrapping the service rather than re-declaring the handlers keeps
 * `@smthrs/control` `ControlServer` the single definition of what every
 * procedure does, including the principal it stamps on every mutation that
 * records who asked. Only `watch` behaves differently, and only in what it
 * adds.
 *
 * @since 1.0.0
 * @category layers
 */
export const layerKeepAlive = (
  millis: number = heartbeatIntervalMillis
): Layer.Layer<Control, never, Control> =>
  Layer.effect(Control)(
    Effect.map(Control, (control) =>
      Control.of({ ...control, watch: (filter) => keptAlive(millis, filter, control.watch(filter)) }))
  )

/**
 * The read path the `/projections` mounts serve through: the ambient one, with
 * a followed subscription's keepalive re-timed to the bind's cadence.
 *
 * `Projections.make` already merges a `heartbeat` frame at the cadence it was
 * built with. A host that supplies `Projections.layer` and sets the cadence at
 * the bind expects one option to govern both keepalives, so this replaces the
 * service's beats with beats at the bind's cadence rather than adding a second
 * channel. Snapshot reads are left alone: they have to end.
 *
 * @param millis how often an idle followed subscription emits a keepalive
 * @since 1.0.0
 * @category layers
 */
export const layerProjectionsKeepAlive = (millis: number): Layer.Layer<Projections, never, Projections> =>
  Layer.effect(Projections)(
    Effect.map(Projections, (projections) =>
      Projections.of({
        ...projections,
        subscribe: (selector, after) => keptAliveSubscription(millis, projections.subscribe(selector, after))
      }))
  )

/** Replaces a subscription's keepalive channel with one at the given cadence. */
const keptAliveSubscription = <F extends GatewaySchema.GatewayFrame>(
  millis: number,
  frames: Stream.Stream<F, GatewayError>
): Stream.Stream<F | GatewaySchema.HeartbeatFrame, GatewayError> => {
  // The first tick is dropped for the same reason `Projections` drops it: an
  // immediate keepalive would arrive before the snapshot it keeps alive.
  const beats: Stream.Stream<GatewaySchema.HeartbeatFrame> = Stream.tick(millis).pipe(
    Stream.drop(1),
    Stream.mapEffect(() =>
      Effect.map(
        Effect.clockWith((clock) => clock.currentTimeMillis),
        (atMs): GatewaySchema.HeartbeatFrame => ({ _tag: "heartbeat", atMs })
      )
    )
  )
  return Stream.merge(
    Stream.filter(frames, (frame) => frame._tag !== "heartbeat"),
    beats,
    { haltStrategy: "left" }
  )
}

/**
 * Mounts the control plane on `POST /rpc` and `/rpc/ws`, with the keepalive.
 *
 * @param millis how often an idle followed watch emits one, defaulting to
 * `Projections.heartbeatIntervalMillis`
 * @since 1.0.0
 * @category layers
 */
export const layerControlHttp = (millis?: number | undefined) =>
  ControlServer.layerHttp.pipe(Layer.provide(layerKeepAlive(millis)))

const gateway = RpcServer.layer(GatewayRpcs, { disableFatalDefects: true })

const sync = RpcServer.layer(SyncRpcs, { disableFatalDefects: true })

/**
 * Mounts the gateway's projections on `POST /projections` and
 * `/projections/ws`.
 *
 * Both protocols are mounted together because a client reads a snapshot over
 * the request/response path and follows deltas over the socket, and pointing
 * those at two different servers would let them disagree.
 *
 * @since 1.0.0
 * @category layers
 */
export const layerProjectionsHttp = Layer.mergeAll(
  gateway.pipe(
    Layer.provide(layerHandlers),
    Layer.provideMerge(RpcServer.layerProtocolHttp({ path: "/projections" })),
    Layer.fresh
  ),
  gateway.pipe(
    Layer.provide(layerHandlers),
    Layer.provideMerge(RpcServer.layerProtocolWebsocket({ path: "/projections/ws" })),
    Layer.fresh
  )
)

/**
 * Mounts the sync read path on `POST /sync` and `/sync/ws`.
 *
 * @since 1.0.0
 * @category layers
 */
export const layerSyncHttp = Layer.mergeAll(
  sync.pipe(
    Layer.provide(SyncServer.layerHandlers),
    Layer.provideMerge(RpcServer.layerProtocolHttp({ path: "/sync" })),
    Layer.fresh
  ),
  sync.pipe(
    Layer.provide(SyncServer.layerHandlers),
    Layer.provideMerge(RpcServer.layerProtocolWebsocket({ path: "/sync/ws" })),
    Layer.fresh
  )
)

/**
 * The POST mounts that carry RPC request messages and nothing else.
 *
 * @since 1.0.0
 * @category constants
 */
export const rpcPaths: ReadonlyArray<string> = ["/rpc", "/projections", "/sync"]

/**
 * POST mounts whose request bodies are bounded before their handlers read.
 *
 * @since 1.0.0
 * @category constants
 */
export const boundedPostPaths: ReadonlyArray<string> = [
  ...rpcPaths,
  "/runtime/v1/command",
  "/runtime/v1/observe"
]

/**
 * RPC paths whose upgrade or request must pass edge authentication.
 *
 * `POST /rpc` is deliberately not one of them. The control mount authenticates
 * in band through `@smthrs/control` `ControlRpcs.ControlAuth`, whose declared
 * error is `ControlError.Unauthorized`, and that typed control error is the
 * refusal the control plane publishes: "Missing, malformed, empty, and
 * incorrect credentials all return the same typed `Unauthorized` control
 * error" (`packages/smithers/gateway/docs/guides/serve-beyond-loopback.md`). An edge 401 answered
 * ahead of the mount, and `ControlClient` filters a non-2xx status, so every
 * refusal reached a caller as a `TransportError`, the one error class
 * `@smthrs/control` reserves for a request that failed *before* a declared
 * control response reached it. It also made the gateway refuse a call
 * differently from `NodeControl.layerServer` hosting the very same
 * `ControlRpcs`. The body limit below still applies to `/rpc`, so an
 * unauthenticated caller buys one bounded body read and nothing else.
 *
 * The `/rpc/ws` upgrade stays here. A socket is a resource the server holds
 * open, the RPC middleware can only refuse frames on a socket that already
 * exists, and a refused handshake has no RPC channel to answer a typed error
 * on, so its refusal is a transport fact either way.
 *
 * @category constants
 * @since 1.0.0
 */
export const protectedPaths: ReadonlyArray<string> = [
  "/projections",
  "/sync",
  "/rpc/ws",
  "/projections/ws",
  "/sync/ws",
  "/runtime/v1/command",
  "/runtime/v1/observe"
]

/**
 * The mount a request target reaches, spelled the way {@link rpcPaths} and
 * {@link protectedPaths} spell it.
 *
 * The guard runs before the router and has to reach the router's verdict, or
 * an alias walks past the credential check and the body limit and is answered
 * by the mount anyway. Measured against `HttpRouter` on this tree, all of
 * `/%72pc`, `/rpc;transport-parameter`, `/rpc/`, `//rpc`, `///rpc`, `/rpc//`,
 * `/RPC`, `/./rpc`, and `/foo/../rpc` reach the `/rpc` handler, while
 * `/rpc%2f`, `/rpc%3Bp`, `/%2frpc`, and `/rpc%20` do not. This is not only
 * about crafted aliases: `@smthrs/control` `ControlClient`'s HTTP protocol
 * posts every call to `/rpc/`, so a literal comparison skipped the body limit
 * on the path the product's own client uses.
 *
 * Each segment is therefore taken without its `;` parameter, empty segments are
 * dropped, and what is left is decoded with `decodeURI` and compared without
 * regard to case. `decodeURI` is the decoder rather than `decodeURIComponent`
 * because it leaves a reserved character encoded, which is what keeps
 * `/rpc%2f` a different path here exactly as it is to the router. An invalid
 * escape is left as written, since it names no mount either way.
 *
 * Dot segments are resolved by `URL` before the split. The normalization errs
 * toward matching: a spelling this resolves to a mount that the router then
 * refuses is answered 401 rather than 404, which costs an unauthenticated
 * caller nothing it was entitled to.
 *
 * @param url the request target, origin-relative or absolute
 * @since 1.0.0
 * @category constructors
 */
export const routedPath = (url: string): string => {
  // An empty leading segment is a protocol-relative URL to `URL`, so `//rpc`
  // would parse as the host `rpc` and lose the path entirely. Anchoring an
  // origin-relative target on the origin keeps every segment. An absolute
  // target that does not parse at all names no mount, so it is compared as
  // written and reaches the router as the unknown route it is.
  const target = url.startsWith("/") ? `http://gateway.invalid${url}` : url
  const parsed = URL.parse(target, "http://gateway.invalid")
  if (parsed === null) return url
  const segments: Array<string> = []
  for (const segment of parsed.pathname.split("/")) {
    const parameter = segment.indexOf(";")
    const named = parameter < 0 ? segment : segment.slice(0, parameter)
    if (named === "") continue
    try {
      segments.push(decodeURI(named))
    } catch {
      segments.push(named)
    }
  }
  return `/${segments.join("/")}`.toLowerCase()
}

/**
 * Default maximum request body accepted by an RPC mount (one MiB).
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultMaxRequestBodyBytes = 1024 * 1024

/**
 * Ingress policy enforced before an RPC transport parses a request.
 *
 * @category models
 * @since 1.0.0
 */
export interface IngressOptions {
  /** Accepted Host header names, without ports. Defaults to loopback names. */
  readonly allowedHosts?: ReadonlyArray<string> | undefined
  readonly maxRequestBodyBytes?: number | undefined
  /** Confine requests to loopback Host values and browser origins. */
  readonly loopbackOnly?: boolean | undefined
  readonly authorize?: (
    headers: Readonly<Record<string, string>>
  ) => Effect.Effect<boolean>
}

const encodeGatewayError = Schema.encodeUnknownSync(GatewayError)

/** Host parsing stays strict so URL normalization cannot admit a rebinding name. */
const requestAuthority = (host: string | undefined): URL | undefined => {
  if (host === undefined || !/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::[0-9]+)?$/.test(host)) return undefined
  const parsed = URL.parse(`http://${host}`)
  return parsed === null ? undefined : parsed
}

const browserRequestRefusal = (
  headers: Readonly<Record<string, string>>,
  allowedHosts: ReadonlyArray<string>,
  loopbackOnly: boolean
): { readonly error: GatewayError; readonly status: number } | undefined => {
  const authority = requestAuthority(headers.host)
  if (
    authority === undefined || !allowedHosts.includes(authority.hostname) ||
    (loopbackOnly && !loopbackHost.test(headers.host!))
  ) return { error: invalidHostRequest(), status: 421 }
  const origin = headers.origin
  // CLI clients do not send Origin. Browsers must prove they came from this
  // exact authority, including the port, on HTTP requests AND WS upgrades.
  if (origin === undefined) return undefined
  const parsed = URL.parse(origin)
  return parsed !== null && (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.origin === origin && parsed.host === authority.host
    ? undefined
    : { error: invalidOriginRequest(), status: 403 }
}

/** One refusal on the wire: the typed error, under the status it answers. */
const refuse = (error: GatewayError, status: number) =>
  HttpServerResponse.jsonUnsafe(encodeGatewayError(error), { status })

const malformedRequest = (path: string) =>
  new GatewayError({ code: "malformed_request", message: `POST ${path} carries no RPC request message` })

const unauthorizedRequest = () =>
  new GatewayError({ code: "unauthorized", message: "A valid bearer credential is required" })

const invalidHostRequest = () =>
  new GatewayError({ code: "invalid_host", message: "This gateway does not allow the supplied Host value" })

const invalidOriginRequest = () =>
  new GatewayError({ code: "invalid_origin", message: "The browser Origin must match an allowed gateway Host" })

const requestTooLarge = (path: string, maxBytes: number) =>
  new GatewayError({
    code: "request_too_large",
    message: `POST ${path} exceeds the ${maxBytes}-byte request limit`
  })

/** The message `@effect/platform-node-shared` `NodeStream` gives a size overflow. */
const maxBytesExceeded = "maxBytes exceeded"

/**
 * The names that mean this machine only, as a bind address is spelled.
 *
 * This is a list of spellings a person types, not a subnet test: `127.0.0.2`
 * is loopback to the kernel and is not on it. The Node host's
 * `isLoopbackHost`, the Host-header names below, and the ingress regex all
 * derive from this one list so widening it is one edit.
 *
 * @since 1.0.0
 * @category constants
 */
export const loopbackHostNames: ReadonlyArray<string> = ["127.0.0.1", "localhost", "::1"]

/**
 * {@link loopbackHostNames} as a Host header spells them: an IPv6 address is
 * bracketed as a URL authority. This is the default `allowedHosts`.
 *
 * @since 1.0.0
 * @category constants
 */
export const loopbackHostHeaderNames: ReadonlyArray<string> = loopbackHostNames.map((name) =>
  name.includes(":") ? `[${name}]` : name
)

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const loopbackHost = new RegExp(`^(?:${loopbackHostHeaderNames.map(escapeRegExp).join("|")})(?::\\d{1,5})?$`, "i")

/**
 * Whether a failed request-body read hit the configured size limit rather than
 * failing for another reason.
 *
 * `@effect/platform-node` raises the limit as an `HttpServerError` whose
 * `reason` is a `RequestParseError` carrying the `Error("maxBytes exceeded")`
 * that `@effect/platform-node-shared` `NodeStream.toString` throws
 * (`NodeHttpIncomingMessage.text` passes `MaxBodySize` in as `maxBytes`, and
 * `NodeHttpServer`'s `ServerRequestImpl` wraps whatever it throws). Nothing on
 * the wire distinguishes it otherwise, so the check is that exact shape and a
 * version bump of those packages is the thing to re-read it against.
 *
 * Every other read failure, a transport reset among them, is not a size
 * overflow. Answering 413 for all of them told a client to shrink a request
 * that was never too big.
 *
 * @param error the failure a body read produced
 * @since 1.0.0
 * @category predicates
 */
export const exceededBodyLimit = (error: unknown): boolean => {
  const reason = typeof error === "object" && error !== null
    ? (error as { readonly reason?: unknown }).reason
    : undefined
  const cause = typeof reason === "object" && reason !== null
    ? (reason as { readonly cause?: unknown }).cause
    : undefined
  return cause instanceof Error && cause.message === maxBytesExceeded
}

/**
 * The refusal a failed request-body read earns, and the status it answers
 * under.
 *
 * A body over the limit is 413 `request_too_large`. Every other read failure,
 * a truncated body or a reset transport among them, is 400
 * `malformed_request`: the request cannot be retried smaller, because its size
 * was never the problem.
 *
 * @param path the mount the request was made to
 * @param maxBytes the configured limit
 * @param error the failure the body read produced
 * @since 1.0.0
 * @category constructors
 */
export const bodyRefusal = (
  path: string,
  maxBytes: number,
  error: unknown
): { readonly error: GatewayError; readonly status: number } =>
  exceededBodyLimit(error)
    ? { error: requestTooLarge(path, maxBytes), status: 413 }
    : {
      error: new GatewayError({
        code: "malformed_request",
        message: `POST ${path} carries a body the server could not read`
      }),
      status: 400
    }

/**
 * Whether a request body carries at least one RPC message the server can act
 * on.
 *
 * The transport's own parser answers, not a second reading of the wire
 * format: whatever `RpcSerialization` the host composed decodes the body, and
 * the answer is no only when that decode throws or yields no tagged message.
 * A body naming a procedure that does not exist is a yes — that is an
 * RPC-level defect the protocol itself reports.
 *
 * A binary framing is always a yes. Its body is not text, so there is nothing
 * to read here, and the mount owns it.
 *
 * @since 1.0.0
 * @category predicates
 */
export const carriesRpcRequest = (
  serialization: RpcSerialization.RpcSerialization["Service"],
  body: string
): boolean => {
  if (!serialization.contentType.includes("json")) return true
  try {
    const decoded = serialization.makeUnsafe().decode(body)
    return decoded.length > 0 && decoded.every((message: unknown) =>
      typeof message === "object" && message !== null &&
      typeof (message as { readonly _tag?: unknown })._tag === "string"
    )
  } catch {
    return false
  }
}

/**
 * Enforces local Host/Origin policy and edge authentication before reading a
 * body or upgrading a socket, then validates RPC body size and framing.
 *
 * `effect/unstable/rpc` hands every decoded message to the server loop, and a
 * body that decodes to something else — `{}`, `[]`, prose, nothing at all —
 * reached it as a message with no tag and died there, so the gateway answered
 * `500 Internal Server Error` with an empty body (release validation). That is the
 * wrong half of the contract twice over: it tells an operator the gateway
 * broke, and it tells a client to retry a request that can never succeed.
 *
 * The body reader is cached per request, so reading the body here does not
 * consume the body the mount reads. It is read through the reader the mount
 * uses, `text` under a JSON serialization and `arrayBuffer` under a binary
 * one, so the bytes the mount decodes are the bytes the client sent.
 *
 * @since 1.0.0
 * @category layers
 */
export const layerIngress = (options: IngressOptions = {}) => {
  const refusal = settingRefusal("The gateway request body limit", options.maxRequestBodyBytes)
  if (refusal !== undefined) return Layer.effectDiscard(Effect.fail(refusal))
  const maxBytes = options.maxRequestBodyBytes ?? defaultMaxRequestBodyBytes
  const allowedHosts = options.allowedHosts ?? loopbackHostHeaderNames
  return HttpRouter.middleware(
    Effect.gen(function*() {
      const serialization = yield* RpcSerialization.RpcSerialization
      const binary = !serialization.contentType.includes("json")
      return (httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>) =>
        Effect.gen(function*() {
          const request = yield* HttpServerRequest.HttpServerRequest
          const browserRefusal = browserRequestRefusal(request.headers, allowedHosts, options.loopbackOnly === true)
          if (browserRefusal !== undefined) return refuse(browserRefusal.error, browserRefusal.status)
          const path = routedPath(request.url)
          if (protectedPaths.includes(path) && options.authorize !== undefined) {
            const authorized = yield* options.authorize(request.headers)
            if (!authorized) return refuse(unauthorizedRequest(), 401)
          }
          if (request.method !== "POST" || !boundedPostPaths.includes(path)) return yield* httpEffect
          // A declared length is a hint that saves reading a body already
          // known to be too big. It is never trusted the other way: a body
          // that declares less than it sends is still measured by the read,
          // and a chunked body declares nothing at all.
          const declaredLength = Number(request.headers["content-length"])
          if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
            return refuse(requestTooLarge(path, maxBytes), 413)
          }
          // The body is read through the reader the mount will use. The Node
          // adapter caches whichever reader ran first and derives the other
          // from it, so a text read here would hand a binary mount a UTF-8
          // re-encoding of its MessagePack bytes, with every invalid sequence
          // replaced. A binary body is bounded here and framed by the mount.
          const read = yield* (binary ? Effect.as(request.arrayBuffer, undefined) : request.text).pipe(
            Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(maxBytes)),
            Effect.match({
              onFailure: (error): { readonly body: string | undefined; readonly error: unknown } => ({
                body: undefined,
                error
              }),
              onSuccess: (body) => ({ body, error: undefined })
            })
          )
          if (read.error !== undefined) {
            const answer = bodyRefusal(path, maxBytes, read.error)
            return refuse(answer.error, answer.status)
          }
          if (read.body === undefined) return yield* httpEffect
          return !rpcPaths.includes(path) || carriesRpcRequest(serialization, read.body)
            ? yield* httpEffect
            : refuse(malformedRequest(path), 400)
        })
    }),
    { global: true }
  )
}

/**
 * How an assembled gateway is configured.
 *
 * @category models
 * @since 1.0.0
 */
export interface LayerOptions {
  /**
   * How often an idle followed `Watch` on `/rpc/ws` and an idle followed
   * `Projection.Subscribe` on `/projections/ws` emit a keepalive. Unset, the
   * `Watch` keepalive runs at `Projections.heartbeatIntervalMillis` and the
   * supplied `Projections` service keeps the cadence it was built with.
   */
  readonly heartbeatMillis?: number | undefined
  /** The ingress policy the RPC mounts run behind. */
  readonly ingress?: IngressOptions | undefined
  /** Enables the authenticated Go-to-Control runtime bridge. */
  readonly runtimeBridge?: RuntimeBridge.Config | undefined
}

/**
 * The whole gateway surface, as one application layer a host serves.
 *
 * The caller supplies the transport serialization, the authentication
 * middleware for both RPC groups, and the services the mounts read through
 * (`Control`, `Projections`, `SyncServer`). `@smthrs/gateway/node/NodeGateway`
 * is the Node host that binds this to a socket.
 *
 * A keepalive cadence or a body limit that is not a positive safe integer is
 * refused here, before anything binds, through the layer's typed
 * `GatewayError` channel.
 *
 * @param health the identity `GET /health` answers with
 * @param options the keepalive cadence and the ingress policy
 * @since 1.0.0
 * @category layers
 */
export const layer = (health: Health, options: LayerOptions = {}) => {
  const refusal = settingRefusal("The gateway keepalive cadence", options.heartbeatMillis)
  if (refusal !== undefined) return Layer.effectDiscard(Effect.fail(refusal))
  return Layer.mergeAll(
    layerControlHttp(options.heartbeatMillis),
    options.heartbeatMillis === undefined
      ? layerProjectionsHttp
      : layerProjectionsHttp.pipe(Layer.provide(layerProjectionsKeepAlive(options.heartbeatMillis))),
    layerSyncHttp,
    layerHealth(health),
    ...(options.runtimeBridge === undefined ? [] : [RuntimeBridge.layer(options.runtimeBridge)]),
    layerIngress(options.ingress)
  )
}
