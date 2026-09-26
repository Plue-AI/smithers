/**
 * How an organization's seats reach a model: the owner's subscriptions by
 * default, API keys only when asked for.
 *
 * `SMITHERS_ORG_AUTH` picks the mode:
 *
 * - `subscription` (the default): `openai:*` seats run on the ChatGPT login
 *   the codex CLI stores (`codex login`, `$CODEX_HOME/auth.json`), and
 *   Anthropic seats on the Claude subscription: `CLAUDE_CODE_OAUTH_TOKEN` (or
 *   `ANTHROPIC_AUTH_TOKEN`) when set, from `claude setup-token`, else the
 *   Claude Code login itself (the macOS keychain item or
 *   `~/.claude/.credentials.json`, read the way `smithers provider connect
 *   claude` reads it), read again at every seat resolution so a login Claude
 *   Code refreshed is picked up. `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are
 *   removed, so a stale key cannot take precedence.
 * - `api-key`: the environment as it is, as the native seat resolver reads it.
 *
 * The resolution itself is `NativeEquipment.seatResolver`'s; this module only
 * decides the environment it sees.
 */
import * as Seat from "@smthrs/agent/Seat"
import type * as SeatResolver from "@smthrs/agent/SeatResolver"
import { Effect } from "effect"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import * as CodexAuth from "../../../packages/smithers/src/CodexAuth.ts"
import { seatResolver } from "../../../packages/smithers/src/internal/NativeEquipment.ts"
import * as Providers from "../../../packages/smithers/src/Providers.ts"

/** The environment variable that picks the mode. */
export const modeVariable = "SMITHERS_ORG_AUTH"

/** Where seats get their credentials. */
export type Mode = "subscription" | "api-key"

/** The API key variables subscription mode removes. */
export const apiKeyVariables = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const

/** The Claude subscription token variables, in the order the native resolver reads them. */
export const claudeTokenVariables = ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const

type Environment = Readonly<Record<string, string | undefined>>

/** The configured mode; anything but the two names is refused. */
export const modeOf = (env: Environment): Mode => {
  const value = (env[modeVariable] ?? "").trim()
  if (value === "" || value === "subscription") return "subscription"
  if (value === "api-key") return "api-key"
  throw new Error(`${modeVariable} must be "subscription" or "api-key", not ${JSON.stringify(value)}`)
}

/** The environment seats resolve against in `env`'s mode. */
export const seatEnvironment = (env: Environment): Environment => {
  if (modeOf(env) === "api-key") return env
  const kept: Record<string, string | undefined> = { ...env, SMITHERS_OPENAI_AUTH: "chatgpt" }
  for (const name of apiKeyVariables) delete kept[name]
  return kept
}

/** The provider a seat routes to, as the native resolver reads it: a bare model id is Anthropic's. */
export const providerOf = (seat: string): string => {
  const expanded = Providers.expandSeat(seat)
  const separator = expanded.indexOf(":")
  return separator < 0 ? "anthropic" : expanded.slice(0, separator)
}

/** A Claude Code subscription login. */
export interface ClaudeLogin {
  readonly accessToken: string
  /** Epoch milliseconds, when the login records one. */
  readonly expiresAt?: number | undefined
  /** Where it was read from, for a person; never the token. */
  readonly source: string
}

/** Reads the Claude Code login's stored credentials document, or `undefined` when there is none. */
export type CredentialsReader = () => { readonly text: string; readonly source: string } | undefined

/** The Claude Code CLI's own store: `$CLAUDE_CONFIG_DIR` or `~/.claude`, then the macOS keychain. */
export const claudeCredentials = (env: Environment): CredentialsReader => () => {
  const configDir = env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR !== ""
    ? env.CLAUDE_CONFIG_DIR
    : join(homedir(), ".claude")
  const file = join(configDir, ".credentials.json")
  try {
    return { text: readFileSync(file, "utf8"), source: file }
  } catch {
    // Not stored in a file: on macOS Claude Code keeps it in the keychain.
  }
  if (process.platform !== "darwin") return undefined
  const found = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
    encoding: "utf8",
    timeout: 10_000
  })
  return found.status === 0 && found.stdout.trim() !== ""
    ? { text: found.stdout.trim(), source: "macOS keychain (Claude Code-credentials)" }
    : undefined
}

/** The login a credentials document holds, or `undefined` when it holds none. */
export const claudeLogin = (read: CredentialsReader): ClaudeLogin | undefined => {
  const stored = read()
  if (stored === undefined) return undefined
  try {
    const oauth: unknown = Reflect.get(Object(JSON.parse(stored.text)), "claudeAiOauth")
    const accessToken: unknown = Reflect.get(Object(oauth), "accessToken")
    const expiresAt: unknown = Reflect.get(Object(oauth), "expiresAt")
    if (typeof accessToken !== "string" || accessToken === "") return undefined
    return { accessToken, source: stored.source, ...(typeof expiresAt === "number" ? { expiresAt } : {}) }
  } catch {
    return undefined
  }
}

/** Where the codex CLI keeps the ChatGPT login `openai:*` seats use in subscription mode. */
export const chatgptLogin = (env: Environment): string => CodexAuth.locate(env)

/** Options for {@link resolver}. */
export interface ResolverOptions {
  /** The Claude Code login's store. Default {@link claudeCredentials} over `env`. */
  readonly credentials?: CredentialsReader | undefined
  /** The current time in epoch milliseconds. Default `Date.now`. */
  readonly now?: (() => number) | undefined
}

/**
 * The organization's seat resolver: the native resolver over
 * {@link seatEnvironment}, and in subscription mode an Anthropic seat with no
 * token variable resolved on the Claude Code login read at that moment.
 */
export const resolver = (
  env: Environment,
  executor: Parameters<typeof seatResolver>[1],
  options: ResolverOptions = {}
): SeatResolver.Service => {
  const seatEnv = seatEnvironment(env)
  const native = seatResolver(seatEnv, executor)
  if (modeOf(env) === "api-key") return native
  const hasToken = claudeTokenVariables.some((name) => (seatEnv[name] ?? "") !== "")
  const read = options.credentials ?? claudeCredentials(env)
  const now = options.now ?? Date.now
  return {
    resolve: (seat) => {
      if (hasToken || providerOf(seat) !== "anthropic") return native.resolve(seat)
      const login = claudeLogin(read)
      if (login === undefined) {
        return Effect.fail(
          new Seat.SeatUnresolved({
            seat,
            message:
              `Sign in to Claude Code (\`claude\`), or set CLAUDE_CODE_OAUTH_TOKEN from \`claude setup-token\`, to run the ${seat} seat`
          })
        )
      }
      if (login.expiresAt !== undefined && login.expiresAt <= now()) {
        return Effect.fail(
          new Seat.SeatUnresolved({
            seat,
            message: `The Claude Code login in ${login.source} expired at ${
              new Date(login.expiresAt).toISOString()
            }; open \`claude\` once to refresh it, or set CLAUDE_CODE_OAUTH_TOKEN from \`claude setup-token\``
          })
        )
      }
      return seatResolver({ ...seatEnv, CLAUDE_CODE_OAUTH_TOKEN: login.accessToken }, executor).resolve(seat)
    }
  }
}
