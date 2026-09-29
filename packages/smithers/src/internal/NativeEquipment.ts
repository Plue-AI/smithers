/** Shared native agent equipment; the platform supplies its request executor.
 * @since 1.0.0
 */

import * as FlowEngineLike from "@smthrs/agent/FlowEngineLike"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as SeatRouter from "@smthrs/agent/SeatRouter"
import * as StandardFlows from "@smthrs/agent/StandardFlows"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import type * as Sandbox from "@smthrs/harness/Sandbox"
import type * as KernelChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as Auth from "@smthrs/model/Auth"
import * as Endpoint from "@smthrs/model/Endpoint"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as EvaluatorBackup from "@smthrs/model/EvaluatorBackup"
import type * as ModelError from "@smthrs/model/ModelError"
import * as OpenAIChatGPT from "@smthrs/model/OpenAIChatGPT"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Route from "@smthrs/model/Route"
import * as EgressHttpClient from "@smthrs/platform-node/EgressHttpClient"
import type * as Checkpoints from "@smthrs/std/Checkpoints"
import * as Container from "@smthrs/std/Container"
import * as TestRunner from "@smthrs/std/TestRunner"
import { Clock, Context, Effect, Layer, Redacted } from "effect"
import type { Path, Result } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import type * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { homedir } from "node:os"
import { isAbsolute, relative } from "node:path"
import * as CliError from "../CliError.ts"
import * as CodexAuth from "../CodexAuth.ts"
import * as Environment_ from "../Environment.ts"
import * as Providers from "../Providers.ts"
import * as ClaudeCode from "./ClaudeCode.ts"
import { readText } from "./HostFiles.ts"

const apiKeyVariable: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY"
}

/**
 * How the `openai` provider authenticates. `api-key` is the default and the
 * only mode the other providers have. `chatgpt` routes the same seat strings
 * to the ChatGPT-subscription backend on the codex CLI's OAuth session, so a
 * lane opts in through the environment without respelling any seat: the
 * journaled seat, its context window, and its committed price stay identical.
 */
const openaiAuthVariable = "SMITHERS_OPENAI_AUTH"

/**
 * A Smithers account pool (`SMITHERS_ACCOUNT_POOL_URL`, `{base}/provider-pool`)
 * holding connected Codex accounts. `SMITHERS_ACCOUNT_POOL_PROVIDERS` lists the
 * routes (`chatgpt`) the host may take to it and `SMITHERS_ACCOUNT_POOL_KEY`
 * holds the pool credential. Which routes have accounts the pool answers at
 * `GET {pool}/routes`, asked when a seat resolves and remembered briefly, so an
 * account connected after boot serves the next seat: the openai seat then runs
 * in ChatGPT mode against `${pool}/chatgpt`. The pool picks the account per
 * request. A Claude subscription has no pool route: Anthropic lets only Claude
 * Code sign with it, so it is the `claude-code` provider's alone.
 */
const accountPoolVariable = "SMITHERS_ACCOUNT_POOL_URL"
const accountPoolKeyVariable = "SMITHERS_ACCOUNT_POOL_KEY"
const accountPoolRoutesTtlMillis = 30_000

type AccountPoolRoute = "chatgpt"

interface AccountPool {
  readonly origin: string
  readonly key: string
  readonly routes: ReadonlyArray<string>
}

const origin = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value.replace(/\/+$/, "")

/** The configured account pool, when the host may take any route to it. */
const accountPoolOf = (environment: Readonly<Record<string, string | undefined>>): AccountPool | undefined => {
  const poolOrigin = origin(Environment_.read(environment, accountPoolVariable))
  const key = environment[accountPoolKeyVariable]
  const routes = (Environment_.read(environment, "SMITHERS_ACCOUNT_POOL_PROVIDERS") ?? "").split(",")
    .map((item) => item.trim()).filter((item) => item !== "")
  return poolOrigin === undefined || key === undefined || key === "" || routes.length === 0
    ? undefined
    : { origin: poolOrigin, key, routes }
}

