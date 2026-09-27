import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Option from "effect/Option"
import { browserFetch, resolveHostOverHttps } from "@smthrs/rpc/BrowserFetch"
import type { BrowserFetchOutcome } from "@smthrs/rpc/BrowserFetch"
import { fiberPromise } from "./Boundary"
import { clientErrorsLayer } from "./clientErrorLog"
import type { ClientErrors } from "./clientErrorLog"
import { configLayer } from "./Config"
import type { ServerConfig, ServerEnvVars } from "./Config"
import type { NativeNamespace } from "./DurableStorage"
import { UpstreamUnreachable } from "./Failures"
import { edgeCacheLayer, githubAppAuthLayer } from "./githubApp"
import type { EdgeCache, GithubAppAuth } from "./githubApp"
import { TransportLive } from "./Http"
import { TerminalSockets, terminalSocketsLayer } from "./terminalRelay"
import type { Transport } from "./Http"
import { recommendLogLayer } from "./recommend"
import type { RecommendLogStore } from "./recommend"
import { turnLimitsLayer } from "./turnLimit"
import type { TurnLimits } from "./turnLimit"
import { turnCancelsLayer } from "./turns"
import type { TurnCancels } from "./turns"

/*
 * The deployment as the Worker's Effects see it. workerd hands the native
 * adapter an `env` bag of vars, secrets, and bindings (wrangler.jsonc; the
 * wrangler.jsonc binds the same names); `layersFromEnv` turns
 * that bag into the Layer every route runs under, one service per binding,
 * and `runtimeFor` keeps the services built from one bag alive for as long
 * as the bag is — one isolate, in production.
 *
 * The structurally-typed bindings keep this Worker free of a workers-types
 * dependency: a binding is only ever the surface a service needs.
 */

/** A service binding or the assets binding: one `fetch`. */
export interface NativeFetcher {
  readonly fetch: (request: Request) => Promise<Response>
}

export interface WorkerEnv extends ServerEnvVars {
  /** Optional during rollout; absent disables only account credential enrollment. */
  readonly MODEL_VAULTS?: NativeNamespace
  /** The smithers.sh site build: the landing page, the docs, the app documents. */
  readonly ASSETS: NativeFetcher
  /** Trusted service implementing docs/browser-egress.md's pinned HTTPS transport. */
  readonly BROWSER_EGRESS?: NativeFetcher
  /**
   * The per-runId cancellation registry (Durable Object). Bound on every real
   * deployment (src/workerIdentity.ts), and tests drive the real class over
   * in-memory storage (src/memoryDurableObjects.ts).
   */
  readonly TURN_CANCELS: NativeNamespace
  /**
   * The per-login turn ceiling (Durable Object keyed by the validated login).
   * An abuse guard on a comped seam, not a billing pause — see turnLimit.ts.
   * Unset in unit tests and the stub stack, where it fails open.
   */
  readonly TURN_LIMITS?: NativeNamespace
  /**
   * The bounded client-error log (one Durable Object for the deployment),
   * read back through GET /api/admin/errors. Unset in unit tests, where the
   * handler keeps its console.error and nothing is stored.
   */
  readonly CLIENT_ERRORS?: NativeNamespace
  /**
   * The command recommender's log (one Durable Object for the deployment),
   * read back through GET /api/admin/recommend/log.
   */
  readonly RECOMMEND_LOG?: NativeNamespace
}

/* ------------------------------------------------------------------------ */
/* Assets                                                                    */
/* ------------------------------------------------------------------------ */

export interface AssetsShape {
  readonly fetch: (request: Request) => Effect.Effect<Response, UpstreamUnreachable>
}

export class Assets extends Context.Service<Assets, AssetsShape>()("smithers-server/Assets") {}

/** A binding's `fetch` as an Effect: the fiber's signal rides the request, so an interruption aborts it. */
const bindingFetch = (seam: string, native: NativeFetcher) => (request: Request) =>
  Effect.tryPromise({
    try: (signal) => native.fetch(new Request(request, { signal: AbortSignal.any([request.signal, signal]) })),
    catch: (cause) => new UpstreamUnreachable({ seam, cause })
  })

export const assetsLayer = (native: NativeFetcher): Layer.Layer<Assets> =>
  Layer.succeed(Assets, { fetch: bindingFetch("The site build", native) })

/* ------------------------------------------------------------------------ */
/* Browser egress (optional)                                                 */
/* ------------------------------------------------------------------------ */

/**
 * The browser tool's pinned-HTTPS reader (Wave 10, §2d): server-side, hard-
 * guarded (https only, public hosts only after DNS resolution, size cap,
 * timeout, no cookies, declared user-agent), connecting to the resolved
 * address through the BROWSER_EGRESS binding.
 */
export interface BrowserEgressShape {
  readonly read: (url: string) => Effect.Effect<BrowserFetchOutcome, UpstreamUnreachable>
}

/**
 * Optional, and honestly so: a deployment without the binding provides
 * `Option.none()`, has no `browser.read` capability, and the route says so.
 */
export class BrowserEgress extends Context.Service<BrowserEgress, Option.Option<BrowserEgressShape>>()("smithers-server/BrowserEgress") {}

const BROWSER_EGRESS_URL = "https://browser-egress.internal/fetch"

