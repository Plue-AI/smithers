/**
 * One origin-bound Smithers login, shared by backend and control-plane clients.
 * @since 0.1.0
 */

import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve as resolvePath } from "node:path"
import { parse, stringify } from "yaml"
import { Refused, UsageError } from "../../CliError.ts"
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
  const refusal = () =>
    new UsageError({
      message: "Smithers API origin must be an HTTP(S) origin without credentials, path, query or fragment"
    })
  let url: URL
  try {
    url = new URL(raw.trim().replace(/\/api\/?$/i, ""))
  } catch {
    throw refusal()
  }
  if (
    !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
    url.pathname !== "/"
  ) throw refusal()
  return url.origin
}
/**
 * @private
 * @since 1.0.0
 */
export const observeOrigin = (raw: string): string => {
  if (!raw.trim()) {
    throw new UsageError({
      message: "observe_url is not configured; run `smithers config set observe_url https://<your Observe console>`"
    })
  }
  let origin: string
  try {
    origin = normalizeOrigin(raw)
  } catch {
    throw new UsageError({ message: "observe_url must be an HTTPS origin (HTTP is allowed on loopback)" })
  }
  const url = new URL(origin)
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new UsageError({ message: "observe_url requires HTTPS except on loopback" })
  }
  return origin
}
const tokenPattern = /^[A-Za-z0-9._~+/=-]+$/
const storageFailed = (action: string) =>
  new Refused({
    fault: "dependency",
    code: "credential_storage_failed",
    message: `Secure credential storage ${action} failed`
  })

// Shared mutation fences contain no credentials. File authority is path-bound;
// native authority is the OS store's host key, even across different homes.
type CredentialEpoch = { revision: number; pending: number }
const credentialEpochs = new Map<string, WeakRef<CredentialEpoch>>()
const identity = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const epochFor = (key: string): CredentialEpoch => {
  for (const [name, reference] of credentialEpochs) if (reference.deref() === undefined) credentialEpochs.delete(name)
  const existing = credentialEpochs.get(key)?.deref()
  if (existing !== undefined) return existing
  const epoch = { revision: 0, pending: 0 }
  credentialEpochs.set(key, new WeakRef(epoch))
  return epoch
}
const mutate = (epoch: CredentialEpoch): () => void => {
  epoch.pending++
  epoch.revision++
  return () => {
    epoch.pending--
    epoch.revision++
  }
}
const lookupCancelled = () => new Refused({ fault: "user", code: "cancelled", message: "Credential lookup cancelled" })
const checkLookup = (signal: AbortSignal | undefined) => {
  if (signal?.aborted) throw lookupCancelled()
}
const fileIdentity = (path: string) => {
  const contents = read(path)
  if (contents === undefined) return undefined
  const stat = statSync(path, { bigint: true })
  return [contents, String(stat.dev), String(stat.ino), String(stat.ctimeNs), String(stat.mtimeNs)]
}
/**
 * A login token that is empty or holds characters no token has.
 * @private
 * @since 1.0.0-rc.1
 */
export const invalidToken = () => new Refused({ fault: "user", code: "invalid_token", message: "Invalid login token" })
/**
 * @private
 * @since 1.0.0
 */