/**
 * The native seat resolver: it turns a `provider:modelId` seat into a live model
 * route, with the API key read from the given environment, usually
 * `process.env`, passed in as a value so nothing below this composition touches
 * the process directly.
 *
 * A seat with no separator is a bare model id on the Anthropic route, which is
 * the one provider convention this host assumes. A `claude-code:<model>` seat
 * runs on the user's own signed-in Claude Code (see `ClaudeCode`), and so does
 * a Claude alias (`opus`, `sonnet`, `fable`) when no Anthropic key is set.
 *
 * `SMITHERS_OPENAI_AUTH=chatgpt` swaps the `openai` provider's credential source
 * from `OPENAI_API_KEY` to the codex CLI's ChatGPT session
 * (`$CODEX_HOME/auth.json`); the token store is shared across every seat that
 * resolves against the same file so its refresh stays single-flight.
 *
 * @category constructors
 * @since 0.1.0
 */
export const seatResolver = (
  environment: Readonly<Record<string, string | undefined>>,
  executor: RequestExecutor.RequestExecutor
): SeatResolver.Service => withAliases(providerSeats(environment, executor), hostOf(environment))

/**
 * The seat an alias runs as on `host`: the `provider:modelId` it names, except
 * that a Claude alias runs on Claude Code (`claude-code:<alias>`) when no
 * Anthropic key is set. Anything else is returned unchanged.
 */
const aliasSeat = (declared: string, host: Providers.Host): string => {
  const seat = Providers.expandSeat(declared)
  return seat !== declared && seat.startsWith("anthropic:") && credential("anthropic", host)._tag === "Refused"
    ? `claude-code:${declared}`
    : seat
}

/**
 * Resolves a seat alias (`luna`, `sol`, ...) as the seat {@link aliasSeat}
 * names, keeping the declared id on the journaled seat, and refuses Jev, which
 * answers classifier questions and never runs an agent turn.
 */
const withAliases = (base: SeatResolver.Service, host: Providers.Host): SeatResolver.Service =>
  SeatResolver.make({
    resolve: (declared) => {
      if (Providers.isDecisionSeat(declared)) {
        return Effect.fail(new Seat.SeatUnresolved({ seat: declared, message: Providers.seatRefusal(declared)! }))
      }
      const seat = aliasSeat(declared, host)
      return seat === declared
        ? base.resolve(seat)
        : base.resolve(seat).pipe(Effect.map((resolved) => Seat.make({ ...resolved, id: declared })))
    }
  })

/**
 * How {@link seatResolver} signs one provider's seats on `host`, or why it
 * cannot: the one statement of its credential rules, which the resolver
 * routes by and {@link seatCandidates} offers by.
 *
 * `openai` runs in the mode `SMITHERS_OPENAI_AUTH` selects: a key, or the
 * ChatGPT session behind the model proxy or on this machine. `anthropic`
 * takes only a key; a Claude subscription runs as `claude-code`, on Claude
 * Code, which signs its own requests. An empty variable is an unset one. An
 * account pool with accounts for the provider's route signs ahead of all of
 * these; see {@link poolRouteOf}.
 */
type Credential =
  | { readonly _tag: "Compatible"; readonly key: string }
  | { readonly _tag: "Pooled"; readonly key: string; readonly origin: string }
  | { readonly _tag: "Session"; readonly file: string }
  | { readonly _tag: "ClaudeCode"; readonly executable: string }
  | { readonly _tag: "Key"; readonly key: string }
  | { readonly _tag: "Refused"; readonly refusal: (seat: string) => string }

const refused = (refusal: (seat: string) => string): Credential => ({ _tag: "Refused", refusal })

/** This machine, as the seat scan reads it. */
const hostOf = (environment: Readonly<Record<string, string | undefined>>): Providers.Host => ({
  environment,
  homeDirectory: homedir(),
  readFile: readText,
  claudeCode: () => Providers.claudeCodeLogin(environment)
})