const browserEgressFrom = (native: NativeFetcher): BrowserEgressShape => ({
  read: (url) =>
    Effect.tryPromise({
      // One promise boundary around the guarded read: the library's own
      // timeout and the fiber's signal both abort the binding request.
      try: (signal) =>
        browserFetch(url, {
          resolveHost: resolveHostOverHttps,
          fetchImpl: (target, init, address) =>
            native.fetch(
              new Request(BROWSER_EGRESS_URL, {
                method: "POST",
                redirect: "manual",
                signal: init.signal === undefined || init.signal === null ? signal : AbortSignal.any([init.signal, signal]),
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  version: 1,
                  url: target,
                  address,
                  method: "GET",
                  headers: Object.fromEntries(new Headers(init.headers))
                })
              })
            )
        }),
      catch: (cause) => new UpstreamUnreachable({ seam: "The browser egress", cause })
    })
})

export const browserEgressLayer = (native: NativeFetcher | undefined): Layer.Layer<BrowserEgress> =>
  Layer.succeed(BrowserEgress, native === undefined ? Option.none() : Option.some(browserEgressFrom(native)))

/* ------------------------------------------------------------------------ */
/* Which bindings the deployment has                                         */
/* ------------------------------------------------------------------------ */

/**
 * The admin log reads answer honestly when nothing can be stored: without the
 * binding the log is always empty, and the answer says so instead of looking
 * like a deployment where nothing has broken. `cloudApi` is whether the
 * deployment SET a Cloud API base (the bootstrap's `cloud` capability):
 * `ServerConfig.cloudApiBaseUrl` always has a value, so only the env can say.
 */
export interface DeploymentBindingsShape {
  readonly clientErrors: boolean
  readonly recommendLog: boolean
  readonly cloudApi: boolean
}

export class DeploymentBindings
  extends Context.Service<DeploymentBindings, DeploymentBindingsShape>()("smithers-server/DeploymentBindings") {}

export const deploymentBindingsLayer = (env: WorkerEnv): Layer.Layer<DeploymentBindings> =>
  Layer.succeed(DeploymentBindings, {
    clientErrors: env.CLIENT_ERRORS !== undefined,
    recommendLog: env.RECOMMEND_LOG !== undefined,
    cloudApi: (env.SMITHERS_CLOUD_API_BASE_URL?.trim() ?? "") !== ""
  })

/* ------------------------------------------------------------------------ */
/* The request's execution context                                           */
/* ------------------------------------------------------------------------ */

/** The platform's per-request context: `waitUntil` keeps work alive past the response. */
export interface NativeExecutionContext {
  readonly waitUntil: (promise: Promise<unknown>) => void
}

/**
 * Work that must finish after the response has been sent (a turn's
 * settlement once the client hung up). It runs in its own fiber, and when
 * the platform gave us a context, that fiber's completion is what
 * `waitUntil` holds the isolate open for.
 */
export interface ExecutionContextShape {
  readonly waitUntil: <A, E>(work: Effect.Effect<A, E>) => Effect.Effect<Fiber.Fiber<A, E>>
}

export class ExecutionContext extends Context.Service<ExecutionContext, ExecutionContextShape>()("smithers-server/ExecutionContext") {}

export const executionContextFrom = (ctx: NativeExecutionContext | undefined): ExecutionContextShape => ({
  waitUntil: (work) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkDetach(work)
      // The one place an Effect is handed to the platform as a promise: the
      // fiber's exit, which never rejects, is what workerd waits for
      // (src/Boundary.ts is the module that owns that conversion).
      if (ctx !== undefined) ctx.waitUntil(fiberPromise(fiber))
      return fiber
    })
})

/* ------------------------------------------------------------------------ */
/* The whole deployment                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Every service the deployment provides for the life of an isolate.
 * `ExecutionContext` is the one per-request service: the entry
 * (src/index.ts) provides it beside these, and the router requires
 * `RequestServices`.
 */
export type AllServices =
  | ServerConfig
  | Transport
  | TerminalSockets
  | Assets
  | BrowserEgress
  | DeploymentBindings
  | TurnCancels
  | TurnLimits
  | ClientErrors
  | RecommendLogStore
  | EdgeCache
  | GithubAppAuth

/** What one request runs under: the isolate's services plus its own execution context. */
export type RequestServices = AllServices | ExecutionContext

/** The platform edge cache, when the runtime has one (workerd does; bun does not). */
const platformEdgeCache = (): Cache | undefined =>
  (globalThis as typeof globalThis & { caches?: CacheStorage & { default?: Cache } }).caches?.default

/** The Layer one deployment's routes run under. */
export const layersFromEnv = (env: WorkerEnv): Layer.Layer<AllServices> => {
  const base = Layer.mergeAll(configLayer(env), TransportLive, edgeCacheLayer(platformEdgeCache()))
  return Layer.mergeAll(
    base,
    terminalSocketsLayer,
    assetsLayer(env.ASSETS),
    browserEgressLayer(env.BROWSER_EGRESS),
    deploymentBindingsLayer(env),
    turnCancelsLayer(env.TURN_CANCELS),
    turnLimitsLayer(env.TURN_LIMITS),
    clientErrorsLayer(env.CLIENT_ERRORS),
    recommendLogLayer(env.RECOMMEND_LOG),
    Layer.provide(githubAppAuthLayer, base)
  )
}

/*
 * One runtime per env bag. workerd hands every request of an isolate the same
 * `env` object, so the services built from it (the GitHub App single-flight
 * mint, the catalog cache) live for the
 * isolate and every request reuses them. A test builds a fresh bag per case
 * and so gets fresh services; two bags never share a credential.
 */
const runtimes = new WeakMap<WorkerEnv, ManagedRuntime.ManagedRuntime<AllServices, never>>()

export const runtimeFor = (env: WorkerEnv): ManagedRuntime.ManagedRuntime<AllServices, never> => {
  const existing = runtimes.get(env)
  if (existing !== undefined) return existing
  const runtime = ManagedRuntime.make(layersFromEnv(env))
  runtimes.set(env, runtime)
  return runtime
}
