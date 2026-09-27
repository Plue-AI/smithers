# The Worker as Effects

`apps/server` is one Effect program from the request to every upstream call
and every Durable Object. This page is the map: the entrypoint, how services
and Layers compose, where the platform boundaries are, how to add a service,
and the check that keeps promise interop out of the middle.

Effect v4 (`effect@4.0.0-rc.115`) is authoritative. When an API is in doubt,
read `node_modules/effect/src/*.ts`; there is no v3 idiom in this package
(`Context.Service`, not `Context.Tag`; `Effect.catch`, not `catchAll`).

## Entrypoints

There is one: `src/index.ts` `export default`, workerd's
`fetch(request, env, ctx)` shape, deployed by wrangler (`wrangler.jsonc`
`main`) and run as-is by the tests and the local host, with `runRequest` in
`src/Boundary.ts` as its adapter.

It calls the router, `handleRequest(request)` in `src/index.ts`, an
`Effect<Response, never, RequestServices>`: typed failures are already mapped
to responses inside, so the error channel is `never`, and everything it needs
is a service.

`RequestServices = AllServices | ExecutionContext` (`src/Environment.ts`).
`AllServices` is everything one *deployment* provides — one isolate's worth of
services, built once from the env bag by `layersFromEnv`. `ExecutionContext`
is the one service that belongs to a single *request*, because `waitUntil` is
this invocation's: work a route forks through it (a turn's settlement after the
client hangs up) keeps the isolate alive past the response. Each adapter
therefore provides two things — the isolate's `AllServices` context and its own
`ExecutionContext` — and neither adapter can accidentally share a `waitUntil`
between requests, because the type will not let it.

### Durable Objects

Each Durable Object module exports, in this order of importance:

1. `<name>Request(request): Effect<Response, never, DurableStorage>` (or
   `RecommendStorage` for the recommender's ring), the whole class body as an
   Effect over the storage service. Storage failures are handled inside, the
   clock is `Clock.currentTimeMillis`.
2. The native class (`class TurnCancelRegistry { fetch(request) { return
   runDurable(...) } }`), kept for tests and the local host; its `fetch` line
   is a declared boundary (below).
3. The Worker-side service (`TurnCancels`, `TurnLimits`,
   `ClientErrors`, `RecommendLogStore`) and its Layer constructor from a
   `NativeNamespace | undefined` (undefined = the binding is absent, unit-test
   behaviour).

The native class (2) is what deploys: workerd constructs it with
`(ctx, env)`, it builds the module's Layers from `ctx.storage` (`storageLayer`
in `src/DurableStorage.ts`, `recommendStorageLayer` in `src/recommend.ts`)
once, and its `fetch` line runs the request Effect over them through
`runDurable`.

**A Durable Object's in-memory state is made once by the object.** The object,
not the request, is the thing that remembers. `ClientErrorThrottle` — the
throttle window, a `Ref<ClientErrorWindow>` from `makeClientErrorThrottle()` —
is created in the native class's field initialiser (`src/clientErrorLog.ts`),
so `clientErrorLogRequest` requires `DurableStorage | ClientErrorThrottle`. A
window rebuilt per request throttles nothing. The same rule governs any future
per-object counter, cache or lock.

`GatewaySessionRegistry` is a retired class (`src/retainedDurableObjects.ts`):
the flow and setup routes it served are the Smithers backend's, forwarded by
`forwardToCloud` (`src/proxies.ts`).

Why both names survive adoption, briefly (DEPLOY.md has the procedure): the
binding is declared in `env` with the props form
`Cloudflare.DurableObject("TURN_CANCELS", { className: "TurnCancelRegistry" })`,
which is a plain descriptor `{ kind, name: "TURN_CANCELS", className:
"TurnCancelRegistry" }` (`DurableObject.ts:1260-1268`) lowered to
`{ type: "durable_object_namespace", name: "TURN_CANCELS", className:
"TurnCancelRegistry" }` (`WorkerAsyncBindings.ts:464-471`), and the class is
exported under `TurnCancelRegistry`. The class-form
`Cloudflare.DurableObject<Self>()("Name")` cannot do this: it binds
`{ name: namespace, className: namespace }` (`DurableObject.ts:1148-1153`) and
exports under the same string (`:1251`).

## Services and Layers

Every dependency is a `Context.Service` with a Layer constructor, and every
handler declares what it needs in its `R`:

| Service | Module | Layer | What it wraps |
| --- | --- | --- | --- |
| `ServerConfig` | `src/Config.ts` | `configLayer(env)` | vars and `Redacted` secrets, read once |
| `Transport` | `src/Http.ts` | `TransportLive`, `transportLayer(fetch)` | outbound fetch with a header-only deadline |
| `TerminalSockets` | `src/terminalRelay.ts` | `terminalSocketsLayer` | workerd WebSocketPair and upgrade response; relay listeners live until either peer closes |
| `Assets`, `BrowserEgress` | `src/Environment.ts` | `assetsLayer`, `browserEgressLayer` | the `ASSETS` and `BROWSER_EGRESS` fetchers |
| `TurnCancels`, `TurnLimits`, `ClientErrors`, `RecommendLogStore` | their modules | `<x>Layer(namespace \| undefined)` | one Durable Object namespace each |
| `ModelPayer` | `src/modelPayer.ts` | `paidBy(login)` (a `Context.Reference`, default visitor) | who pays a model call: a login's goes through Smithers Cloud's metered proxy on its Cloud token; a visitor's keeps the deployment key |
| `EdgeCache`, `GithubAppAuth` | `src/githubApp.ts` | `edgeCacheLayer(cache)`, `githubAppAuthLayer` | the Cache API and the single-flight App mint |
| `DeploymentBindings` | `src/Environment.ts` | `deploymentBindingsLayer(env)` | which optional bindings this deployment has, so admin reads answer honestly |
| `ExecutionContext` | `src/Environment.ts` | `Effect.provideService(ExecutionContext, executionContextFrom(ctx))` | this request's `waitUntil`; provided by the adapter, never by `layersFromEnv` |
| `DurableStorage` / `RecommendStorage` | `src/DurableStorage.ts`, `src/recommend.ts` | `storageLayer(native)`, `recommendStorageLayer(native)` | a Durable Object's own storage, inside the object |
| `ClientErrorThrottle` | `src/clientErrorLog.ts` | `clientErrorThrottleLayer(makeClientErrorThrottle())` | one object's throttle window, made once per in-memory object |