const credential = (provider: string, host: Providers.Host): Credential => {
  const environment = host.environment
  // The OpenAI-compatible Chat Completions providers are routed by table
  // (`Providers.compatible`). `Object.hasOwn`, so `constructor:x` finds no
  // inherited function.
  if (Object.hasOwn(Providers.compatible, provider)) {
    const found = Providers.compatibleKey(provider, environment)
    return found === undefined
      ? refused((seat) => `Set ${Providers.compatible[provider]!.variables.join(" or ")} to run the ${seat} seat`)
      : { _tag: "Compatible", key: found.key }
  }
  if (provider === "claude-code") {
    const found = Providers.claudeCode(host)
    return found.executable === undefined
      ? refused((seat) => `${found.reason}, so the ${seat} seat cannot run: ${found.setupHint}`)
      : { _tag: "ClaudeCode", executable: found.executable }
  }
  const variable = apiKeyVariable[provider]
  if (variable === undefined) return refused(() => `No route is configured for the ${provider} provider`)
  const configured = Environment_.read(environment, openaiAuthVariable)
  const authMode = provider === "openai" && configured !== undefined && configured !== "" ? configured : "api-key"
  if (authMode !== "api-key" && authMode !== "chatgpt") {
    return refused((seat) => `${openaiAuthVariable} must be "api-key" or "chatgpt" to run the ${seat} seat`)
  }
  const value = environment[variable]
  const key = value === undefined || value.length === 0 ? undefined : value
  if (authMode === "chatgpt") {
    // Behind the Smithers model proxy the ChatGPT seat carries the proxy
    // credential as the `openai` seat's key.
    const origin = Endpoint.proxyOrigin("chatgpt", environment)
    if (origin !== undefined) {
      return key === undefined
        ? refused((seat) => `Set ${variable} to run the ${seat} seat through the model proxy`)
        : { _tag: "Pooled", key, origin }
    }
    // The ChatGPT mode needs a provisioned session, not an API key: the
    // refusal names the store so a detached lane fails before spending.
    const file = CodexAuth.locate(environment, host.homeDirectory)
    return host.readFile(file) === undefined
      ? refused((seat) => `Sign in with \`codex login\` to run the ${seat} seat: no ChatGPT credentials at ${file}`)
      : { _tag: "Session", file }
  }
  return key === undefined ? refused((seat) => `Set ${variable} to run the ${seat} seat`) : { _tag: "Key", key }
}

/**
 * The account pool route a provider's seats may take: `chatgpt` for the openai
 * seat unless `SMITHERS_OPENAI_AUTH` pins it to its key or names no valid mode.
 */
const poolRouteOf = (
  provider: string,
  environment: Readonly<Record<string, string | undefined>>
): AccountPoolRoute | undefined => {
  if (provider !== "openai") return undefined
  if (origin(Environment_.read(environment, accountPoolVariable)) !== undefined) return "chatgpt"
  const configured = Environment_.read(environment, openaiAuthVariable)
  return configured === undefined || configured === "" || configured === "chatgpt" ? "chatgpt" : undefined
}

