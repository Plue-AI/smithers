/**
 * The outbound HTTP client a Node process should use, read off its environment.
 *
 * `@effect/platform-node` ships `NodeHttpClient.layerUndici`, and its
 * dispatcher is a bare Undici `Agent`. A bare `Agent` dials every origin
 * directly: it does not read `HTTP_PROXY`, `HTTPS_PROXY` or `NO_PROXY`, and
 * nothing at the call site says so. That is invisible on a developer machine
 * with open egress and fatal inside a sandbox whose egress is default-deny
 * behind a named proxy — the request leaves for the origin, the firewall drops
 * it, and the only symptom is a transport failure far from the composition
 * that chose the client.
 *
 * This module is the one place that decision is made. {@link layer} is the
 * client every Node host composition installs; it honours the proxy the
 * environment names and is exactly `NodeHttpClient.layerUndici` when the
 * environment names none, so an unproxied host is unchanged.
 *
 * The rule for loopback is fixed here, not by the environment: `localhost`,
 * `127.0.0.1` and `[::1]` are always reached directly, even when the
 * environment names a proxy and no exclusion, and every other origin follows
 * `NO_PROXY`. A proxy is how a process leaves its machine, and
 * `--remote http://127.0.0.1:3000` is not leaving it. The exemption is those
 * three names and nothing wider: Undici matches `NO_PROXY` entries by name,
 * never by resolved address, so `127.0.0.2` or a hostname that resolves to
 * loopback is an origin like any other and goes through the proxy.
 *
 * @since 1.0.0-rc.0
 */

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import type * as Undici from "@effect/platform-node/Undici"
import { GrantStore } from "@smthrs/kernel/GrantStore"
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import { HttpClient } from "effect/unstable/http/HttpClient"

/**
 * The hosts a proxy is never for. A proxy is how a process leaves its machine;
 * these names are the machine itself. Matched by name, the way Undici matches
 * every `NO_PROXY` entry, so the list is exactly these three and not
 * `127.0.0.0/8`.
 */
const loopback = ["localhost", "127.0.0.1", "::1"] as const

/**
 * The exclusion list to hand Undici, given the one the environment names.
 *
 * Undici proxies *every* origin when `NO_PROXY` is empty — `#shouldProxy`
 * returns early with "Always proxy if NO_PROXY is not set or empty" — so a host
 * that names a proxy to reach the internet would also send `smthrs --remote
 * http://127.0.0.1:3000` and a local Ollama at `http://localhost:11434` to it.
 * Nothing in this repository has ever needed `NO_PROXY=127.0.0.1`, because the
 * client these compositions used before ignored the proxy variables outright.
 * So loopback is always excluded, the way Go's `net/http.ProxyFromEnvironment`
 * excludes it, and the environment's own entries are kept beside it.
 *
 * `*` is returned untouched: Undici recognises the wildcard only as the entire
 * value, and it already means every origin is direct.
 */
const exclusions = (declared: string): string =>
  declared === "*" ? declared : [declared, ...loopback].filter((entry) => entry !== "").join(",")

