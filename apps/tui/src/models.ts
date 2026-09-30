/**
 * The seats the model picker offers: only providers this machine can reach.
 *
 * A seat is `provider:modelId`, resolved by the Smithers native seat resolver.
 * Detection is `smithers`' own (`@smthrs/cli/Providers`): a codex login makes
 * `openai:*` seats run on the ChatGPT subscription, a Claude subscription
 * signed in to Claude Code adds `claude-code:*` seats when no Anthropic key is
 * set, and a provider key makes that provider's seats available. Account pools
 * offer their shared default only after connected, permitted routes are read.
 */
import * as SeatRouter from "@smthrs/agent/SeatRouter"
import * as NodeControl from "@smthrs/cli/NodeControl"
import * as Providers from "@smthrs/cli/Providers"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect, Layer } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

export interface Model {
  readonly seat: string
  readonly label: string
  readonly provider: string
}

export const delegateModels = {
  cerebras: Providers.defaultSeat.cerebras,
  luna: Providers.seatAliases.luna!,
  sol: Providers.seatAliases.sol!
} as const
export type DelegateModel = string

/** A seat with the display label the seat catalog in `Providers` gives it. */
const described = (seat: string): Omit<Model, "provider"> => ({
  seat,
  label: Providers.describeSeat(seat)?.label ?? seat
})

const subscription: ReadonlyArray<Omit<Model, "provider">> = [described(Providers.seatAliases.sol!)]

const byProvider: Readonly<Record<Providers.Candidate, ReadonlyArray<Omit<Model, "provider">>>> = {
  "codex-subscription": subscription,
  openai: subscription,
  "kimi-k3": [described(Providers.defaultSeat["kimi-k3"])],
  gemini: [described(Providers.defaultSeat.gemini)],
  openrouter: [described(Providers.defaultSeat.openrouter)],
  cerebras: [described(Providers.defaultSeat.cerebras)]
}

const anthropic: ReadonlyArray<Omit<Model, "provider">> = [
  described(Providers.seatAliases.opus!),
  described(Providers.seatAliases.sonnet!),
  described(Providers.seatAliases.fable!)
]

const claudeCode: ReadonlyArray<Omit<Model, "provider">> = Providers.claudeCodeSeats.map((seat) => ({
  seat,
  label: anthropic.find((model) => model.seat === Providers.expandSeat(seat.slice("claude-code:".length)))?.label ??
    seat
}))

/** Every seat the picker can offer, whichever providers are detected. */
export const offered: ReadonlyArray<Omit<Model, "provider">> = [
  ...Object.values(byProvider).flat(),
  ...anthropic,
  ...claudeCode
]

export interface Available {
  readonly models: ReadonlyArray<Model>
  readonly defaultSeat: string | undefined
  readonly workerSeat: string | undefined
  /** The process environment plus what the chosen credentials need. */
  readonly environment: Record<string, string | undefined>
}

const hostOf = (environment: NodeJS.ProcessEnv): Providers.Host => ({
  environment,
  homeDirectory: homedir(),
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8")
    } catch {
      return undefined
    }
  },
  claudeCode: () => Providers.claudeCodeLogin(environment)
})

const poolTransport = RequestExecutor.layer.pipe(
  Layer.provide(KernelHttpClient.layer),
  // Model discovery uses the same credentialed HTTP boundary as model calls.
  // eslint-disable-next-line no-restricted-syntax -- model HTTP, not a tool capability
  Layer.provide(GrantStore.layerNoop),
  Layer.provide(FetchHttpClient.layer)
)

