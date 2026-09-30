/**
 * Which model seats this machine can run `smthrs suggest` on, and which one
 * it runs on.
 *
 * Detection is pure over an injected environment, home directory, and file
 * reader, so the whole matrix (a Codex session, an API-key login, an empty
 * key, an override) is a table of small cases rather than a fixture in
 * `$HOME`. The order of {@link order} is the documented seat order and the
 * only ranking there is: the first available entry is the seat, and nothing
 * here weighs one provider against another.
 *
 * Anthropic never appears. That provider does not support the use this verb
 * puts a model to, so an `anthropic:` override is refused rather than tried.
 *
 * The three OpenAI-compatible providers the CLI's resolver had no route for
 * (Moonshot, Gemini's compatibility layer, Cerebras) are described here too,
 * in {@link compatible}, and `NodeControl.seatResolver` builds their routes
 * from this table so the seat this verb chooses is a seat the launcher can
 * run.
 *
 * @since 1.0.0-rc.0
 */

import * as Redaction from "@smthrs/journal/Redaction"
import * as Endpoint from "@smthrs/model/Endpoint"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Data from "effect/Data"
import { execFile } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { delimiter, join } from "node:path"
import * as Environment from "./Environment.ts"
import * as CodexCode from "./internal/CodexCode.ts"

/**
 * The stable id of one candidate seat.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Candidate = "codex-subscription" | "kimi-k3" | "openai" | "gemini" | "openrouter" | "cerebras"

/**
 * The documented order the candidates are tried in.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const order: ReadonlyArray<Candidate> = [
  "codex-subscription",
  "kimi-k3",
  "openai",
  "gemini",
  "openrouter",
  "cerebras"
]

/**
 * What the scan found for one candidate.
 *
 * `environment` is what the seat resolver has to read on top of the process
 * environment to run `seat`: Codex detection supplies
 * `SMITHERS_OPENAI_AUTH=chatgpt`; every other candidate supplies no variables.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Detection {
  readonly id: Candidate
  readonly label: string
  readonly seat: string
  readonly available: boolean
  readonly reason: string
  readonly setupHint: string
  readonly environment: Readonly<Record<string, string>>
}

/**
 * The seat the verb runs on: a detection, or the operator's own override.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Chosen {
  readonly seat: string
  /** The candidate id, or `override` for a `--seat` value. */
  readonly source: Candidate | "override"
  readonly label: string
  readonly environment: Readonly<Record<string, string>>
}

/**
 * What detection reads from the host.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Host {
  readonly environment: Environment.Source
  readonly homeDirectory: string
  /** The text of a file, or `undefined` when it cannot be read. */
  readonly readFile: (path: string) => string | undefined
  /**
   * This machine's Claude Code login, usually {@link claudeCodeLogin}. Absent,
   * or answering `undefined`, means Claude Code is not installed.
   */
  readonly claudeCode?: (() => Promise<ClaudeCodeLogin | undefined> | ClaudeCodeLogin | undefined) | undefined
}

/**
 * One OpenAI-compatible Chat Completions provider the resolver routes by
 * table: the origin, the exact path when the provider's differs from
 * `/v1/chat/completions`, and the key variables read in order.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Compatible {
  readonly baseUrl: string
  readonly path?: string | undefined
  readonly variables: ReadonlyArray<string>
}

/**
 * The OpenAI-compatible providers, by seat prefix.
 *
 * Gemini's compatibility layer lives under `/v1beta/openai`, so its path is
 * spelled in full rather than appended as `/v1/chat/completions`.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const compatible: Readonly<Record<string, Compatible>> = {
  moonshot: { baseUrl: "https://api.moonshot.ai", variables: ["MOONSHOT_API_KEY"] },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    path: "/chat/completions",
    variables: ["GEMINI_API_KEY", "GOOGLE_API_KEY"]
  },
  cerebras: { baseUrl: Endpoint.providerOrigins.cerebras, variables: ["CEREBRAS_API_KEY"] }
}

/**
 * The first key variable of a compatible provider that is set and non-empty.
 *
 * @category getters
 * @since 1.0.0-rc.0
 */
export const compatibleKey = (
  provider: string,
  environment: Environment.Source
): { readonly variable: string; readonly key: string } | undefined => {
  const entry = Object.hasOwn(compatible, provider) ? compatible[provider] : undefined
  if (entry === undefined) return undefined
  for (const variable of entry.variables) {
    const key = Environment.read(environment, variable)
    if (key !== undefined) return { variable, key }
  }
  return undefined
}