`layersFromEnv(env)` in `src/Environment.ts` is the one composition point; it
returns `Layer<AllServices>` — everything except `ExecutionContext`, which the
adapter adds per request. `runtimeFor(env)` memoizes a `ManagedRuntime` per env
object in a `WeakMap`, so an isolate's services outlive one request while two
env bags never share a credential. Tests provide what they need directly:
`Effect.runPromise(effect.pipe(Effect.provide(testConfigLayer({...}))))`,
with `transportLayer(fakeFetch)` instead of patching `globalThis.fetch` and
`memoryStorage()` for a Durable Object body.

There is no BYOK. `jevEvaluate` and `cerebrasChat` read `ModelPayer`: a
signed-in turn, Recommend, Jev relay or model Test posts to
`{cloudApiBaseUrl}/api/model/{cerebras|vercel}/...` with the login's Cloud
token, and Plue's 402 `out_of_credit` is relayed under Plue's own code (it
lives in `PlueFailureCodes`, not the Worker's table). `AccountModelVault` stays exported only as deployment identity and
answers 410.

Failures are typed in `src/Failures.ts` (`UpstreamTimeout`,
`UpstreamUnreachable`, `BodyTooLarge`, `BodyNotJson`, `StorageFailure`,
`CryptoFailure`, `NotConfigured`, ...) and mapped to responses where the
route maps them, with the same status codes and message text as before. An
interruption is never a 500: `src/Boundary.ts` answers 499.

## Boundaries

Promise interop exists in exactly these places:

- `src/Http.ts`: `Transport` over `fetch`, bounded body readers over
  `ReadableStream` readers.
- `src/DurableStorage.ts` (and `recommendStorageFrom` in `src/recommend.ts`):
  `Effect.tryPromise` over the platform storage.
- `src/Boundary.ts`: `runRequest` (request abort ⇒ fiber interruption ⇒ 499)
  and `runDurable`, for the native adapter and the native Durable Object
  classes; `responseFromExit` is the pure policy both entrypoints share
  (success / 499 for interrupts-only / a logged, generic 500 with the
  isolation headers for a defect).
- The native Durable Object class `fetch` methods, one line each, marked
  `// effect-policy: boundary`.
- WebCrypto and stream readers, wrapped once in `Effect.tryPromise` where
  they are used.

Web `ReadableStream` response bodies are built at the boundary; inside, a
stream is an Effect `Stream` or a forked fiber writing to a `ReadableStream`
whose finalizers settle the registry and release the upstream body.

## Adding a service

1. Declare it: `export class Thing extends Context.Service<Thing,
   ThingShape>()("smithers-server/Thing") {}` in its module, with a shape of
   Effects, and a Layer constructor from the native binding or from other
   services (`Layer.succeed`, `Layer.effect`).
2. Compose it: add the Layer to `layersFromEnv` in `src/Environment.ts` and
   the tag to `AllServices` (or to `RequestServices` only, if it is per
   request like `ExecutionContext`, and provide it in both adapters). If it
   is a Durable Object's own in-memory state, it is a `Ref` the object makes
   once — see above. If it needs a new binding, add the binding to
   `WORKER_IDENTITY` (`src/workerIdentity.ts`), to `WorkerEnv`, and, if it is
   a secret, to `WORKER_IDENTITY.secrets` and, once, `wrangler secret put`;
   `wrangler.jsonc` declares the rest, and `src/workerIdentity.test.ts` holds
   the two together.
3. Use it: `yield* Thing` inside the handler; the handler's `R` grows by
   `Thing` and the compiler tells every caller.
4. Test it with an injected Layer, not with a global patch. Keep state that
   must survive across requests inside the constructed service (the isolate
   context is built once), never in a per-request closure.
5. Run `pnpm run check` (`tsc --noEmit` and the policy below).

## The policy check

`pnpm run check:effect` runs `scripts/effect-policy.ts`, which scans every
`src/**/*.ts` that is not a test and fails on `async `, `await `, `.then(`,
`Effect.runPromise`, `Effect.runFork`, `runWeb`, or `EffectPlatform` outside
the allowlist (`src/Http.ts`, `src/DurableStorage.ts`, `src/Boundary.ts`)
and off a line carrying `// effect-policy: boundary`, which
is reserved for a native Durable Object class's `fetch`. Comments are stripped
first, so prose may say the words. `scripts/effect-policy.test.ts` holds the
scanner to fixtures.

## Deploying

`DEPLOY.md`: the frozen identity, the preflight
(`scripts/adopt-durable-objects.ts`), the secrets list, dry runs, rollback.

One rule worth repeating here, because it bites in this file's territory:
**`wrangler deploy --dry-run` is not the identity verdict.** It bundles the
Worker and reads the assets with no credential and no live read, so it says
nothing about the Durable Objects the live script carries. The preflight is
the verdict.