/**
 * An Undici dispatcher that routes through the egress proxy the supplied
 * environment names, or a direct one when it names none.
 *
 * The proxy variables are read in the order Undici itself reads them,
 * lowercase first, and passed explicitly rather than left to
 * `EnvHttpProxyAgent`'s own ambient lookup: a host serving a guest's
 * environment is not the guest, and the pool has to follow the record it was
 * handed. Loopback is always direct; see {@link exclusions}. Each dispatcher is
 * acquired in the caller's scope and destroyed with it, so a composition that
 * builds several still owns every pool it opened.
 *
 * @param environment the environment record whose proxy variables decide the route
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const dispatcher = (
  environment: Readonly<Record<string, string | undefined>>
): Effect.Effect<Undici.Dispatcher, never, Scope.Scope> =>
  Effect.suspend(() => {
    const httpProxy = environment.http_proxy ?? environment.HTTP_PROXY ?? ""
    const httpsProxy = environment.https_proxy ?? environment.HTTPS_PROXY ?? ""
    const noProxy = exclusions(environment.no_proxy ?? environment.NO_PROXY ?? "")
    if (!httpProxy && !httpsProxy) return NodeHttpClient.makeDispatcher
    // Explicit empty values prevent Undici from falling back to a different
    // ambient environment. Each replacement pool uses the same proxy policy.
    //
    // Undici is loaded here rather than imported at the top, the way
    // `NodeHttpClient.makeDispatcher` loads it, because this module is imported
    // by `NodeHost` and every bundle built on it. A static import pulls the
    // whole of Undici into any process that merely composes a host, whose
    // side effects a host bundle must not carry: it reddened the Node host's
    // own `FileSystem` contract case, which never makes a request.
    return Effect.acquireRelease(
      Effect.map(
        Effect.promise(() => import("@effect/platform-node/Undici")),
        (undici) => new undici.EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy })
      ),
      (dispatcher) => Effect.promise(() => dispatcher.destroy())
    )
  })

/**
 * The Undici `HttpClient` to install, given the environment the process runs in.
 *
 * Use this wherever `NodeHttpClient.layerUndici` would otherwise be provided
 * under a layer that takes `HttpClient` from context — a model transport, a
 * judge, a fetch rule, a host bundle. The two differ only in whether the pool
 * honours `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`, which is the difference
 * between a request that reaches the gateway from inside a default-deny
 * sandbox and one the firewall drops.
 *
 * @param environment the environment record whose proxy variables decide the route
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = (
  environment: Readonly<Record<string, string | undefined>>
): Layer.Layer<HttpClient> =>
  NodeHttpClient.layerUndiciNoDispatcher.pipe(
    Layer.provide(Layer.effect(NodeHttpClient.Dispatcher)(dispatcher(environment)))
  )

/**
 * Owns one replaceable Undici pool in the caller's scope. Each replacement
 * receives the same middleware and closes the previous pool.
 *
 * @category constructors
 * @since 1.0.0
 */
export const rebuildableTransport = (
  acquire: Effect.Effect<Undici.Dispatcher, never, Scope.Scope>,
  decorate: (client: HttpClient) => Effect.Effect<HttpClient> = Effect.succeed
): Effect.Effect<
  {
    readonly client: HttpClient
    readonly rebuild: Effect.Effect<HttpClient>
  },
  never,
  Scope.Scope
> =>
  Effect.gen(function*() {
    const scope = yield* Scope.Scope
    const gate = yield* Semaphore.make(1)
    let held: Scope.Closeable | undefined = undefined
    const rebuild = gate.withPermit(Effect.uninterruptibleMask((restore) =>
      Effect.gen(function*() {
        const owned = yield* Scope.fork(scope)
        const client = yield* restore(NodeHttpClient.makeUndici.pipe(
          Effect.provideServiceEffect(NodeHttpClient.Dispatcher, acquire),
          Effect.flatMap(decorate),
          Effect.provideService(Scope.Scope, owned)
        )).pipe(Effect.onExit((exit) => Exit.isSuccess(exit) ? Effect.void : Scope.close(owned, exit)))
        const previous = held
        held = owned
        if (previous !== undefined) yield* Scope.close(previous, Exit.void)
        return client
      })
    ))
    return { client: yield* rebuild, rebuild }
  })

/**
 * A model transport whose replacements retain the caller's grant store and
 * environment proxy policy. Pass it to RequestExecutor.makeWith in the host scope.
 *
 * @category constructors
 * @since 1.0.0
 */
export const guardedTransport = (environment: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function*() {
    const grants = yield* GrantStore
    return yield* rebuildableTransport(dispatcher(environment), (client) =>
      HttpClient.pipe(Effect.provide(KernelHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(HttpClient)(client)),
        Layer.provide(Layer.succeed(GrantStore)(grants))
      ))))
  })