/**
 * The model each candidate runs when nothing overrides it.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultSeat: Readonly<Record<Candidate, string>> = {
  "codex-subscription": "codex:sol",
  "kimi-k3": "moonshot:kimi-k3",
  openai: "openai:gpt-6-sol",
  gemini: "gemini:gemini-2.5-pro",
  openrouter: "openrouter:openai/gpt-6-sol",
  cerebras: "cerebras:qwen-3.8-27b"
}

/**
 * The short seat names a flow, a role table or an operator may write instead
 * of `provider:modelId`. The prefix picks the credential: `openai:` seats run
 * on the Codex (ChatGPT) session or an OpenAI key, `anthropic:` seats on an
 * Anthropic key.
 *
 * @category constants
 * @since 1.0.0
 */
export const seatAliases: Readonly<Record<string, string>> = {
  sol: "openai:gpt-6.1-sol",
  luna: "openai:gpt-6-luna",
  opus: "anthropic:claude-opus-5-5",
  sonnet: "anthropic:claude-sonnet-5-5",
  fable: "anthropic:claude-fable-5-1",
  kimi: defaultSeat["kimi-k3"],
  qwen: defaultSeat.cerebras
}

/**
 * Jev, the decision model. It answers typed classifier questions through the
 * host's `Evaluator` and writes no text, so it is never an agent seat.
 *
 * @category constants
 * @since 1.0.0
 */
export const decisionSeat = { alias: "jev", modelId: Evaluator.defaultModel } as const

/**
 * The relative cost of one seat against the others, read off the provider's
 * list prices: `low`, `mid` or `high`.
 *
 * @category models
 * @since 1.0.0
 */
export type CostTier = "low" | "mid" | "high"

/**
 * What one seat is: the display label, one strength line, and the seat's
 * {@link CostTier}.
 *
 * @category models
 * @since 1.0.0
 */
export interface SeatDescription {
  readonly label: string
  readonly strength: string
  readonly cost: CostTier
}

/**
 * The description of every seat an alias in {@link seatAliases} names, plus
 * the key-backed seats of {@link defaultSeat}, keyed by `provider:modelId`.
 * The tiers come from the committed rate
 * card (`packages/backend/modelprice/prices.go`): `low` under $1 per million
 * input tokens, `high` above $3, `mid` between; a seat with no committed
 * price (Kimi) is tiered from its provider's list price.
 *
 * @category constants
 * @since 1.0.0
 */
export const seatDescriptions: Readonly<Record<string, SeatDescription>> = {
  [seatAliases["sol"]!]: { label: "GPT-6.1 Sol", strength: "Strong all-round coding and reasoning.", cost: "mid" },
  [seatAliases["luna"]!]: {
    label: "GPT-6 Luna",
    strength: "Fast, low-cost mechanical edits and simple tool runs.",
    cost: "low"
  },
  [seatAliases["opus"]!]: {
    label: "Claude Opus 5.5",
    strength: "Dependable planning, review and general work.",
    cost: "high"
  },
  [seatAliases["sonnet"]!]: {
    label: "Claude Sonnet 5.5",
    strength: "Simple, clear changes at mid cost.",
    cost: "mid"
  },
  [seatAliases["fable"]!]: {
    label: "Claude Fable 5.1",
    strength: "The strongest seat: complex, high-stakes work and panel merges.",
    cost: "high"
  },
  [seatAliases["kimi"]!]: { label: "Kimi K3", strength: "Fast UI and visual work.", cost: "low" },
  [seatAliases["qwen"]!]: {
    label: "Qwen 3.8",
    strength: "Very fast, low-cost drafts and UI iterations.",
    cost: "low"
  },
  [defaultSeat.gemini]: {
    label: "Gemini 2.5 Pro",
    strength: "Long-context general coding and reasoning.",
    cost: "mid"
  },
  [defaultSeat.openai]: {
    label: "GPT-6 Sol",
    strength: "Strong all-round coding and reasoning.",
    cost: "mid"
  },
  [defaultSeat.openrouter]: {
    label: "GPT-6 Sol",
    strength: "Strong all-round coding and reasoning.",
    cost: "mid"
  }
}

