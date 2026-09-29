/**
 * The CLI's authenticated backend transport and shared command inputs.
 * @since 0.1.0
 */

import * as Redaction from "@smthrs/journal/Redaction"
import * as Data from "effect/Data"
import { homedir } from "node:os"
import { createInterface } from "node:readline/promises"
import { StringDecoder } from "node:string_decoder"
import type { Runtime } from "../../cli/ControlBridge.ts"
import { processHost, repoFromRemote, resolveRepo } from "../../commands/Open.ts"
import { packageVersion } from "../../Version.ts"
import { run } from "./Process.ts"
import { Session } from "./Session.ts"

/**
 * @private
 * @since 1.0.0
 */
export type Values = Record<string, unknown>
/**
 * @private
 * @since 1.0.0
 */
export const object = (value: unknown): Values =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Values : {}
/**
 * @private
 * @since 1.0.0
 */
export const list = (value: unknown): Array<unknown> => Array.isArray(value) ? value : []
/**
 * @private
 * @since 1.0.0
 */
export const str = (value: unknown): string => value === undefined || value === null ? "" : String(value)
/**
 * @private
 * @since 1.0.0
 */
export const esc = (value: unknown): string => encodeURIComponent(str(value))
/**
 * @private
 * @since 1.0.0
 */
export const query = (values: Values): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") search.set(key, str(value))
  }
  return search.size ? `?${search}` : ""
}
/**
 * @private
 * @since 1.0.0
 */
export const pick = (values: Values, keys: Array<string>): Values =>
  Object.fromEntries(
    keys.filter((key) => values[key] !== undefined).map((key) => [key.replaceAll("-", "_"), values[key]])
  )
/**
 * @private
 * @since 1.0.0
 */