const providerSeats = (
  environment: Readonly<Record<string, string | undefined>>,
  executor: RequestExecutor.RequestExecutor
): SeatResolver.Service => {
  const pool = accountPoolOf(environment)
  let served: { readonly until: number; readonly routes: ReadonlyArray<string> } | undefined
  // A configured pool owns this route. An empty or unavailable pool refuses
  // resolution unless provisioning names a platform fallback. It never falls
  // through to an ambient provider key.
  const pooled = (route: AccountPoolRoute, modelId: string) =>
    Effect.gen(function*() {
      if (pool === undefined || !pool.routes.includes(route)) return undefined
      const now = yield* Clock.currentTimeMillis
      if (served === undefined || served.until <= now) {
        // Only an answer that lists the route sends a seat to the pool: a
        // pool that does not answer refuses its seats until the next ask.
        const routes = yield* accountPoolRoutes(pool, executor, modelId).pipe(
          Effect.orElseSucceed((): ReadonlyArray<string> => [])
        )
        served = { until: now + accountPoolRoutesTtlMillis, routes }
      }
      return served.routes.includes(route) ? pool : undefined
    })
  const codexStores = new Map<string, CodexAuth.Store>()
  const codexStore = (file: string): CodexAuth.Store => {
    let store = codexStores.get(file)
    if (store === undefined) {
      store = CodexAuth.make({ file, executor })
      codexStores.set(file, store)
    }
    return store
  }
  const host = hostOf(environment)
  return SeatResolver.make({
    resolve: (seat) =>
      Effect.gen(function*() {
        const separator = seat.indexOf(":")
        const provider = separator < 0 ? "anthropic" : seat.slice(0, separator)
        const modelId = Seat.modelIdOf(seat)
        // Behind a Smithers account pool with accounts for this provider the
        // pool owns the credential: it picks an account per request and signs
        // it. The host holds only the pool credential.
        const poolRoute = poolRouteOf(provider, environment)
        if (
          poolRoute !== undefined && origin(Environment_.read(environment, accountPoolVariable)) !== undefined &&
          pool === undefined
        ) {
          return yield* new Seat.SeatUnresolved({ seat, message: "The subscription pool configuration is incomplete." })
        }
        const accounts = poolRoute === undefined ? undefined : yield* pooled(poolRoute, modelId)
        if (accounts !== undefined) {
          return yield* seatOf(
            OpenAIChatGPT.make({
              auth: Auth.bearer(Redacted.make(accounts.key)),
              baseUrl: `${accounts.origin}/chatgpt`
            }),
            executor,
            seat,
            modelId
          )
        }
        const platformFallback = environment.SMITHERS_CODING_FALLBACK_MODEL === seat &&
          Endpoint.proxyOrigin(provider, environment) !== undefined
        if (pool !== undefined && poolRoute !== undefined && !platformFallback) {
          return yield* new Seat.SeatUnresolved({
            seat,
            message: "The configured subscription pool has no available account for this seat."
          })
        }
        const signed = credential(provider, host)
        switch (signed._tag) {
          case "Refused":
            return yield* new Seat.SeatUnresolved({ seat, message: signed.refusal(seat) })
          case "Compatible":
            return yield* seatOf(
              Route.openaiChatCompatible({
                id: provider,
                // A provider the model proxy fronts honors SMITHERS_MODEL_PROXY_URL.
                baseUrl: Object.hasOwn(Endpoint.providerOrigins, provider)
                  ? Endpoint.providerOrigin(provider as Endpoint.ProxiedProvider, environment)
                  : Providers.compatible[provider]!.baseUrl,
                path: Providers.compatible[provider]!.path,
                apiKey: Redacted.make(signed.key)
              }),
              executor,
              seat,
              modelId
            )
          case "Pooled":
            return yield* seatOf(
              OpenAIChatGPT.make({ auth: Auth.bearer(Redacted.make(signed.key)), baseUrl: signed.origin }),
              executor,
              seat,
              modelId
            )
          case "Session":
            return yield* seatOf(
              OpenAIChatGPT.make({ auth: codexStore(signed.file).auth({ modelId }) }),
              executor,
              seat,
              modelId
            )
          case "ClaudeCode": {
            const model = Providers.claudeCodeModel(modelId)
            return Seat.make({
              id: seat,
              modelId: model,
              model: ClaudeCode.make({
                model,
                executable: signed.executable,
                environment,
                // A host whose runs a person can take over keeps each session for `claude --resume`.
                hijackable: environment["SMITHERS_HIJACKABLE"] === "1"
              }),
              route: ClaudeCode.route(model),
              contextWindowTokens: SeatResolver.contextWindowTokensFor(model)
            })
          }
        }
        const key = signed.key
        // The provider routes have distinct body types, so each branch is
        // erased into the seat shape on its own rather than through a union.
        // OpenRouter is the OpenAI Responses surface at a different origin, so
        // its seats spell the model as `openrouter:vendor/model` and route
        // through the compatible constructor.
        return yield* provider === "anthropic"
          ? seatOf(
            Route.anthropic({ apiKey: Redacted.make(key), baseUrl: Endpoint.providerOrigin("anthropic", environment) }),
            executor,
            seat,
            modelId
          )
          : provider === "openrouter"
          ? seatOf(
            Route.openaiResponsesCompatible({
              id: "openrouter",
              baseUrl: Endpoint.providerOrigin("openrouter", environment),
              apiKey: Redacted.make(key)
            }),
            executor,
            seat,
            modelId
          )
          : environment.SMITHERS_OPENAI_COMPATIBLE_BASE_URL
          ? seatOf(
            Route.openaiChatCompatible({
              id: "openai",
              baseUrl: environment.SMITHERS_OPENAI_COMPATIBLE_BASE_URL,
              apiKey: Redacted.make(key)
            }),
            executor,
            seat,
            modelId
          )
          : seatOf(
            Route.openai({ apiKey: Redacted.make(key), baseUrl: Endpoint.providerOrigin("openai", environment) }),
            executor,
            seat,
            modelId
          )
      })
  })
}