/**
 * The {@link SeatDescription} of a seat: an alias, or a `provider:modelId`
 * the table names. `undefined` for a seat the table has not met.
 *
 * @category getters
 * @since 1.0.0
 */
export const describeSeat = (seat: string): SeatDescription | undefined => seatDescriptions[expandSeat(seat)]

/**
 * The `provider:modelId` an alias names, or the seat unchanged. Case and
 * surrounding space are ignored for aliases only.
 *
 * @category getters
 * @since 1.0.0
 */
export const expandSeat = (seat: string): string => {
  const alias = seat.trim().toLowerCase()
  return Object.hasOwn(seatAliases, alias) ? seatAliases[alias]! : seat
}

/**
 * True when a seat names Jev, bare or behind any provider prefix.
 *
 * @category getters
 * @since 1.0.0
 */
export const isDecisionSeat = (seat: string): boolean => {
  const value = seat.trim().toLowerCase()
  return value === decisionSeat.alias || value === decisionSeat.modelId || value.endsWith(`:${decisionSeat.modelId}`)
}

/**
 * Why a declared seat cannot run an agent turn, or `undefined` when it can be
 * resolved: an alias, or an explicit `provider:modelId`.
 *
 * @category getters
 * @since 1.0.0
 */
export const seatRefusal = (seat: string): string | undefined => {
  const value = seat.trim().toLowerCase()
  if (isDecisionSeat(seat)) {
    return "jev answers classifier questions through the host evaluator; it cannot run an agent turn"
  }
  if (Object.hasOwn(seatAliases, value)) return undefined
  return /^[a-z0-9-]+:[^\s:]+$/.test(seat)
    ? undefined
    : `${JSON.stringify(seat)} is neither a seat alias (${Object.keys(seatAliases).join(", ")}) nor provider:model`
}

/**
 * Ordered starter credential variables and seats supported by the executor's provider routes.
 *
 * @category constants
 * @since 1.0.0
 */
export const starterSeats: ReadonlyArray<readonly [variable: string, seat: string]> = [
  ["ANTHROPIC_API_KEY", "anthropic:claude-sonnet-4-5"],
  ["OPENAI_API_KEY", defaultSeat.openai],
  ["OPENROUTER_API_KEY", "openrouter:anthropic/claude-sonnet-4.5"],
  ["MOONSHOT_API_KEY", defaultSeat["kimi-k3"]],
  ["GEMINI_API_KEY", defaultSeat.gemini],
  ["GOOGLE_API_KEY", defaultSeat.gemini],
  ["CEREBRAS_API_KEY", defaultSeat.cerebras]
]

const labels: Readonly<Record<Candidate, string>> = {
  "codex-subscription": "Codex subscription",
  "kimi-k3": "Kimi K3",
  openai: "OpenAI",
  gemini: "Gemini",
  openrouter: "OpenRouter",
  cerebras: "Cerebras"
}

const keyed = (
  id: Candidate,
  variables: ReadonlyArray<string>,
  environment: Environment.Source
): Detection => {
  const set = variables.find((variable) => Environment.read(environment, variable) !== undefined)
  const blank = variables.filter((variable) => environment[variable] === "")
  const named = variables.map((variable) => `$${variable}`).join(" or ")
  return {
    id,
    label: labels[id],
    seat: defaultSeat[id],
    available: set !== undefined,
    reason: set !== undefined
      ? `$${set} is set`
      : blank.length === 0
      ? `${named} is not set`
      : `${blank.map((variable) => `$${variable}`).join(" and ")} exported but empty`,
    // Not spelled as an assignment. `Redaction.redactDiagnostic` rewrites anything of
    // the form `<NAME>KEY=<value>`, and this sentence reaches an operator
    // through `cli/LegacyBin.ts` or `cli/Entry.ts`, both of which redact
    // every failure line: the literal
    // `export MOONSHOT_API_KEY=<your key>` printed as
    // `export MOONSHOT_API_KEY=[REDACTED] key>`, which reads like a bug in
    // the hint rather than a rule doing its job.
    setupHint: `set ${variables[0]} to your API key`,
    environment: {}
  }
}

