/** Private Node host boundary; the command surface lives in NodeControl.
 * @since 1.0.0
 */

import { NodeCrypto, NodeHttpClient, NodeServices } from "@effect/platform-node"
import type * as Undici from "@effect/platform-node/Undici"
import * as NodeFlowsRuntime from "@smthrs/flows/NodeRuntime"
import * as NodeGateway from "@smthrs/gateway/node/NodeGateway"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as EgressHttpClient from "@smthrs/platform-node/EgressHttpClient"
import { Effect, Exit, Layer, Scope, Semaphore } from "effect"
import * as ControlDatabase from "./ControlDatabase.ts"
import * as ControlFileSystem from "./ControlFileSystem.ts"
import * as NativeControl from "./NativeControl.ts"

/**
 * Respect the supplied environment's egress proxy without changing unproxied Node hosts.
 *
 * The one definition lives in `@smthrs/platform-node`, so the dispatcher a
 * transport rebuilds and the client a judge dials through are built by the
 * same code. This name is the CLI's spelling of it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const environmentDispatcher = EgressHttpClient.dispatcher

/**
 * The outbound HTTP client this process should use, given the environment it
 * runs in: Undici through the egress proxy the environment names, and the
 * plain Undici pool when it names none.
 *
 * Provide this, never `NodeHttpClient.layerUndici`, under any layer that takes
 * `HttpClient` from context. The bare client ignores `HTTP_PROXY`/`HTTPS_PROXY`
 * and dials every origin directly, which a default-deny sandbox drops.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerEgressHttpClient = EgressHttpClient.layer

/**
 * A replaceable HTTP transport over Undici, given a way to acquire a dispatcher.
 *
 * `RequestExecutor` asks a host for two things: the client to use now, and an
 * effect that builds another. A retry ladder repairs a failure by
 * waiting and a destroyed HTTP/2 session is the failure waiting does not
 * repair. Undici's dispatcher *is* the connection pool, so on Node the
 * replacement is a new one.
 *
 * Each dispatcher is acquired in a scope forked off the caller's, and the
 * previous scope is closed the moment the next dispatcher is in hand, so a run
 * that rebuilds many times still holds exactly one pool and the caller's own
 * teardown closes the last of them. The *first* client is built by this same
 * code rather than taken from `NodeHttpClient.layerUndici`, so the client the
 * executor starts on and the client a rebuild produces are made the same way
 * and owned the same way.
 *
 * `acquire` is a parameter so a test can hand it a scripted dispatcher; the
 * production caller passes `environmentDispatcher(process.env)`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const rebuildableTransport = (
  acquire: Effect.Effect<Undici.Dispatcher, never, Scope.Scope>
): Effect.Effect<RequestExecutor.Transport, never, Scope.Scope> =>
  Effect.gen(function*() {
    const scope = yield* Scope.Scope
    const gate = yield* Semaphore.make(1)
    let held: Scope.Closeable | undefined = undefined
    const rebuild = gate.withPermit(Effect.gen(function*() {
      const owned = yield* Scope.fork(scope)
      const client = yield* NodeHttpClient.makeUndici.pipe(
        Effect.provideServiceEffect(NodeHttpClient.Dispatcher, acquire),
        Effect.provideService(Scope.Scope, owned)
      )
      const previous = held
      held = owned
      if (previous !== undefined) yield* Scope.close(previous, Exit.void)
      return client
    }))
    return { client: yield* rebuild, rebuild }
  })

/**
 * The model transport every Node host in this repository runs on: an Undici
 * agent the run may replace.
 *
 * It is one constructor rather than one per host because the repair it carries
 * is not specific to any of them. `smithers run` had it and a second host once
 * did not, and the difference was one line: that host bound
 * `RequestExecutor.layer` over `NodeHttpClient.layerUndici`, whose transport is
 * {@link RequestExecutor.fixed} and whose rebuild hands back the pool that just
 * failed. A server whose provider session the peer destroyed therefore failed
 * every later turn identically until somebody restarted it.
 *
 * `acquire` is the dispatcher the pool is built from, so a caller passes
 * {@link environmentDispatcher} over its own environment record and a test
 * passes a scripted dispatcher.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerRebuildableRequestExecutor = (
  acquire: Effect.Effect<Undici.Dispatcher, never, Scope.Scope>
): Layer.Layer<RequestExecutor.RequestExecutor> =>
  Layer.effect(
    RequestExecutor.RequestExecutor,
    Effect.flatMap(rebuildableTransport(acquire), RequestExecutor.makeWith)
  )

/** The production model transport, replaceable only at the composition boundary. */
const layerRequestExecutor: Layer.Layer<RequestExecutor.RequestExecutor> = layerRebuildableRequestExecutor(
  environmentDispatcher(process.env)
)

/** Selects existing Node adapters for the shared native composition.
 * @since 1.0.0
 * @private
 */
export const platform: NativeControl.Platform = {
  host: Layer.provideMerge(ControlFileSystem.layer(), NodeServices.layer),
  crypto: NodeCrypto.layer,
  database: (file) => ControlDatabase.layer(file).pipe(Layer.orDie),
  runtime: NodeFlowsRuntime.layer,
  jj: NodeJj.layerAt,
  requestExecutor: layerRequestExecutor,
  gateway: NodeGateway.layer,
  bearerPrincipal: NodeGateway.bearerPrincipal
}

/** Default CLI composition; private configured hosts reuse the same adapters.
 * @since 1.0.0
 * @private
 */
export const native = NativeControl.make(platform)