export const detect = async (
  environment: NodeJS.ProcessEnv,
  poolExecutor: Layer.Layer<RequestExecutor.RequestExecutor> = poolTransport
): Promise<Available> => {
  const base = detectWithoutClaude(environment)
  const [claude, poolSeat] = await Promise.all([
    Providers.claudeCode(hostOf(base.environment)),
    Effect.runPromise(
      NodeControl.accountPoolDefaultModel(base.environment).pipe(
        Effect.provide(poolExecutor),
        Effect.timeout(5000),
        Effect.orElseSucceed(() => undefined)
      )
    )
  ])
  const models = [...base.models]
  if (claude.available) models.push(...claudeCode.map((model) => ({ ...model, provider: "Claude Code" })))
  if (poolSeat !== undefined && !models.some((model) => model.seat === poolSeat)) {
    models.push({ ...described(poolSeat), provider: "Account pool" })
  }
  return withModels(models, base.environment)
}

/** The key-backed seats when a synchronous host is built without a startup scan. */
export const detectWithoutClaude = (environment: NodeJS.ProcessEnv): Available => {
  const host = hostOf(environment)
  const detections = Providers.detect(host).filter((detection) => detection.available)
  const subscribed = detections.some((detection) => detection.id === "codex-subscription")
  const models: Array<Model> = []
  for (const detection of detections) {
    // One OpenAI route at a time: the subscription wins over an API key.
    if (detection.id === "openai" && subscribed) continue
    for (const model of byProvider[detection.id]) models.push({ ...model, provider: detection.label })
  }
  if ((environment.ANTHROPIC_API_KEY ?? "") !== "") {
    for (const model of anthropic) models.push({ ...model, provider: "Anthropic" })
  }
  return withModels(models, { ...environment })
}

const withModels = (models: ReadonlyArray<Model>, environment: NodeJS.ProcessEnv): Available => ({
  models,
  defaultSeat: environment.SMITHERS_TUI_SEAT ?? models.find((model) => model.seat.startsWith("cerebras:"))?.seat ??
    models.find((model) => model.seat === delegateModels.sol)?.seat ?? models[0]?.seat,
  workerSeat: environment.SMITHERS_TUI_WORKER_SEAT ??
    models.find((model) => !model.seat.startsWith("cerebras:"))?.seat ?? models[0]?.seat,
  environment
})

/**
 * A worker's fallbacks after a provider failure: `SMITHERS_TUI_WORKER_SEATS`
 * when the operator sets it, else `routed`, the backups the worker's route
 * picked, else the routing graph's backups of `seat` (`SeatRouter.backupsOf`)
 * that run here. Never Cerebras or `seat` itself.
 */
export const workerFallbackSeats = (
  seat: string,
  available: Available,
  environment: Readonly<Record<string, string | undefined>>,
  routed?: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const override = environment.SMITHERS_TUI_WORKER_SEATS
  if (override !== undefined) {
    return [
      ...new Set(
        override.split(",").map((id) => id.trim()).filter((id) =>
          id !== "" && id !== seat && !id.startsWith("cerebras:")
        )
      )
    ]
  }
  if (routed !== undefined) return routed
  const alias = graphSeatOf(seat)
  if (alias === undefined) return []
  const here = graphSeats(available)
  return SeatRouter.backupsOf(alias, "other").filter((backup) => here.includes(backup))
}

/**
 * The seat that estimates novel work: Luna, only where a detected model runs
 * on its provider (an OpenAI key or a codex login). Elsewhere estimates stay
 * on history; no other paid provider stands in.
 */
export const estimateSeat = (available: ReadonlyArray<Model>): string | undefined => {
  const provider = providerOf(delegateModels.luna)
  return available.some((model) => providerOf(model.seat) === provider) ? delegateModels.luna : undefined
}

/** The short names an agent file's `model:` may use instead of `provider:modelId`. */
export const aliases: Readonly<Record<string, string>> = Providers.seatAliases

/** The routing graph's name for `seat`: the alias itself, the alias it expands to, or a `claude-code:` alias. */
const graphSeatOf = (seat: string): SeatRouter.GraphSeat | undefined => {
  const name = seat.startsWith("claude-code:") ? seat.slice("claude-code:".length) : seat
  return SeatRouter.seats.find((alias) => alias === name || aliases[alias] === name)
}