export const positive = (value: unknown, label = "id"): number => {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Invalid ${label}`)
  return n
}
/**
 * @private
 * @since 1.0.0
 */
export class APIError extends Data.TaggedError("/backend/APIError")<{
  readonly status: number
  readonly detail: Values
  readonly message: string
}> {
  constructor(status: number, detail: Values, method: string, path: string, headers: Headers) {
    super({
      status,
      detail,
      message: `${method} ${path} -> ${status}: ${str(detail.message) || "Request failed"}${
        headers.get("x-request-id") ? ` [request ${headers.get("x-request-id")}]` : ""
      }`
    })
  }
}
/**
 * @private
 * @since 1.0.0
 */
export class Client {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly session: Session
  readonly runtime: Runtime
  readonly live: boolean
  private readonly secrets = new Set<string>()
  // Whether a line is still arriving on each channel; the redactor holds it.
  private readonly outputPartial = { stdout: false, stderr: false }
  private readonly outputDecoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") }
  // The diagnostic rules plus this session's secrets; protect() appends to
  // them. Live output is redacted a line at a time, holding a value that spans
  // lines until it closes, and a line redactor reads these rules on every line.
  private readonly outputRules: Array<Redaction.Rule> = [...Redaction.diagnosticRules]
  private readonly outputRedactors = {
    stdout: Redaction.lineRedactor(this.outputRules),
    stderr: Redaction.lineRedactor(this.outputRules)
  }
  constructor(runtime: Runtime = {}, live = false) {
    this.runtime = runtime
    this.live = live
    this.env = runtime.environment ?? process.env
    this.session = new Session(this.env)
  }
  get home() {
    return this.env.HOME || homedir()
  }
  protect(value: string) {
    if (!value || this.secrets.has(value)) return
    this.secrets.add(value)
    // Each line of a multi-line secret is protected on its own as well: live
    // output reaches the rules one line, or one held block, at a time.
    const lines = value.split(/\r?\n/).filter((line) => line !== value && line.length >= 8)
    for (const literal of [value, ...lines]) {
      this.outputRules.push({ id: "session", pattern: new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") })
    }
  }
  redact(value: unknown) {
    // Everything this redacts reaches a terminal or an error message, never a
    // durable row, so it takes the diagnostic rules plus this session's secrets.
    return Redaction.redact(value, { rules: this.outputRules })
  }
  write(text: string) {
    ;(this.runtime.stderr ?? process.stderr).write(str(this.redact(text)))
  }
  output(out: Buffer, err: Buffer) {
    if (!this.live) return
    this.outputChunk("stdout", out)
    this.outputChunk("stderr", err)
  }
  private outputChunk(channel: "stdout" | "stderr", chunk?: Buffer) {
    const decoder = this.outputDecoders[channel]
    const redactor = this.outputRedactors[channel]
    const segments = (chunk === undefined ? decoder.end() : decoder.write(chunk)).split("\n")
    const last = segments.pop()!
    const lines = segments.flatMap(redactor.line)
    if (last !== "") redactor.part(last)
    this.outputPartial[channel] = last !== "" || (segments.length === 0 && this.outputPartial[channel])
    // A stream that ends inside a line ends without a newline, as it arrived.
    let complete = true
    if (chunk === undefined) {
      complete = !this.outputPartial[channel]
      this.outputPartial[channel] = false
      lines.push(...redactor.flush())
    }
    if (lines.length) (this.runtime[channel] ?? process[channel]).write(`${lines.join("\n")}${complete ? "\n" : ""}`)
  }
  flushOutput() {
    if (!this.live) return
    this.outputChunk("stdout")
    this.outputChunk("stderr")
  }
  async exec(command: string, args: Array<string>, extra: NodeJS.ProcessEnv = {}, input?: string): Promise<string> {
    const result = await run(command, args, {
      env: { ...this.env, ...extra },
      input,
      timeoutMs: 120_000,
      signal: this.runtime.signal
    }).catch((error: Error) => {
      throw new Error(error.message.endsWith("timed out") ? `${command} failed (timed out)` : `${command} failed`)
    })
    if (result.code !== 0) throw new Error(`${command} failed`)
    return result.stdout.trim()
  }
  /**
   * The repository from `value`, else the checkout's remote on this backend,
   * else — with `fallback` — the repository its origin names on those hosts.
   */
  repo(value?: unknown, fallback?: ReadonlySet<string>): string {
    const host = this.session.target().host.toLowerCase()
    const hosts = new Set([
      host,
      `ssh.${host}`,
      `api.${host}`,
      ...(["localhost", "127.0.0.1"].includes(host) ? ["smithers.sh", "ssh.smithers.sh", "api.smithers.sh"] : [])
    ])
    const explicit = str(value).trim()
    if (explicit) {
      const parsed = /^[\w.-]+\/[\w.-]+$/.test(explicit) ? explicit : repoFromRemote(explicit, hosts)
      if (!parsed || parsed.split("/").some((part) => part === "." || part === "..")) {
        throw new Error("Expected OWNER/REPO or a clone URL")
      }
      return parsed.split("/").map(esc).join("/")
    }
    const local = processHost(this.env)
    let inferred: string
    try {
      inferred = resolveRepo(local, process.cwd(), hosts)
    } catch (error) {
      if (!fallback) throw error
      inferred = resolveRepo(local, process.cwd(), fallback, "origin")
    }
    return inferred.split("/").map(esc).join("/")
  }
  repoPath(value?: unknown) {
    return `/api/repos/${this.repo(value)}`
  }
  async confirm(yes: unknown, description: string) {
    if (yes === true) return
    if (!process.stdin.isTTY) throw new Error(`${description} requires --yes when stdin is not a TTY`)
    const prompt = createInterface({ input: process.stdin, output: process.stderr })
    try {
      if (!/^(y|yes)$/i.test((await prompt.question(`Confirm ${description}? [y/N] `)).trim())) {
        throw new Error("Operation cancelled")
      }
    } finally {
      prompt.close()
    }
  }
  async stdin(label: string, allowEmpty = false): Promise<string> {
    let text = ""
    for await (const chunk of process.stdin) {
      text += chunk
      if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error(`${label} exceeds 4 MiB`)
    }
    if (!allowEmpty && !text.trim()) throw new Error(`${label} is required on stdin`)
    return text.trim()
  }
  async response(
    method: string,
    path: string,
    body?: unknown,
    options: {
      origin?: string
      anonymous?: boolean
      token?: string
      headers?: Record<string, string>
      stream?: boolean
      signal?: AbortSignal
    } = {}
  ): Promise<Response> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("API path must start with /")
    const origin = options.origin ?? this.session.target().api_url
    const token = options.anonymous ? undefined : options.token ?? (await this.session.require(origin)).token
    if (token) this.protect(token)
    const remember = (value: unknown) => {
      for (const [key, item] of Object.entries(object(value))) {
        if (
          typeof item === "string" && item &&
          (/token|password|secret/i.test(key) || key === "value" && path.includes("/secrets"))
        ) this.protect(item)
        else if (item && typeof item === "object") remember(item)
      }
    }
    remember(body)
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      if (/authorization|token|secret/i.test(key)) this.protect(value.replace(/^(?:Bearer|token)\s+/i, ""))
    }
    const headers = {
      "user-agent": `smithers-cli/${packageVersion}`,
      accept: options.stream ? "text/event-stream" : "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `token ${token}` } : {}),
      ...options.headers
    }
    const requestSignal = options.signal ?? this.runtime.signal
    const signal = options.stream
      ? requestSignal
      : AbortSignal.any([AbortSignal.timeout(120_000), ...(requestSignal ? [requestSignal] : [])])
    const response = await fetch(`${origin}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
      redirect: "error"
    })
    if (!response.ok) {
      let detail: Values = {}
      try {
        detail = object(JSON.parse(await this.text(response)))
      } catch { /* use status */ }
      throw new APIError(response.status, detail, method, path, response.headers)
    }
    return response
  }
  async text(response: Response, maximum = 4 * 1024 * 1024): Promise<string> {
    const chunks: Array<Uint8Array> = []
    let size = 0
    if (response.body) {
      for await (const chunk of chunksOf(response.body)) {
        size += chunk.length
        if (size > maximum) throw new Error("API response exceeds maximum size")
        chunks.push(chunk)
      }
    }
    return Buffer.concat(chunks).toString("utf8")
  }
  async request(
    method: string,
    path: string,
    body?: unknown,
    options?: Parameters<Client["response"]>[3]
  ): Promise<unknown> {
    const response = await this.response(method, path, body, options)
    const text = await this.text(response)
    return text.trim() ? JSON.parse(text) : null
  }
  async pages(path: (cursor: string) => string, cursor = "", all = false, key = "items"): Promise<unknown> {
    const items: Array<unknown> = [], seen = new Set<string>()
    do {
      if (seen.has(cursor)) throw new Error("API repeated a pagination cursor")
      seen.add(cursor)
      const response = await this.response("GET", path(cursor))
      const data: unknown = JSON.parse(await this.text(response))
      cursor = response.headers.get("x-next-cursor") ?? ""
      if (!all) return cursor ? { [key]: data, next_cursor: cursor } : data
      items.push(...list(data))
    } while (cursor)
    return items
  }
  async events(
    path: string,
    stop = "done",
    terminalStatuses: Array<string> = [],
    defaultType = "log"
  ): Promise<Array<unknown>> {
    const response = await this.response("GET", path, undefined, { stream: true })
    const events: Array<unknown> = []
    let buffer = ""
    if (!response.body) return events
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    try {
      while (true) {
        const chunk = await reader.read()
        buffer = (buffer + (chunk.done ? "\n\n" : chunk.value)).replaceAll("\r\n", "\n")
        if (buffer.length > 4 * 1024 * 1024) throw new Error("Event exceeds maximum size")
        let end: number
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const lines = buffer.slice(0, end).split("\n")
          buffer = buffer.slice(end + 2)
          const raw = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join(
            "\n"
          )
          if (!raw) continue
          const type = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || defaultType
          let data: unknown = raw
          try {
            data = JSON.parse(raw)
          } catch { /* plain text event */ }
          const id = lines.find((line) => line.startsWith("id:"))?.slice(3).trim()
          events.push({ type, data, ...(id ? { id } : {}) })
          this.write(`${str(object(data).content ?? object(data).status ?? raw)}\n`)
          if (type === stop || terminalStatuses.includes(str(object(data).status))) return events
        }
        if (chunk.done) break
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
    return events
  }
}

/** @private
 * @since 1.0.0
 */
export async function* chunksOf(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return
      yield chunk.value
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}