/** Asks the pool which routes have connected accounts right now. */
const accountPoolRoutes = (
  pool: AccountPool,
  executor: RequestExecutor.RequestExecutor,
  modelId: string
): Effect.Effect<ReadonlyArray<string>, unknown> =>
  Effect.scoped(Effect.gen(function*() {
    const request = HttpClientRequest.get(`${pool.origin}/routes`).pipe(
      HttpClientRequest.bearerToken(pool.key),
      HttpClientRequest.acceptJson
    )
    const response = yield* executor.execute(request, { modelId })
    const text = yield* response.text.pipe(Effect.mapError(() => ({ message: "the answer could not be read" })))
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    const routes = typeof parsed === "object" && parsed !== null ? (parsed as { routes?: unknown }).routes : undefined
    if (!Array.isArray(routes)) {
      return yield* Effect.fail({ message: "the answer named no routes" })
    }
    return routes.filter((route): route is string => typeof route === "string")
  }))

/**
 * A startup default from the pool's currently connected, host-permitted routes.
 * @category constructors
 * @since 1.0.0
 */
export const accountPoolDefaultModel = (environment: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function*() {
    const pool = accountPoolOf(environment)
    if (pool === undefined) return undefined
    const executor = yield* RequestExecutor.RequestExecutor
    const routes = yield* accountPoolRoutes(pool, executor, "coding/implement").pipe(
      Effect.orElseSucceed((): ReadonlyArray<string> => [])
    )
    const defaults = [["chatgpt", "openai:gpt-6-luna"]] as const
    return defaults.find(([route]) => pool.routes.includes(route) && routes.includes(route))?.[1]
  })

const seatOf = <Body, Frame, Event, State>(
  configured: Result.Result<Route.Route<Body, Frame, Event, State>, ModelError.ModelError>,
  executor: RequestExecutor.RequestExecutor,
  seat: string,
  modelId: string
): Effect.Effect<Seat.Seat, Seat.SeatUnresolved> =>
  Effect.gen(function*() {
    const routeConfig = yield* Effect.fromResult(configured).pipe(
      Effect.mapError((error) => new Seat.SeatUnresolved({ seat, message: error.message }))
    )
    const model = yield* Route.toModel(routeConfig).pipe(
      Effect.provideService(RequestExecutor.RequestExecutor, executor)
    )
    return Seat.make({
      id: seat,
      modelId,
      model,
      route: FlowEngineLike.routeResolver(routeConfig),
      contextWindowTokens: SeatResolver.contextWindowTokensFor(modelId)
    })
  })