/**
 * The routing graph's seats that run here: those whose provider serves an
 * available seat. A Claude seat runs on an Anthropic key or on Claude Code,
 * whichever `detect` found; the seat resolver picks the same route.
 */
const graphSeats = (available: Available): ReadonlyArray<SeatRouter.GraphSeat> => {
  const providers = new Set(available.models.map((model) => providerOf(model.seat)))
  return SeatRouter.seats.filter((alias) => {
    const provider = providerOf(aliases[alias]!)
    return providers.has(provider) || (provider === "anthropic" && providers.has("claude-code"))
  })
}

/**
 * The catalog a worker routes over, when it may route: the host is judged
 * and `SMITHERS_TUI_WORKER_SEAT`, an operator's explicit choice, is unset.
 * The routing graph's seats that run here, and the default system-prompt
 * variants, picked in the same call.
 */
export const routing = (
  available: Available,
  environment: Readonly<Record<string, string | undefined>>,
  judged: boolean
): SeatRouter.Service | undefined =>
  !judged || environment.SMITHERS_TUI_WORKER_SEAT !== undefined
    ? undefined
    : { candidates: Effect.succeed(graphSeats(available)), variants: SeatRouter.defaultVariants }

const providerOf = (seat: string): string => seat.slice(0, seat.indexOf(":"))
/** Every provider a seat here names, plus the replay seat the tests drive. */
const knownProviders = new Set([
  "replay",
  ...[
    ...Object.values(delegateModels),
    ...Object.values(aliases),
    ...Object.values(byProvider).flat().map((model) => model.seat),
    ...anthropic.map((model) => model.seat),
    ...claudeCode.map((model) => model.seat)
  ].map(providerOf)
])

/**
 * The seat an agent's declared `model:` names: an alias, or `provider:modelId`
 * for a provider this module knows or `available` lists. Undefined when unknown.
 * A Claude alias stays an alias: the seat resolver runs it on an Anthropic key,
 * or on Claude Code when no key is set.
 */
export const seatOf = (declared: string, available: ReadonlyArray<Model>): string | undefined => {
  const value = declared.trim()
  const alias = aliases[value.toLowerCase()]
  if (alias !== undefined) return alias.startsWith("anthropic:") ? value.toLowerCase() : alias
  const colon = value.indexOf(":")
  if (colon <= 0 || colon === value.length - 1) return undefined
  const provider = value.slice(0, colon)
  return knownProviders.has(provider) || available.some((model) => providerOf(model.seat) === provider)
    ? value
    : undefined
}

/**
 * The delegate models this machine can reach: those whose provider serves one
 * of the available seats. A request for any other fails at once instead of
 * becoming a worker tab that fails on its first model call.
 */
export const delegable = (available: ReadonlyArray<Model>): ReadonlyArray<DelegateModel> => {
  const providers = new Set(available.map((model) => providerOf(model.seat)))
  return [
    ...new Set([
      ...Object.keys(delegateModels),
      ...Object.keys(aliases),
      ...available.map((model) => model.seat)
    ])
  ].filter((name) => {
    const seat = aliases[name] ?? delegateSeat(name)
    const provider = providerOf(seat)
    return providers.has(provider) || (provider === "anthropic" && providers.has("claude-code"))
  })
}

/** The seat passed to the host for a named delegate model. Claude aliases stay aliases for its resolver. */
export const delegateSeat = (name: DelegateModel): string =>
  Object.hasOwn(delegateModels, name)
    ? delegateModels[name as keyof typeof delegateModels]
    : seatOf(name, []) ?? name

/** A seat's display name: an available model's label, a known model's, or the seat itself. */
export const labelOf = (seat: string, available: ReadonlyArray<Model>): string =>
  available.find((model) => model.seat === seat)?.label ??
    offered.find((model) => model.seat === seat)?.label ??
    seat
