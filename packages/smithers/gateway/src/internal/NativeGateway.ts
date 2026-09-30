/**
 * Shared native gateway bind policy, credential policy,
 * and the one composition a `smithers serve` verb hosts.
 *
 * Two rules decide whether a bind is allowed, and both fail closed:
 *
 * 1. A non-loopback host requires an explicit `listen` opt-in. Binding
 *    `0.0.0.0` because a port was free is how a workspace gateway ends up on
 *    a shared network by accident.
 * 2. A non-loopback bind requires a bearer credential. The control plane can
 *    launch runs, cancel them, and approve capability grants; reachable from
 *    another machine, an unauthenticated one is a remote execution service.
 *
 * A loopback bind with no network credential allows anonymous reads; approval
 * decisions require the session operator token. Ingress still checks Host and
 * Origin so a web page cannot exercise the loopback endpoint.
 *
 * @since 1.0.0
 */

import { ControlRpcs, ScopedToken } from "@smthrs/control"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import type { HttpServer } from "effect/unstable/http/HttpServer"
import type { ServeError } from "effect/unstable/http/HttpServerError"
import { RpcSerialization } from "effect/unstable/rpc"
import type { ListenOptions } from "node:net"
import { GatewayError, settingRefusal } from "../GatewayError.ts"
import * as GatewayServer from "../GatewayServer.ts"
import type * as RuntimeBridge from "../RuntimeBridge.ts"

/**
 * Where the gateway binds, and whether a non-loopback bind was asked for.
 *
 * @since 1.0.0
 * @category models
 */
export interface ServerOptions extends ListenOptions {
  /** Additional accepted Host header names (without ports), for network or proxy access. */
  readonly allowedHosts?: ReadonlyArray<string> | undefined
  /** The `--listen` opt-in required for a non-loopback host. */
  readonly listen?: boolean | undefined
  /** The shared bearer credential, required for a non-loopback bind. */
  readonly credential?: string | undefined
  /** Per-session approval token on credential-free loopback. Read calls remain anonymous. */
  readonly operatorToken?: string | undefined
  /**
   * How often an idle followed `Watch` on `/rpc/ws` and an idle followed
   * `Projection.Subscribe` on `/projections/ws` emit a keepalive frame. Unset,
   * both run at `Projections.heartbeatIntervalMillis` unless the supplied
   * `Projections` service was built with its own cadence. A relay with an idle
   * cut shorter than that one needs a shorter cadence here.
   */
  readonly heartbeatMillis?: number | undefined
  /** Maximum bytes accepted on one HTTP RPC request. Default one MiB. */
  readonly maxRequestBodyBytes?: number | undefined
  /** Immutable identity of an opt-in packaged Flow runtime bridge. */
  readonly runtimeBridge?: Omit<RuntimeBridge.Config, "authenticate"> | undefined
}

/**
 * The default bind: loopback, port 7331, no credential.
 *
 * @since 1.0.0
 * @category models
 */
export const defaultServerOptions: ServerOptions = { host: "127.0.0.1", port: 7331 }

/**
 * Whether a host names this machine only.
 *
 * @param host the host to classify
 * @since 1.0.0
 * @category predicates
 */
export const isLoopbackHost = (host: string): boolean => GatewayServer.loopbackHostNames.includes(host)

/**
 * The typed refusal a requested bind earns, or `undefined` when it is allowed.
 *
 * Every start-time rule this module enforces answers here as a `bind_failed`
 * `GatewayError`, so a host that wants to report a refusal rather than crash on
 * one asks this before it composes a layer. {@link listenOptions} and
 * {@link layer} fail with exactly what this returns.
 *
 * @param options the requested bind
 * @since 1.0.0
 * @category constructors
 */
export const bindRefusal = (options: ServerOptions): GatewayError | undefined => {
  const setting = settingRefusal("The gateway keepalive cadence", options.heartbeatMillis) ??
    settingRefusal("The gateway request body limit", options.maxRequestBodyBytes)
  if (setting !== undefined) return setting
  // The bridge authenticates only with the bearer credential, even on
  // loopback, so a bridge without one would answer 401 to every request.
  if (options.runtimeBridge !== undefined && (options.credential === undefined || options.credential === "")) {
    return new GatewayError({
      code: "bind_failed",
      message: "Refusing to enable the runtime bridge without a bearer credential"
    })
  }
  const host = options.host ?? "127.0.0.1"
  if (isLoopbackHost(host)) return undefined
  if (options.listen !== true) {
    return new GatewayError({
      code: "bind_failed",
      message: `Refusing non-loopback gateway bind ${host} without an explicit --listen opt-in`
    })
  }
  if (options.credential === undefined || options.credential === "") {
    return new GatewayError({
      code: "bind_failed",
      message: `Refusing non-loopback gateway bind ${host} without a bearer credential`
    })
  }
  return undefined
}

