/**
 * One origin-bound Smithers login, shared by backend and control-plane clients.
 * @since 0.1.0
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { parse, stringify } from "yaml"
import { NotFound, type Result, run } from "./Process.ts"

type RecordValue = Record<string, unknown>
const text = (value: unknown) => typeof value === "string" ? value : ""
const read = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
}
/**
 * @private
 * @since 1.0.0
 */
export const normalizeOrigin = (raw: string): string => {
  const url = new URL(raw.trim().replace(/\/api\/?$/i, ""))
  if (
    !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
    url.pathname !== "/"
  ) throw new Error("Smithers API origin must be an HTTP(S) origin without credentials, path, query or fragment")
  return url.origin
}
/**
 * @private
 * @since 1.0.0
 */
export const observeOrigin = (raw: string): string => {
  const origin = normalizeOrigin(raw)
  const url = new URL(origin)
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("observe_url requires HTTPS except on loopback")
  }
  return origin
}
/**
 * @private
 * @since 1.0.0
 */
export class Session {
  readonly home: string
  readonly configPath: string
  readonly authPath: string
  readonly env: Readonly<Record<string, string | undefined>>
  constructor(env: Readonly<Record<string, string | undefined>>) {
    this.env = env
    this.home = env.HOME || homedir()
    this.configPath = join(
      env.XDG_CONFIG_HOME ||
        (process.platform === "darwin"
          ? join(this.home, "Library", "Application Support")
          : join(this.home, ".config")),
      "smithers",
      "config.toon"
    )
    this.authPath = env.SMITHERS_AUTH_FILE || join(this.home, ".config", "smithers", "auth.json")
  }
  config(effective = true): RecordValue {
    const raw = read(this.configPath)
    const parsed: unknown = raw === undefined ? {} : parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid Smithers config")
    const config = parsed as RecordValue
    return {
      api_origin: text(config.api_origin || config.api_url),
      observe_url: "",
      git_protocol: "ssh",
      ...config,
      ...(effective && this.env.SMITHERS_API_ORIGIN ? { api_origin: this.env.SMITHERS_API_ORIGIN } : {})
    }
  }
  saveConfig(update: RecordValue) {
    const config = { ...this.config(false), ...update }
    delete config.token
    delete config.api_url
    if (config.api_origin) config.api_origin = normalizeOrigin(text(config.api_origin))
    if (config.observe_url) config.observe_url = observeOrigin(text(config.observe_url))
    if (!["ssh", "https"].includes(text(config.git_protocol))) throw new Error("git_protocol must be ssh or https")
    this.write(this.configPath, stringify(config), 0o644)
  }
  write(path: string, data: string, mode = 0o600) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.tmp`
    try {
      writeFileSync(temporary, data, { mode, flag: "wx" })
      chmodSync(temporary, mode)
      renameSync(temporary, path)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
  target(hostname?: string): { api_url: string; host: string } {
    const configured = text(this.config().api_origin)
    let origin = hostname || configured
    if (!origin) {
      throw new Error(
        "Smithers API origin is not configured. Set SMITHERS_API_ORIGIN or run smithers config set api_origin ORIGIN"
      )
    }
    if (!origin.includes("://")) {
      if (configured && new URL(configured).hostname.replace(/^api\./, "") === origin) origin = configured
      else {origin = /^(localhost|127\.|\[::1\])/.test(origin)
          ? `http://${origin}`
          : `https://${origin.startsWith("api.") ? origin : `api.${origin}`}`}
    }
    const api_url = normalizeOrigin(origin)
    return { api_url, host: new URL(api_url).hostname.replace(/^api\./, "") }
  }
  record(origin: string): RecordValue | undefined {
    const raw = read(this.authPath)
    if (!raw?.trim()) return
    const record = JSON.parse(raw) as RecordValue
    if (record.api_url && normalizeOrigin(text(record.api_url)) !== normalizeOrigin(origin)) return
    if (record.host && record.host !== this.target(origin).host) return
    if (!record.api_url && !record.host) return
    if (!record.api_url) {
      const configured = text(this.config(false).api_origin)
      if (!configured || normalizeOrigin(configured) !== normalizeOrigin(origin)) return
    }
    return record
  }
  async keyring(action: "get" | "set" | "delete", host: string, token?: string): Promise<string | undefined> {
    if (this.env.SMITHERS_DISABLE_SYSTEM_KEYRING === "1") return
    let command: string, args: Array<string>, input: string | undefined
    if (process.platform === "darwin") {
      command = "security"
      if (action === "set") {
        const quote = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`
        args = ["-q", "-i"]
        input = `add-generic-password -U -s smithers-cli -a ${quote(host)} -w ${quote(token!)}\n`
      } else {args = [
          action === "get" ? "find-generic-password" : "delete-generic-password",
          "-s",
          "smithers-cli",
          "-a",
          host,
          ...(action === "get" ? ["-w"] : [])
        ]}
    } else if (process.platform === "linux") {
      command = "secret-tool"
      args = [
        action === "get" ? "lookup" : action === "set" ? "store" : "clear",
        ...(action === "set" ? ["--label=Smithers CLI token"] : []),
        "service",
        "smithers-cli",
        "host",
        host
      ]
      input = token
    } else if (process.platform === "win32") {
      command = "pwsh"
      const prefix =
        "[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]>$null; $v=New-Object Windows.Security.Credentials.PasswordVault;"
      const script = action === "get"
        ? "$c=$v.Retrieve('smithers-cli',$env:SMITHERS_CRED_HOST);$c.RetrievePassword();[Console]::Out.Write($c.Password)"
        : action === "delete"
        ? "$v.Remove($v.Retrieve('smithers-cli',$env:SMITHERS_CRED_HOST))"
        : "try{$v.Remove($v.Retrieve('smithers-cli',$env:SMITHERS_CRED_HOST))}catch{};$c=New-Object Windows.Security.Credentials.PasswordCredential('smithers-cli',$env:SMITHERS_CRED_HOST,$env:SMITHERS_CRED_TOKEN);$v.Add($c)"
      args = ["-NoProfile", "-NonInteractive", "-Command", prefix + script]
    } else return
    const options = {
      env: { ...this.env, SMITHERS_CRED_HOST: host, ...(token ? { SMITHERS_CRED_TOKEN: token } : {}) },
      input,
      timeoutMs: 10_000
    }
    let result: Result
    try {
      result = await run(command, args, options).catch((error) =>
        process.platform === "win32" && error instanceof NotFound
          ? run("powershell", args, options)
          : Promise.reject(error)
      )
    } catch (error) {
      if (error instanceof NotFound) return
      throw new Error(`Secure credential storage ${action} failed`)
    }
    if (result.code === 0) return result.stdout.trim() || ""
    if (
      result.code === 44 || /not found|could not be found|cannot find/i.test(result.stderr || "") ||
      (process.platform === "linux" && result.code === 1 && !result.stderr)
    ) return ""
    throw new Error(`Secure credential storage ${action} failed`)
  }
  async resolve(origin?: string) {
    const target = this.target(origin)
    const env = this.env.SMITHERS_TOKEN?.trim()
    if (env) return { ...target, token: env, source: "env" }
    // Go stored by hostname. A record binds that existing keychain item to its exact origin.
    const record = this.record(target.api_url)
    const configOrigin = text(this.config(false).api_origin)
    const bound = record !== undefined || (configOrigin && normalizeOrigin(configOrigin) === target.api_url)
    let storageError: unknown
    if (bound) {
      try {
        const token = await this.keyring("get", target.host)
        if (token) return { ...target, token, source: "keyring" }
      } catch (error) {
        storageError = error
      }
    }
    if (record && text(record.token)) return { ...target, token: text(record.token), source: "smithers_auth_file" }
    if (configOrigin && normalizeOrigin(configOrigin) === target.api_url && text(this.config(false).token)) {
      return { ...target, token: text(this.config(false).token), source: "config" }
    }
    if (storageError) throw storageError
    return undefined
  }
  async require(origin?: string) {
    const resolved = await this.resolve(origin)
    if (!resolved) throw new Error("No Smithers login. Run smithers auth login or set SMITHERS_TOKEN")
    return resolved
  }
  async save(origin: string, token: string, metadata: RecordValue = {}) {
    if (!token.trim() || /[\r\n\s]/.test(token.trim())) throw new Error("Invalid login token")
    const target = this.target(origin)
    const stored = await this.keyring("set", target.host, token)
    this.write(
      this.authPath,
      JSON.stringify({
        ...metadata,
        ...target,
        ...(stored === undefined ? { token } : {}),
        updated_at: new Date().toISOString()
      }) + "\n"
    )
    this.saveConfig({ api_origin: target.api_url })
    return { ...target, source: stored === undefined ? "smithers_auth_file" : "keyring" }
  }
  async clear(origin?: string) {
    const target = this.target(origin), record = this.record(target.api_url)
    const config = this.config(false)
    const bound = config.api_origin && normalizeOrigin(text(config.api_origin)) === target.api_url
    if (record || bound) await this.keyring("delete", target.host)
    if (record) rmSync(this.authPath, { force: true })
    if (config.token && text(config.api_origin) === target.api_url) this.saveConfig({})
    return { status: "logged_out", host: target.host, cleared: !!record, env_active: !!this.env.SMITHERS_TOKEN }
  }
}
