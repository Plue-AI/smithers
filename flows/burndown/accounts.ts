import * as Schema from "effect/Schema"
import { execFile as execute } from "node:child_process"
import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

export const Account = Schema.Struct({
  id: Schema.String,
  tool: Schema.Literals(["claude", "codex"]),
  email: Schema.String,
  directory: Schema.String,
  aliases: Schema.Array(Schema.String)
})
export type Account = typeof Account.Type
export const Usage = Schema.Struct({
  windows: Schema.Array(Schema.Struct({
    name: Schema.Literals(["five_hour", "seven_day", "primary"]),
    used: Schema.Number,
    resetsAt: Schema.Number,
    durationHours: Schema.Number
  })),
  limitReached: Schema.Boolean
})
export type Usage = typeof Usage.Type
export const AccountError = Schema.Struct({
  _tag: Schema.Literals(["LoginExpired", "NoToken", "UsageUnavailable"]),
  accountId: Schema.String,
  message: Schema.String
})
export type AccountError = typeof AccountError.Type
export const Reading = Schema.Struct({
  account: Account,
  usage: Schema.NullOr(Usage),
  error: Schema.NullOr(AccountError),
  observedAt: Schema.Number
})
export type Reading = typeof Reading.Type

type Json = Record<string, any>
const jsonFile = async (path: string): Promise<Json> => JSON.parse(await readFile(path, "utf8"))
export interface DiscoveryOptions {
  home?: string
  accountsDir?: string
  excludeEmails?: string
}
export async function discoverAccounts(options: DiscoveryOptions = {}) {
  const home = options.home ?? homedir()
  const base = resolve(options.accountsDir ?? process.env.BURNDOWN_ACCOUNTS_DIR ?? join(home, ".smithers/accounts"))
  const excludes = new Set(
    (options.excludeEmails ?? process.env.BURNDOWN_EXCLUDE_EMAILS ?? "")
      .split(",").map((email) => email.trim().toLowerCase()).filter(Boolean)
  )
  const skipped: Array<{ id: string; directory: string; reason: string }> = []
  const accounts: Array<Account> = []
  let entries: Array<string> = []
  try {
    entries = await readdir(base)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const candidates = entries.filter((id) => /^(claude|codex)-/.test(id)).sort()
    .map((id) => ({ id: id === "codex-default" ? "accounts/codex-default" : id, directory: join(base, id) }))
  candidates.push({ id: "codex-default", directory: join(home, ".codex") })
  for (const { id, directory } of candidates) {
    const tool = id.startsWith("claude-") ? "claude" : "codex"
    try {
      const auth = await jsonFile(join(directory, tool === "claude" ? ".claude.json" : "auth.json"))
      const email = tool === "claude" ?
        auth.oauthAccount?.emailAddress :
        JSON.parse(Buffer.from(auth.tokens?.id_token?.split(".")[1] ?? "", "base64url").toString()).email
      if (typeof email !== "string" || !email.trim()) throw new Error("Missing login email")
      if (excludes.has(email.trim().toLowerCase())) {
        skipped.push({ id, directory, reason: "Excluded email" })
        continue
      }
      const duplicate = accounts.find((account) =>
        account.tool === tool && account.email.toLowerCase() === email.trim().toLowerCase()
      )
      if (duplicate) accounts[accounts.indexOf(duplicate)] = { ...duplicate, aliases: [...duplicate.aliases, id] }
      else accounts.push({ id, directory, tool, email: email.trim(), aliases: [] })
    } catch {
      skipped.push({ id, directory, reason: "Missing or invalid login" })
    }
  }
  return { accounts, skipped }
}

export type UsageFetcher = (input: string, init?: RequestInit) => Promise<Response>
export interface UsageOptions {
  platform?: NodeJS.Platform
  fetch?: UsageFetcher
  execFile?: (file: string, args: Array<string>, options?: { timeout: number }) => Promise<{ stdout: string }>
  now?: () => number
}
function failure(account: Account, tag: AccountError["_tag"], message: string): AccountError {
  return { _tag: tag, accountId: account.id, message }
}
export function accountEnv(account: Account): Record<string, string> {
  return account.tool === "codex" ? { CODEX_HOME: account.directory } : { CLAUDE_CONFIG_DIR: account.directory }
}
/** Resolve on every dispatch; never persist the bearer token in a flow payload. */
export async function freshAccessToken(account: Account, options: UsageOptions = {}): Promise<string> {
  try {
    let token: unknown
    if (account.tool === "codex") token = (await jsonFile(join(account.directory, "auth.json"))).tokens?.access_token
    else {
      let credentials: Json
      if ((options.platform ?? process.platform) === "darwin") {
        const suffix = resolve(account.directory) === join(homedir(), ".claude") ?
          "" :
          `-${createHash("sha256").update(resolve(account.directory)).digest("hex").slice(0, 8)}`
        const result = await (options.execFile ?? promisify(execute))("security", [
          "find-generic-password",
          "-s",
          `Claude Code-credentials${suffix}`,
          "-w"
        ], { timeout: 30_000 })
        credentials = JSON.parse(result.stdout)
      } else credentials = await jsonFile(join(account.directory, ".credentials.json"))
      token = credentials.claudeAiOauth?.accessToken
    }
    if (typeof token !== "string" || !token) throw new Error("No token")
    return token
  } catch {
    throw failure(account, "NoToken", "No access token available")
  }
}
export async function readUsage(account: Account, options: UsageOptions = {}): Promise<Reading> {
  const observedAt = (options.now ?? Date.now)()
  try {
    const token = await freshAccessToken(account, options)
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    if (account.tool === "claude") headers["anthropic-beta"] = "oauth-2025-04-20"
    else {
      const auth = await jsonFile(join(account.directory, "auth.json"))
      if (!auth.tokens?.account_id) throw failure(account, "NoToken", "No ChatGPT account id available")
      headers["ChatGPT-Account-Id"] = auth.tokens.account_id
      headers["User-Agent"] = "codex_cli_rs"
    }
    const response = await (options.fetch ?? globalThis.fetch)(
      account.tool === "claude"
        ? "https://api.anthropic.com/api/oauth/usage" :
        "https://chatgpt.com/backend-api/wham/usage",
      { headers, signal: AbortSignal.timeout(30_000) }
    )
    if (response.status === 401) throw failure(account, "LoginExpired", "Login expired")
    if (!response.ok) throw failure(account, "UsageUnavailable", `Usage HTTP ${response.status}`)
    const body: Json = await response.json()
    const windows = account.tool === "claude" ?
      ["five_hour", "seven_day"].map((name) => ({
        name: name as "five_hour" | "seven_day",
        used: body[name]?.utilization,
        resetsAt: Date.parse(body[name]?.resets_at),
        durationHours: name === "five_hour" ? 5 : 168
      })) :
      [{
        name: "primary" as const,
        used: body.rate_limit?.primary_window?.used_percent,
        resetsAt: body.rate_limit?.primary_window?.reset_at * 1000,
        durationHours: body.rate_limit?.primary_window?.limit_window_seconds / 3600
      }]
    if (
      windows.some((window) =>
        !Number.isFinite(window.used) || window.used < 0 || window.used > 100 ||
        !Number.isFinite(window.resetsAt) || !Number.isFinite(window.durationHours) || window.durationHours <= 0
      )
    ) {
      throw failure(account, "UsageUnavailable", "Invalid usage response")
    }
    return {
      account,
      observedAt,
      usage: { windows, limitReached: body.rate_limit?.limit_reached === true },
      error: null
    }
  } catch (error) {
    const typed = error as AccountError
    return {
      account,
      observedAt,
      usage: null,
      error: ["NoToken", "LoginExpired", "UsageUnavailable"].includes(typed?._tag)
        ? typed :
        failure(account, "UsageUnavailable", "Usage request failed")
    }
  }
}
export async function readAccounts(
  accounts: ReadonlyArray<Account>,
  options: UsageOptions = {}
): Promise<Array<Reading>> {
  return Promise.all(accounts.map((account) => readUsage(account, options)))
}