const codex = (host: Host): Detection => ({
  id: "codex-subscription",
  label: labels["codex-subscription"],
  seat: defaultSeat["codex-subscription"],
  setupHint: "install Codex, then run `codex login --device-auth` and set SMITHERS_OPENAI_AUTH=chatgpt",
  environment: { SMITHERS_OPENAI_AUTH: "chatgpt" },
  available: Environment.read(host.environment, "SMITHERS_OPENAI_AUTH") === "chatgpt",
  reason: Environment.read(host.environment, "SMITHERS_OPENAI_AUTH") === "chatgpt"
    ? "SMITHERS_OPENAI_AUTH=chatgpt"
    : "set SMITHERS_OPENAI_AUTH=chatgpt to use Codex"
})

/**
 * One record per candidate, in {@link order}.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const detect = (host: Host): ReadonlyArray<Detection> =>
  order.map((id) => {
    switch (id) {
      case "codex-subscription":
        return codex(host)
      case "kimi-k3":
        return keyed(id, compatible["moonshot"]!.variables, host.environment)
      case "openai":
        return keyed(id, ["OPENAI_API_KEY"], host.environment)
      case "gemini":
        return keyed(id, compatible["gemini"]!.variables, host.environment)
      case "openrouter":
        return keyed(id, ["OPENROUTER_API_KEY"], host.environment)
      case "cerebras":
        return keyed(id, compatible["cerebras"]!.variables, host.environment)
    }
  })

/**
 * What `claude auth status` says about this machine's Claude Code login, and
 * where the binary is. It is everything Smithers reads about a Claude login:
 * never a token or a credentials file, because Anthropic's terms let only
 * Claude Code hold those.
 *
 * @category models
 * @since 1.0.0
 */
export interface ClaudeCodeLogin {
  readonly executable: string
  readonly loggedIn: boolean
  /** `claude.ai` for `claude auth login`, `oauth_token` for `claude setup-token`, `api_key` for a key. */
  readonly authMethod: string
  readonly subscriptionType?: string | undefined
  /** Diagnostic from `claude auth status` when it printed no valid status. */
  readonly error?: string | undefined
}

/** What changes the answer of `claude auth status`: the binary, and the variables that pick its login. */
const loginVariables = [
  "HOME",
  "CLAUDE_CONFIG_DIR"
]

/** One probe per binary and login environment. Failed answers expire so login can be retried. */
type LoginCache = Map<string, { readonly result: Promise<ClaudeCodeLogin>; expiresAt?: number }>
const loginCache: LoginCache = new Map()
// Token-backed environments never share a result across callers. The token value is not read.
const tokenLoginCache = new WeakMap<Environment.Source, LoginCache>()
const signedOutTtl = 30_000

/**
 * The `claude` on `environment`'s `PATH` and what `claude auth status`
 * reports, or `undefined` when there is no `claude`.
 * It runs the binary, so it is the one impure reading a {@link Host} makes.
 *
 * In-flight and subscription statuses are shared per binary and login variables.
 * Other statuses expire after 30 seconds, so `claude auth login`
 * takes effect without a restart.
 *
 * @category constructors
 * @since 1.0.0
 */
export const claudeCodeLogin = (environment: Environment.Source): Promise<ClaudeCodeLogin | undefined> => {
  const executable = (Environment.read(environment, "PATH") ?? "").split(delimiter).filter((dir) => dir !== "")
    .map((dir) => join(dir, "claude")).find((file) => {
      try {
        accessSync(file, constants.X_OK)
        return true
      } catch {
        return false
      }
    })
  if (executable === undefined) return Promise.resolve(undefined)
  const key = JSON.stringify([executable, ...loginVariables.map((name) => Environment.read(environment, name))])
  const tokenBacked = Object.hasOwn(environment, "CLAUDE_CODE_OAUTH_TOKEN") ||
    Object.hasOwn(environment, "ANTHROPIC_AUTH_TOKEN")
  let cache = loginCache
  if (tokenBacked) {
    cache = tokenLoginCache.get(environment) ?? new Map()
    tokenLoginCache.set(environment, cache)
  }
  const known = cache.get(key)
  if (known !== undefined && (known.expiresAt === undefined || known.expiresAt > Date.now())) return known.result
  const result = new Promise<ClaudeCodeLogin>((resolve) => {
    try {
      execFile(
        executable,
        ["auth", "status"],
        { env: { ...environment }, encoding: "utf8", timeout: 15_000 },
        (error, stdout, stderr) => {
          // A signed-out Claude Code exits 1 and still prints its JSON status.
          let status: { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown } | undefined
          try {
            const parsed: unknown = JSON.parse(stdout)
            if (typeof parsed === "object" && parsed !== null) status = parsed
          } catch { /* The executable's stderr explains an invalid or empty status. */ }
          resolve(
            status === undefined
              ? {
                executable,
                loggedIn: false,
                authMethod: "none",
                error: String(
                  Redaction.redactDiagnostic(
                    stderr.trim() || error?.message || "claude auth status returned no valid JSON"
                  )
                )
              }
              : {
                executable,
                loggedIn: status.loggedIn === true,
                authMethod: typeof status.authMethod === "string" ? status.authMethod : "none",
                subscriptionType: typeof status.subscriptionType === "string" ? status.subscriptionType : undefined
              }
          )
        }
      )
    } catch {
      resolve({ executable, loggedIn: false, authMethod: "none", error: "claude auth status could not start" })
    }
  })
  const entry: { readonly result: Promise<ClaudeCodeLogin>; expiresAt?: number } = { result }
  cache.set(key, entry)
  void result.then((login) => {
    entry.expiresAt = login.loggedIn && (login.authMethod === "claude.ai" || login.authMethod === "oauth_token")
      ? Infinity
      : Date.now() + signedOutTtl
  })
  return result
}

