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

import * as Endpoint from "@smthrs/model/Endpoint"
import * as Evaluator from "@smthrs/model/Evaluator"
import { execFileSync } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { delimiter, join } from "node:path"
import * as CodexAuth from "./CodexAuth.ts"
import * as Environment from "./Environment.ts"

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
 * environment to run `seat`: the Codex subscription is an `openai:` seat with
 * `SMITHERS_OPENAI_AUTH=chatgpt`, and every other candidate needs nothing.
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
  readonly claudeCode?: (() => ClaudeCodeLogin | undefined) | undefined
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
  "codex-subscription": "openai:gpt-6-sol",
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
  sol: "openai:gpt-6-sol",
  astra: "openai:gpt-6-astra",
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
    // Not spelled as an assignment. `Redaction.redact` rewrites anything of
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

const codex = (host: Host): Detection => {
  const base = {
    id: "codex-subscription" as const,
    label: labels["codex-subscription"],
    seat: defaultSeat["codex-subscription"],
    setupHint: "run `codex login`, or set SMITHERS_OPENAI_AUTH=chatgpt with a signed-in codex CLI",
    environment: { SMITHERS_OPENAI_AUTH: "chatgpt" }
  }
  const file = CodexAuth.locate(host.environment, host.homeDirectory)
  const text = host.readFile(file)
  if (text !== undefined) {
    const parsed = CodexAuth.parse(text)
    if (parsed.usable) return { ...base, available: true, reason: `${file} holds a ChatGPT session` }
    if (Environment.read(host.environment, "SMITHERS_OPENAI_AUTH") !== "chatgpt") {
      return {
        ...base,
        available: false,
        reason: parsed.reason === "invalid-json"
          ? `${file} is not valid JSON`
          : `${file} holds no ChatGPT token set (an API-key login cannot serve this seat)`
      }
    }
  }
  if (Environment.read(host.environment, "SMITHERS_OPENAI_AUTH") === "chatgpt") {
    // The mode is selected, so the seat is what the operator asked for; the
    // resolver reports the missing or unusable session when it signs.
    return { ...base, available: true, reason: "SMITHERS_OPENAI_AUTH=chatgpt" }
  }
  return { ...base, available: false, reason: `no ${file}` }
}

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
}

/** What changes the answer of `claude auth status`: the binary, and the variables that pick its login. */
const loginVariables = [
  "HOME",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN"
]

/** Signed-in statuses, per process: `claude auth status` costs about 0.2 s and every seat resolve asks. */
const signedIn = new Map<string, ClaudeCodeLogin>()

/**
 * The `claude` on `environment`'s `PATH` and what `claude auth status`
 * reports, or `undefined` when there is no `claude` or it prints no status.
 * It runs the binary, so it is the one impure reading a {@link Host} makes.
 *
 * A signed-in status is remembered for the life of the process, per binary and
 * login variables. A signed-out or missing status is never remembered, so
 * `claude auth login` takes effect without a restart.
 *
 * @category constructors
 * @since 1.0.0
 */
export const claudeCodeLogin = (environment: Environment.Source): ClaudeCodeLogin | undefined => {
  const executable = (Environment.read(environment, "PATH") ?? "").split(delimiter).filter((dir) => dir !== "")
    .map((dir) => join(dir, "claude")).find((file) => {
      try {
        accessSync(file, constants.X_OK)
        return true
      } catch {
        return false
      }
    })
  if (executable === undefined) return undefined
  const key = JSON.stringify([executable, ...loginVariables.map((name) => Environment.read(environment, name))])
  const known = signedIn.get(key)
  if (known !== undefined) return known
  let text: string
  try {
    text = execFileSync(executable, ["auth", "status"], { env: { ...environment }, encoding: "utf8", timeout: 15_000 })
  } catch (error) {
    // A signed-out Claude Code exits 1 and still prints its status.
    text = String((error as { readonly stdout?: unknown }).stdout ?? "")
  }
  try {
    const status = JSON.parse(text) as { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown }
    const login: ClaudeCodeLogin = {
      executable,
      loggedIn: status.loggedIn === true,
      authMethod: typeof status.authMethod === "string" ? status.authMethod : "none",
      subscriptionType: typeof status.subscriptionType === "string" ? status.subscriptionType : undefined
    }
    if (login.loggedIn) signedIn.set(key, login)
    return login
  } catch {
    return undefined
  }
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
export const claudeCode = (host: Host): {
  readonly available: boolean
  readonly reason: string
  readonly setupHint: string
  readonly executable?: string | undefined
} => {
  if (Environment.read(host.environment, "ANTHROPIC_API_KEY") !== undefined) {
    return {
      available: false,
      reason: "$ANTHROPIC_API_KEY is set, so Claude seats run on the API",
      setupHint: "use an anthropic:<model> seat, or unset ANTHROPIC_API_KEY to use your Claude subscription"
    }
  }
  const login = host.claudeCode?.()
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
      reason: "Claude Code is not signed in with a Claude subscription",
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
export class NoSeatError extends Error {
  override readonly name = "NoSeatError"
  readonly detections: ReadonlyArray<Detection>
  constructor(detections: ReadonlyArray<Detection>) {
    super(noSeatMessage(detections))
    this.detections = detections
  }
}

/**
 * A `--seat` value that is not `provider:model`, or names a provider this
 * verb never uses.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class SeatSyntaxError extends Error {
  override readonly name = "SeatSyntaxError"
  readonly seat: string
  constructor(seat: string, message: string) {
    super(message)
    this.seat = seat
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
      return new SeatSyntaxError(override, `--seat must be spelled provider:model, got "${override}"`)
    }
    if (provider === "anthropic") {
      return new SeatSyntaxError(override, "`smthrs suggest` never uses an Anthropic seat; pass another provider")
    }
    return { seat: override, source: "override", label: `--seat ${override}`, environment: {} }
  }
  const first = detections.find((detection) => detection.available)
  if (first === undefined) return new NoSeatError(detections)
  return { seat: first.seat, source: first.id, label: first.label, environment: first.environment }
}