/**
 * Applies the bind policy, returning the admitted Node options or a typed
 * `bind_failed` refusal.
 *
 * @param options the requested bind
 * @since 1.0.0
 * @category constructors
 */
export const listenOptions = (options: ServerOptions): Effect.Effect<ListenOptions, GatewayError> =>
  Effect.suspend(() => {
    const refusal = bindRefusal(options)
    if (refusal !== undefined) return Effect.fail(refusal)
    // `credential`, `listen`, and the keepalive cadence are this module's, not
    // `node:net`'s: they are named here so the rest is exactly a bind.
    const {
      allowedHosts: _allowedHosts,
      credential: _credential,
      heartbeatMillis: _cadence,
      listen: _listen,
      maxRequestBodyBytes: _maxBody,
      runtimeBridge: _runtimeBridge,
      ...node
    } = options
    return Effect.succeed({ ...node, host: node.host ?? "127.0.0.1" })
  })

/**
 * The authentication both RPC mounts run under.
 *
 * A configured credential authenticates every request that presents it and
 * stamps the same server-owned principal. A scoped token minted under that
 * credential (`@smthrs/control` `ScopedToken`) authenticates only the
 * procedures, run, or flow it names, until it expires, and stamps
 * {@link scopedPrincipal}. With no credential the composition is
 * loopback-only (see {@link listenOptions}) and every request runs as the
 * anonymous read principal. A session operator token alone stamps the local
 * operator for approval decisions; without it approvals are unauthorized.
 *
 * @param options the requested bind
 * @since 1.0.0
 * @category layers
 */
export const layerAuth = (options: ServerOptions): Layer.Layer<ControlRpcs.ControlAuth> =>
  options.credential === undefined || options.credential === ""
    ? ControlRpcs.layerAuth({
      authenticate: (headers) => {
        const token = options.operatorToken
        if (token === undefined || token === "") {
          return Effect.succeed({ id: "loopback", kind: "anonymous", stampedAt: 0 })
        }
        return ControlRpcs.bearerAuthenticator({
          token,
          principal: { id: "local", kind: "operator" }
        }).authenticate(headers).pipe(
          Effect.catchTag(
            "/control/Unauthorized",
            () => Effect.succeed({ id: "loopback", kind: "anonymous", stampedAt: 0 })
          )
        )
      }
    })
    : ControlRpcs.layerAuth(credentialAuthenticator(options.credential))

/**
 * The bearer credential itself, or a scoped token minted under it.
 *
 * The runtime bridge deliberately does not use this: it accepts the bearer
 * alone, because a scoped token names control procedures and the bridge's
 * versioned commands are not those.
 */
const credentialAuthenticator = (credential: string): ControlRpcs.Authenticator =>
  ControlRpcs.anyAuthenticator([
    ControlRpcs.bearerAuthenticator({ token: credential, principal: bearerPrincipal }),
    ScopedToken.authenticator({ key: credential, principal: scopedPrincipal })
  ])

/**
 * The identity stamped only after this gateway verifies its configured token.
 * Hosts may explicitly delegate operator decisions to this exact identity.
 * @category constants
 * @since 1.0.0
 */
export const bearerPrincipal = Object.freeze({ id: "gateway", kind: "bearer" })

/**
 * The protected mounts a scoped token may reach: those guarded in band by
 * `ControlAuth`, which checks each frame's procedure against the token, and
 * the ticket exchange that opens their sockets.
 * @category constants
 * @since 1.0.0
 */
export const scopedTokenPaths: ReadonlyArray<string> = ["/rpc", "/rpc/ws", "/projections", "/projections/ws", "/auth/ticket"]

/**
 * The identity stamped after this gateway verifies a scoped token minted
 * under its configured credential. It is its own kind so that delegating
 * approval to {@link bearerPrincipal} does not delegate it to every token
 * minted from the bearer; a host that wants a scoped `approve:runs` token to
 * decide delegates to this identity explicitly.
 * @category constants
 * @since 1.0.0
 */
export const scopedPrincipal = Object.freeze({ id: "gateway", kind: "scoped" })

/**
 * The ingress policy a requested bind runs behind.
 *
 * The accepted Host names are the loopback names, the operator's
 * `allowedHosts`, and the concrete bind host itself, so `--host 192.168.1.10`
 * is reachable at that address without naming it twice. A wildcard bind
 * (`0.0.0.0` or `::`) adds nothing: every interface is not a Host name, and
 * the operator names the reachable ones. Protected paths are authenticated
 * before any request body is read.
 *
 * @param options the requested bind
 * @since 1.0.0
 * @category constructors
 */