/**
 * Provides {@link seatResolver} over the composition's request dispatcher.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerSeatResolver = (
  environment: Readonly<Record<string, string | undefined>>
): Layer.Layer<SeatResolver.SeatResolver, never, RequestExecutor.RequestExecutor> =>
  Layer.effect(SeatResolver.SeatResolver)(
    Effect.gen(function*() {
      const executor = yield* RequestExecutor.RequestExecutor
      return seatResolver(environment, executor)
    })
  )

/**
 * The routing graph's seats (`SeatRouter.seats`) an `auto` run may be routed
 * to on this host: each whose {@link aliasSeat} {@link seatResolver} holds a
 * credential for, so a Claude seat is offered on an Anthropic key or on a
 * Claude subscription signed in to Claude Code.
 *
 * @category constructors
 * @since 1.0.0
 */
export const seatCandidates = (host: Providers.Host): ReadonlyArray<string> => {
  const pool = accountPoolOf(host.environment)
  return SeatRouter.seats.filter((alias) => {
    const seat = aliasSeat(alias, host)
    const provider = seat.slice(0, seat.indexOf(":"))
    // A route the pool is configured for is offered: the pool is asked which
    // routes have accounts when the seat resolves.
    const route = poolRouteOf(provider, host.environment)
    if (pool !== undefined && route !== undefined) return pool.routes.includes(route)
    return credential(provider, host)._tag !== "Refused"
  })
}

/**
 * Provides the {@link SeatRouter.Catalog} of {@link seatCandidates} over the
 * given environment, read afresh each time a run is routed, with
 * {@link SeatRouter.defaultVariants}.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerSeatCatalog = (
  environment: Readonly<Record<string, string | undefined>>
): Layer.Layer<SeatRouter.Catalog> =>
  SeatRouter.layer({
    candidates: Effect.sync(() => seatCandidates(hostOf(environment))),
    variants: SeatRouter.defaultVariants
  })

/**
 * Judges with Jev through the Vercel AI Gateway (`AI_GATEWAY_API_KEY`), and
 * with GPT-6 Luna only when Jev is unreachable, times out, or stays
 * unavailable (5xx or 429) through its retries. A missing key
 * makes Jev unreachable; Luna resolves through the subscription resolver at
 * evaluation time, so newly connected pool accounts work after startup, and
 * never judges on a provider API key.
 *
 * Jev speaks over `jevHttp`, by default the environment's egress client on
 * Node and fetch on Bun, not the model executor: the gateway's own statuses, retries and deadline stay
 * Jev's, and its outages never count against the model transport.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerSeatEvaluator = (
  environment: Readonly<Record<string, string | undefined>>,
  jevHttp: Layer.Layer<HttpClient.HttpClient> = process.versions.bun === undefined
    ? EgressHttpClient.layer(environment)
    // Undici cannot run under Bun; Bun's fetch honours the proxy variables itself.
    : FetchHttpClient.layer
): Layer.Layer<Evaluator.Evaluator, never, RequestExecutor.RequestExecutor> =>
  Layer.effect(Evaluator.Evaluator)(Effect.gen(function*() {
    const executor = yield* RequestExecutor.RequestExecutor
    const resolver = seatResolver(environment, executor)
    const key = environment["AI_GATEWAY_API_KEY"]?.trim()
    const jev = key === undefined || key === ""
      ? Evaluator.Evaluator.of({
        evaluate: () =>
          Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "AI_GATEWAY_API_KEY is not set" }))
      })
      : Context.get(
        yield* Layer.build(
          Evaluator.layerVercelGateway({ apiKey: Redacted.make(key) }).pipe(
            Layer.provide(jevHttp)
          )
        ),
        Evaluator.Evaluator
      )
    // Luna judges on a subscription only, as the judge always has: through the
    // account pool or a ChatGPT session, never on a provider API key. Read at
    // each judgment, so a `codex login` after startup counts.
    const subscribed = () => {
      const pool = accountPoolOf(environment)
      const route = poolRouteOf("openai", environment)
      const signed = credential("openai", hostOf(environment))
      return (pool !== undefined && route !== undefined && pool.routes.includes(route)) ||
        signed._tag === "Session" || signed._tag === "Pooled"
    }
    const luna: Evaluator.Evaluator = Evaluator.Evaluator.of({
      evaluate: (request) =>
        Effect.suspend(() => subscribed() ? resolver.resolve("luna") : Effect.fail(undefined)).pipe(
          Effect.mapError(() =>
            new Evaluator.EvaluatorError({ code: "unreachable", message: Evaluator.unreachableMessage })
          ),
          Effect.flatMap((seat) => EvaluatorBackup.fromModel(seat.model, seat.modelId).evaluate(request))
        )
    })
    return EvaluatorBackup.withFallback(jev, luna)
  }))

/**
 * The explicit sandbox budget every locally executed cell runs under. Never
 * unlimited: an unbounded QuickJS cell can hang the frame.

 * @since 1.0.0
 * @private
 */