export class Session {
  readonly home: string
  readonly configPath: string
  readonly authPath: string
  readonly env: Readonly<Record<string, string | undefined>>
  private readonly fileEpochs = new Map<string, CredentialEpoch>()
  private readonly nativeEpochs = new Map<string, CredentialEpoch>()
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
  private fileEpoch(path: string): CredentialEpoch {
    const absolute = resolvePath(path)
    const epoch = this.fileEpochs.get(absolute) ?? epochFor(identity(["file", absolute]))
    this.fileEpochs.set(absolute, epoch)
    return epoch
  }
  private nativeEpoch(host: string): CredentialEpoch {
    const key = identity(["native", process.platform, host])
    const epoch = this.nativeEpochs.get(key) ?? epochFor(key)
    this.nativeEpochs.set(key, epoch)
    return epoch
  }
  /** Private cache identity; never a credential or a persisted token cache. */
  credentialIdentity(origin: string): string {
    const target = this.target(origin)
    const token = this.env.SMITHERS_TOKEN?.trim()
    if (token) return identity([target.api_url, "env", token])
    const files = [...new Set([this.fileEpoch(this.configPath), this.fileEpoch(this.authPath)])]
    const native = this.env.SMITHERS_DISABLE_SYSTEM_KEYRING === "1" ? undefined : this.nativeEpoch(target.host)
    if (files.some((epoch) => epoch.pending) || native?.pending) {
      throw new Refused({
        fault: "wait",
        code: "credentials_changing",
        message: "Login is changing. Try again when it finishes"
      })
    }
    // Official cross-process login/logout replaces these files after commit.
    // Arbitrary external keychain edits are not observable without reopening it;
    // a backend 401 invalidates the Client's matching resolution instead.
    return identity([
      target.api_url,
      this.env.SMITHERS_DISABLE_SYSTEM_KEYRING,
      files.map((epoch) => epoch.revision),
      native?.revision,
      fileIdentity(this.configPath),
      fileIdentity(this.authPath)
    ])
  }
  private fileMutation(): () => void {
    const finishes = [...new Set([this.fileEpoch(this.configPath), this.fileEpoch(this.authPath)])].map(mutate)
    return () => {
      for (const finish of finishes) finish()
    }
  }
  config(effective = true): RecordValue {
    const raw = read(this.configPath)
    const invalid = () => new Refused({ fault: "user", code: "invalid_config", message: "Invalid Smithers config" })
    let parsed: unknown
    try {
      parsed = raw === undefined ? {} : parse(raw)
    } catch {
      throw invalid()
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid()
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
    if (!["ssh", "https"].includes(text(config.git_protocol))) {
      throw new UsageError({ message: "git_protocol must be ssh or https" })
    }
    this.write(this.configPath, stringify(config), 0o644)
  }
  write(path: string, data: string, mode = 0o600) {
    const finish = [this.configPath, this.authPath].some((file) => resolvePath(file) === resolvePath(path))
      ? mutate(this.fileEpoch(path))
      : () => {}
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const temporary = `${path}.${process.pid}.tmp`
      try {
        writeFileSync(temporary, data, { mode, flag: "wx" })
        chmodSync(temporary, mode)
        renameSync(temporary, path)
      } finally {
        rmSync(temporary, { force: true })
      }
    } finally {
      finish()
    }
  }
  target(hostname?: string): { api_url: string; host: string } {
    const configured = text(this.config().api_origin)
    let origin = hostname || configured
    if (!origin) {
      throw new Refused({
        fault: "user",
        code: "not_configured",
        message:
          "Smithers API origin is not configured. Set SMITHERS_API_ORIGIN or run smithers config set api_origin ORIGIN"
      })
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
    let record: RecordValue
    try {
      record = JSON.parse(raw) as RecordValue
    } catch {
      throw new Refused({ fault: "user", code: "invalid_config", message: "Invalid Smithers login file" })
    }
    if (record.api_url && normalizeOrigin(text(record.api_url)) !== normalizeOrigin(origin)) return
    if (record.host && record.host !== this.target(origin).host) return
    if (!record.api_url && !record.host) return
    if (!record.api_url) {
      const configured = text(this.config(false).api_origin)
      if (!configured || normalizeOrigin(configured) !== normalizeOrigin(origin)) return
    }
    return record
  }
  async keyring(
    action: "get" | "set" | "delete",
    host: string,
    token?: string,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    checkLookup(signal)
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
      timeoutMs: 10_000,
      signal
    }
    const finish = action === "get" ? () => {} : mutate(this.nativeEpoch(host))
    try {
      let result: Result
      try {
        result = await run(command, args, options).catch((error) =>
          process.platform === "win32" && error instanceof NotFound
            ? run("powershell", args, options)
            : Promise.reject(error)
        )
      } catch (error) {
        if (error instanceof Refused && error.code === "cancelled") throw error
        checkLookup(signal)
        if (error instanceof NotFound) return
        throw storageFailed(action)
      }
      checkLookup(signal)
      if (result.code === 0) return result.stdout.trim() || ""
      if (
        result.code === 44 || /not found|could not be found|cannot find/i.test(result.stderr || "") ||
        (process.platform === "linux" && result.code === 1 && !result.stderr)
      ) return ""
      throw storageFailed(action)
    } finally {
      finish()
    }
  }
  async resolve(origin?: string, signal?: AbortSignal) {
    checkLookup(signal)
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
        const token = await this.keyring("get", target.host, undefined, signal)
        checkLookup(signal)
        if (token) return { ...target, token, source: "keyring" }
      } catch (error) {
        if (error instanceof Refused && error.code === "cancelled") throw error
        checkLookup(signal)
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
  async require(origin?: string, signal?: AbortSignal) {
    const resolved = await this.resolve(origin, signal)
    if (!resolved) {
      throw new Refused({
        fault: "user",
        code: "not_signed_in",
        message: "No Smithers login. Run smithers auth login or set SMITHERS_TOKEN"
      })
    }
    return resolved
  }
  async save(origin: string, token: string, metadata: RecordValue = {}) {
    // Tokens reach `security -i` and the auth file; admit only token characters, never quotes or whitespace.
    if (!tokenPattern.test(token)) throw invalidToken()
    const target = this.target(origin)
    const finish = this.fileMutation()
    try {
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
    } finally {
      finish()
    }
  }
  async clear(origin?: string) {
    const target = this.target(origin), record = this.record(target.api_url)
    const config = this.config(false)
    const finish = this.fileMutation()
    try {
      const bound = config.api_origin && normalizeOrigin(text(config.api_origin)) === target.api_url
      if (record || bound) await this.keyring("delete", target.host)
      if (record) rmSync(this.authPath, { force: true })
      if (config.token && text(config.api_origin) === target.api_url) this.saveConfig({})
      return { status: "logged_out", host: target.host, cleared: !!record, env_active: !!this.env.SMITHERS_TOKEN }
    } finally {
      finish()
    }
  }
}