export const ingressOptions = (options: ServerOptions): GatewayServer.IngressOptions => {
  const maxRequestBodyBytes = options.maxRequestBodyBytes
  const host = options.host ?? "127.0.0.1"
  const allowedHosts = [...GatewayServer.loopbackHostHeaderNames, ...options.allowedHosts ?? []]
  const bindAuthority = URL.parse(`http://${host.includes(":") ? `[${host}]` : host}`)
  if (host !== "0.0.0.0" && host !== "::" && bindAuthority !== null && !allowedHosts.includes(bindAuthority.hostname)) {
    allowedHosts.push(bindAuthority.hostname)
  }
  if (options.credential === undefined || options.credential === "") {
    return {
      loopbackOnly: true,
      ...(maxRequestBodyBytes === undefined ? {} : { maxRequestBodyBytes }),
      allowedHosts
    }
  }
  // The edge knows no call, so a scoped token passes here on its signature
  // and expiry, and only toward the mounts whose every frame `ControlAuth`
  // judges in band; journal sync and the runtime bridge take the bearer alone.
  const bearer = ControlRpcs.bearerAuthenticator({ token: options.credential, principal: bearerPrincipal })
  const scoped = credentialAuthenticator(options.credential)
  return {
    allowedHosts,
    ...(maxRequestBodyBytes === undefined ? {} : { maxRequestBodyBytes }),
    authorize: (headers, path) =>
      (scopedTokenPaths.includes(path) ? scoped : bearer).authenticate(headers).pipe(
        Effect.match({ onFailure: () => false, onSuccess: () => true })
      )
  }
}

const bindFailure = (failure: ServeError | GatewayError): GatewayError =>
  new GatewayError({
    code: "bind_failed",
    message: "The gateway socket could not be bound",
    cause: { _tag: failure._tag }
  })

/**
 * Fails the layer with the sanitized refusal every bearer holder may see, after
 * logging the operator's copy: the requested authority and the operating-system
 * cause (`EADDRINUSE`, `EACCES`, `EADDRNOTAVAIL`), which the wire error omits.
 */
const mapServeError = <A, R>(
  bind: ListenOptions,
  server: Layer.Layer<A, ServeError | GatewayError, R>
): Layer.Layer<A, GatewayError, R> =>
  server.pipe(
    Layer.catch((failure) =>
      Layer.effectContext<A, GatewayError, never>(
        Effect.logError({
          message: "The gateway socket could not be bound",
          host: bind.host,
          port: bind.port,
          cause: failure
        }).pipe(Effect.andThen(Effect.fail(bindFailure(failure))))
      )
    )
  )

/**
 * Hosts the assembled gateway on an injected native HTTP server.
 *
 * Supplies the bind policy, the shared-credential authentication both RPC
 * mounts run under, and newline-delimited JSON as the wire serialization. The
 * caller supplies what the mounts read through: `Control`, `Projections`,
 * `SyncServer`, and the `SyncAuth` middleware.
 *
 * The returned layer retains the concrete `HttpServer` service, so a caller
 * that bound port 0 can read the ephemeral address it got.
 *
 * Policy refusals and operating-system listen failures both fail the layer as
 * sanitized `bind_failed` `GatewayError` values.
 *
 * @param health the identity `GET /health` answers with
 * @param options the requested bind
 * @since 1.0.0
 * @category layers
 */
export const makeLayer = (
  server: (options: ListenOptions) => Layer.Layer<HttpServer, ServeError | GatewayError>
) =>
(
  health: GatewayServer.Health,
  options: ServerOptions = defaultServerOptions
) =>
  Layer.unwrap(
    Effect.map(listenOptions(options), (nodeOptions) =>
      HttpRouter.serve(
        GatewayServer.layer(health, {
          ...(options.heartbeatMillis === undefined ? {} : { heartbeatMillis: options.heartbeatMillis }),
          ingress: ingressOptions(options),
          ...(options.runtimeBridge === undefined ? {} : {
            runtimeBridge: {
              ...options.runtimeBridge,
              authenticate: ControlRpcs.bearerAuthenticator({
                // listenOptions rejects a runtime bridge without a credential.
                token: options.credential!,
                principal: bearerPrincipal
              }).authenticate
            }
          })
        }).pipe(
          Layer.provide(layerAuth(options)),
          Layer.provide(RpcSerialization.layerNdjson)
        ),
        { disableListenLog: true, disableLogger: true }
      ).pipe(
        Layer.provideMerge(mapServeError(nodeOptions, server(nodeOptions)))
      ))
  )