/**
 * The vendor status receipt; Smithers never opens its credential store.
 * @category models
 * @since 1.0.0
 */
export interface CodexLogin {
  readonly executable: string
  readonly loggedIn: boolean
}

const codexLoginCache = new Map<string, { readonly result: Promise<CodexLogin>; expiresAt?: number }>()
const codexLoginTtl = 30_000

/**
 * The installed Codex CLI and its subscription login status.
 * In-flight and signed-in results are shared by binary, `HOME` and `CODEX_HOME`.
 * All results expire after 30 seconds so login changes take effect without a restart.
 * @category constructors
 * @since 1.0.0
 */
export const codexLogin = (source: Environment.Source): Promise<CodexLogin | undefined> => {
  const executable = (Environment.read(source, "PATH") ?? "").split(delimiter).filter((directory) => directory !== "")
    .map((directory) => join(directory, "codex")).find((file) => {
      try {
        accessSync(file, constants.X_OK)
        return true
      } catch {
        return false
      }
    })
  if (executable === undefined) return Promise.resolve(undefined)
  const key = JSON.stringify([executable, source.HOME, source.CODEX_HOME])
  const known = codexLoginCache.get(key)
  if (known !== undefined && (known.expiresAt === undefined || known.expiresAt > Date.now())) return known.result
  const result = new Promise<CodexLogin>((resolve) => {
    try {
      execFile(executable, ["login", "status"], {
        env: CodexCode.environment(source),
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 16 * 1024
      }, (error, stdout, stderr) => {
        resolve({ executable, loggedIn: error === null && /Logged in using ChatGPT/i.test(`${stdout}\n${stderr}`) })
      })
    } catch {
      resolve({ executable, loggedIn: false })
    }
  })
  const entry: { readonly result: Promise<CodexLogin>; expiresAt?: number } = { result }
  codexLoginCache.set(key, entry)
  void result.then(() => {
    entry.expiresAt = Date.now() + codexLoginTtl
  })
  return result
}

/**
 * The OpenAI model an alias names, or the model unchanged.
 * @category getters
 * @since 1.0.0
 */
export const codexModel = (model: string): string => {
  const seat = Object.hasOwn(seatAliases, model) ? seatAliases[model]! : ""
  return seat.startsWith("openai:") ? seat.slice("openai:".length) : model
}

/**
 * The seats a Claude subscription serves through Claude Code, one per
 * Anthropic {@link seatAliases} entry: `claude-code:opus` runs what `opus`
 * names, on the user's own Claude Code.
 *
 * @category constants
 * @since 1.0.0
 */
export const claudeCodeSeats: ReadonlyArray<string> = Object.entries(seatAliases)
  .filter(([, seat]) => seat.startsWith("anthropic:")).map(([alias]) => `claude-code:${alias}`)

/**
 * The model Claude Code runs for the model half of a `claude-code:` seat: the
 * Anthropic model an alias names, or the name unchanged.
 *
 * @category getters
 * @since 1.0.0
 */
export const claudeCodeModel = (model: string): string => {
  const seat = Object.hasOwn(seatAliases, model) ? seatAliases[model]! : ""
  return seat.startsWith("anthropic:") ? seat.slice("anthropic:".length) : model
}