export const cellLimits: Sandbox.Limits = {
  memoryBytes: 256 * 1024 * 1024,
  steps: 50_000_000
}

/**
 * The declared mount's name for a directory inside the repository, or
 * `undefined` when the mount cannot name it. `TestRun` derives its baseline
 * worktree's container path the same way, from the same pair of roots.
 */
const mountedAs = (mount: string, root: string, directory: string): string | undefined => {
  const inside = relative(root, directory)
  if (inside === "") return mount
  if (inside.startsWith("..") || isAbsolute(inside)) return undefined
  return `${mount.replace(/\/+$/, "")}/${inside}`
}

/**
 * The repository's own test invocation, as this host declares it.
 *
 * `TestRun` is a declaration flow: a caller selects *which* tests, never *how*
 * to run them, so the composition has to supply the how. This host reads it off
 * the environment, which is the same place it reads a seat's credentials, and
 * the only field that decides anything is the command. The rest describe where
 * that command runs.
 *
 * `undefined` means this host knows of no runner, and then the `test` flow is
 * not bound at all. That is the rule the r91 wave broke in the other direction:
 * `StandardFlows.tests` existed, the cell contract's doctrine assumed it, and
 * no composition offered it, so all 45 graded runs saw zero `test` calls. A
 * flow no composition offers is a flow that does not exist, and a flow bound
 * over a declaration that can only refuse is worse, because the catalog then
 * advertises a call whose every answer is "not configured".
 *
 * `workspaceRoot` is the checkout this executor actually runs in, which is not
 * `root` once a resumed history fork binds the run to its own worktree. The
 * runner has to name that checkout, or the suite grades the files the forked
 * agent never touched. `root` still decides the *container's* name for the
 * tree: `SMITHERS_TEST_CWD` is the mount the project root is reachable at, so
 * a workspace inside the project is reachable at the same relative path under
 * that mount. A workspace the mount cannot name at all declares no runner,
 * because the only alternative is a `test` call that silently runs elsewhere.
 *
 * @category constructors
 * @since 0.1.0
 */
export const testRunner = (
  environment: Readonly<Record<string, string | undefined>>,
  root: string,
  workspaceRoot: string = root
): TestRunner.Runner | undefined => {
  const command = Environment_.read(environment, "SMITHERS_TEST_COMMAND")?.trim()
  if (command === undefined || command === "") return undefined
  const container = Environment_.read(environment, "SMITHERS_TEST_CONTAINER")?.trim()
  const declared = Environment_.read(environment, "SMITHERS_TEST_CWD")?.trim()
  const timeout = Number(Environment_.read(environment, "SMITHERS_TEST_TIMEOUT_MS"))
  // The runner's directory and the workspace's are the same path until a
  // container gives the tree a second name; `root` stays a host path, because
  // that is where a baseline worktree is checked out from.
  const cwd = declared === undefined || declared === ""
    ? workspaceRoot
    : mountedAs(declared, root, workspaceRoot)
  if (cwd === undefined) return undefined
  return {
    command,
    cwd,
    root: workspaceRoot,
    ...(container === undefined || container === "" ? {} : { container }),
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {})
  }
}