/**
 * Whether {@link claudeCodeSeats} run here: only on a Claude subscription,
 * signed in through Claude Code's own flow, and never beside
 * `ANTHROPIC_API_KEY`, which keeps Claude seats on the API.
 *
 * @category constructors
 * @since 1.0.0
 */
export const claudeCode = async (host: Host): Promise<{
  readonly available: boolean
  readonly reason: string
  readonly setupHint: string
  readonly executable?: string | undefined
}> => {
  if (Environment.read(host.environment, "ANTHROPIC_API_KEY") !== undefined) {
    return {
      available: false,
      reason: "$ANTHROPIC_API_KEY is set, so Claude seats run on the API",
      setupHint: "use an anthropic:<model> seat, or unset ANTHROPIC_API_KEY to use your Claude subscription"
    }
  }
  const login = await host.claudeCode?.()
  if (login === undefined) {
    return {
      available: false,
      reason: "Claude Code is not installed",
      setupHint: "install Claude Code (https://code.claude.com), then run `claude auth login`"
    }
  }
  if (!login.loggedIn || (login.authMethod !== "claude.ai" && login.authMethod !== "oauth_token")) {
    return {
      available: false,
      reason: login.error === undefined
        ? "Claude Code is not signed in with a Claude subscription"
        : `Claude Code auth status failed: ${login.error}`,
      setupHint: "run `claude auth login`"
    }
  }
  return {
    available: true,
    reason: `Claude Code is signed in with a Claude ${login.subscriptionType ?? "subscription"}`,
    setupHint: "run `claude auth login`",
    executable: login.executable
  }
}

/**
 * No candidate is available. The message lists every seat looked for, why it
 * was not usable, and how to set it up.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class NoSeatError extends Data.TaggedError("/suggest/NoSeatError")<{
  readonly detections: ReadonlyArray<Detection>
  readonly message: string
}> {
  constructor(detections: ReadonlyArray<Detection>) {
    super({ detections, message: noSeatMessage(detections) })
  }
}

/**
 * Why a `--seat` value is refused: `malformed` when it is not
 * `provider:model`, `anthropic` when it names the provider this verb never
 * uses.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type SeatSyntaxReason = "malformed" | "anthropic"

const seatSyntaxMessage = (seat: string, reason: SeatSyntaxReason): string =>
  reason === "malformed"
    ? `--seat must be spelled provider:model, got "${seat}"`
    : "`smthrs suggest` never uses an Anthropic seat; pass another provider"

/**
 * A `--seat` value that is not `provider:model`, or names a provider this
 * verb never uses. `reason` says which.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class SeatSyntaxError extends Data.TaggedError("/suggest/SeatSyntaxError")<{
  readonly seat: string
  readonly reason: SeatSyntaxReason
  readonly message: string
}> {
  constructor(seat: string, reason: SeatSyntaxReason) {
    super({ seat, reason, message: seatSyntaxMessage(seat, reason) })
  }
}

/**
 * The sentence printed when nothing is available.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const noSeatMessage = (detections: ReadonlyArray<Detection>): string =>
  [
    "No model seat is available for `smthrs suggest`. It looked for:",
    ...detections.map((detection) =>
      `  ${detection.label} (${detection.seat}): ${detection.reason}; to set it up, ${detection.setupHint}`
    ),
    "Or pass --seat <provider:model> for a provider you have a key for."
  ].join("\n")

/**
 * The first available detection, or the operator's override.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const chooseSeat = (
  detections: ReadonlyArray<Detection>,
  override?: string | undefined
): Chosen | NoSeatError | SeatSyntaxError => {
  if (override !== undefined) {
    const separator = override.indexOf(":")
    const provider = separator < 0 ? "" : override.slice(0, separator)
    const model = separator < 0 ? "" : override.slice(separator + 1)
    if (provider === "" || model === "") {
      return new SeatSyntaxError(override, "malformed")
    }
    if (provider === "anthropic") {
      return new SeatSyntaxError(override, "anthropic")
    }
    return { seat: override, source: "override", label: `--seat ${override}`, environment: {} }
  }
  const first = detections.find((detection) => detection.available)
  if (first === undefined) return new NoSeatError(detections)
  return { seat: first.seat, source: first.id, label: first.label, environment: first.environment }
}