/**
 * The one container this host's `bash` may reach, when the host is sealed.
 *
 * `SMITHERS_BASH_CONTAINER` names it. A sealed host refuses every `bash` call
 * that names another container or none (`Bash.sealed`), and offers no host
 * filesystem flow, so a cell cannot read the host at all. A benchmark host
 * sets it: the host holds other tasks' tests and reference solutions, and a
 * task's agent may touch only the task's container.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const sealedContainer = (
  environment: Readonly<Record<string, string | undefined>>
): string | undefined => {
  const container = Environment_.read(environment, "SMITHERS_BASH_CONTAINER")?.trim()
  return container === undefined || container === "" ? undefined : container
}

/**
 * What an in-run `ask` does on this host.
 *
 * `SMITHERS_ASKS` names it. `park`, the default, parks the run on an approval
 * an operator answers with `smithers approve`. `refuse` declares a host nobody
 * answers — a benchmark, a cron, a CI lane — and every `ask` fails at once with
 * `ApprovalUnavailable`, which the cell reads and the journal records as the
 * call's failure. Nothing is approved on anyone's behalf. An unattended
 * benchmark trial that parked here spent the rest of its hour waiting.
 * Any other value throws a `UsageError` naming the variable.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const askPolicy = (environment: Readonly<Record<string, string | undefined>>): "park" | "refuse" => {
  const value = Environment_.read(environment, "SMITHERS_ASKS")?.trim() ?? ""
  if (value === "" || value === "park") return "park"
  if (value === "refuse") return "refuse"
  throw new CliError.UsageError({ message: `SMITHERS_ASKS must be park or refuse, not ${JSON.stringify(value)}` })
}

/**
 * Where this host pins the trees a run checkpoints, and where a container sees
 * them.
 *
 * The same two paths {@link testRunner} reads, for the same reason: a
 * checkpoint is materialized as a directory under the repository, and a
 * container reaches that directory through the mount it already has.
 * `SMITHERS_TEST_CWD` is the container's name for the repository when there is
 * one, and the workspace root is the host's. A host that declares neither
 * still pins, and pins on one path under both names.
 *
 * @category constructors
 * @since 0.1.0
 */
export const checkpointStore = (
  environment: Readonly<Record<string, string | undefined>>,
  root: string
): Checkpoints.GitOptions => {
  const cwd = Environment_.read(environment, "SMITHERS_TEST_CWD")?.trim()
  return { root, ...(cwd === undefined || cwd === "" ? {} : { cwd }) }
}

/**
 * The `test` flow's binding source, or none when this host declares no runner.
 *
 * Named rather than spread inline because the r91 wave's whole finding about
 * this flow is that the *composition* was the untried link: the flow, its
 * declaration and its handler were all tested, and no test asked whether any
 * host offered them. This is that question, in the one place it can be asked
 * without booting a run.
 *
 * The runner's container is added to the same context, so the suite reaches the
 * image through the transport `bash` already uses. The `Evaluator` comes in
 * with it: the flow attributes a non-zero exit with Jev, and the host builds
 * that judge through `layerSeatEvaluator`, for this flow and
 * for the completion brake alike.
 *
 * @category constructors
 * @since 0.1.0
 */
export const testFlows = (
  services: Context.Context<
    Evaluator.Evaluator | KernelChildProcessSpawner.ChildProcessSpawner | Path.Path
  >,
  container: Container.Container,
  runner: TestRunner.Runner | undefined
): ReadonlyArray<FlowBinding.Source> =>
  runner === undefined ? [] : [
    StandardFlows.tests(
      Context.add(
        Context.add(services, TestRunner.TestRunner, TestRunner.make(runner)),
        Container.Container,
        container
      )
    )
  ]
