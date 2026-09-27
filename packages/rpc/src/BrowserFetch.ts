/**
 * Requests and bounded responses for the browser-fetch tool.
 *
 * @since 1.0.0
 */

import type { WorkerFailureCode } from "./WorkerFailureCodes.ts"

/*
 * The browser tool's server half (Wave 10, §2d): fetch-and-extract, not a
 * session. One isomorphic handler shared by the deployed product Worker and
 * the vite dev boundary, with the DNS resolver injected (workerd resolves
 * over DNS-over-HTTPS; the dev server uses node:dns). Hard guards: https
 * only, public hosts only (validated AFTER DNS resolution, on every redirect
 * hop), a size cap, a timeout, no cookies/credentials, and a declared
 * user-agent. The readable text, the final URL, the status, and whether the
 * page may be framed come back; the transcript act line stays one line
 * ("Smithers read <host>") — the raw payload never enters the conversation.
 */

/**
 * Shared browser fetch max bytes used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const BROWSER_FETCH_MAX_BYTES = 1024 * 1024
/**
 * Shared browser fetch timeout ms used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const BROWSER_FETCH_TIMEOUT_MS = 10_000
/**
 * Shared browser fetch max text used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const BROWSER_FETCH_MAX_TEXT = 20_000
const MAX_REDIRECTS = 3

/**
 * Why a browser fetch failed, as a closed set. The sentence is for people; the
 * code decides whose fault it is.
 *
 * @since 1.0.0
 * @category constants
 */
export const BROWSER_FETCH_FAILURE_CODES = [
  "invalid_url",
  "scheme_refused",
  "credentials_in_url",
  "private_host",
  "unresolved",
  "resolver_unavailable",
  "egress_unavailable",
  "timeout",
  "read_failed",
  "too_many_redirects",
  "redirect_invalid"
] as const

/**
 * One reason a browser fetch failed.
 *
 * @since 1.0.0
 * @category models
 */
export type BrowserFetchFailureCode = (typeof BROWSER_FETCH_FAILURE_CODES)[number]

/*
 * The Worker registry row each failure is answered under. Bad input is the
 * reader's; a resolver outage, a timeout or a site that redirects nowhere is a
 * dependency's; a host with no pinned egress was never wired, which is infra.
 */
const BROWSER_FETCH_WORKER_CODES = {
  invalid_url: "request_invalid",
  scheme_refused: "request_invalid",
  credentials_in_url: "request_invalid",
  private_host: "request_invalid",
  unresolved: "request_invalid",
  resolver_unavailable: "upstream_unreachable",
  egress_unavailable: "deployment_not_configured",
  timeout: "upstream_timeout",
  read_failed: "upstream_unreachable",
  too_many_redirects: "upstream_malformed",
  redirect_invalid: "upstream_malformed"
} as const satisfies Record<BrowserFetchFailureCode, WorkerFailureCode>

/**
 * The Worker failure code a browser fetch failure is refused with.
 *
 * @since 1.0.0
 * @category conversions
 */
export const browserFetchWorkerCode = (code: BrowserFetchFailureCode): WorkerFailureCode =>
  BROWSER_FETCH_WORKER_CODES[code]

/**
 * The browser fetch success contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export interface BrowserFetchSuccess {
  readonly ok: true
  readonly status: number
  readonly finalUrl: string
  readonly contentType: string
  readonly text: string
  /** Whether the app may embed the page in an iframe card. */
  readonly frameable: boolean
  /** Why framing is refused, when it is (X-Frame-Options / CSP frame-ancestors). */
  readonly blockReason: string | null
}

/**
 * The browser fetch failure contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export interface BrowserFetchFailure {
  readonly ok: false
  readonly code: BrowserFetchFailureCode
  readonly message: string
}

/**
 * The browser fetch outcome contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export type BrowserFetchOutcome = BrowserFetchSuccess | BrowserFetchFailure

/**
 * The resolve host contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export type ResolveHost = (hostname: string, signal?: AbortSignal) => Promise<ReadonlyArray<string>>

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain"])

const isBlockedHostname = (hostname: string): boolean => {
  const lower = hostname.toLowerCase()
  if (BLOCKED_HOSTNAMES.has(lower)) return true
  return (
    lower.endsWith(".internal") ||
    lower.endsWith(".local") ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".home.arpa") ||
    lower.endsWith(".lan")
  )
}

const parseIpv4 = (ip: string): Array<number> | undefined => {
  const parts = ip.split(".")
  if (parts.length !== 4) return undefined
  const octets = parts.map((part) => Number(part))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined
  if (parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined
  return octets
}

/*
 * A URL's `hostname` keeps IPv6 literals bracketed (`[::1]`) and may carry a
 * zone id — strip both before judging, or every bracketed form walks straight
 * past the guard.
 */
const normalizeIpLiteral = (raw: string): string => {
  const trimmed = raw.trim()
  const unbracketed = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed
  const zone = unbracketed.indexOf("%")
  return zone === -1 ? unbracketed : unbracketed.slice(0, zone)
}

/** The IPv4 inside an IPv4-mapped IPv6 address, in dotted (`::ffff:127.0.0.1`) or hex (`::ffff:7f00:1`) form. */
const mappedIpv4 = (rest: string): string | undefined => {
  if (parseIpv4(rest) !== undefined) return rest
  const groups = rest.split(":")
  if (groups.length !== 2) return undefined
  const high = groups[0] ?? ""
  const low = groups[1] ?? ""
  if (!/^[0-9a-f]{1,4}$/.test(high) || !/^[0-9a-f]{1,4}$/.test(low)) return undefined
  const a = Number.parseInt(high, 16)
  const b = Number.parseInt(low, 16)
  return `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`
}

/** Is one IPv4/IPv6 literal a public, routable address a server-side fetch may target?
 * @since 1.0.0
 * @category conversions
 */
export const isPublicAddress = (raw: string): boolean => {
  const ip = normalizeIpLiteral(raw)
  const v4 = parseIpv4(ip)
  if (v4 !== undefined) {
    const [a, b] = v4 as [number, number, number, number]
    if (a === 0 || a === 10 || a === 127) return false
    if (a === 169 && b === 254) return false // link-local, incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 100 && b >= 64 && b <= 127) return false // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return false // benchmark net
    if (a >= 224) return false // multicast + reserved
    return true
  }
  const lower = ip.toLowerCase()
  if (!lower.includes(":")) return false // not an address form this guard understands
  if (lower.startsWith("::ffff:")) {
    // IPv4-mapped IPv6: judge the embedded v4 address, in either notation.
    const embedded = mappedIpv4(lower.slice(7))
    return embedded === undefined ? false : isPublicAddress(embedded)
  }
  /*
   * Every other IPv6 form is judged by default-deny: only global unicast
   * (2000::/3) is public, routable space. That refuses ::, ::1, the
   * IPv4-compatible ::7f00:1 forms, fc00::/7 unique-local, fe80::/10
   * link-local, and ff00::/8 multicast without enumerating them — a form
   * this guard does not recognise is never treated as public.
   */
  const head = lower.split(":")[0] ?? ""
  if (!/^[0-9a-f]{1,4}$/.test(head)) return false // "" for every "::…" form
  const first = Number.parseInt(head, 16)
  return first >= 0x2000 && first <= 0x3fff
}

const PRIVATE_HOST = "That address points at a private host, which the browser tool never reads."

const guardTarget = async (
  url: URL,
  resolveHost: ResolveHost,
  signal?: AbortSignal
): Promise<BrowserFetchFailure | { readonly addresses: ReadonlyArray<string> }> => {
  if (url.protocol !== "https:") {
    return { ok: false, code: "scheme_refused", message: "Only https:// pages can be read." }
  }
  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      code: "credentials_in_url",
      message: "Pages that include credentials in the URL cannot be read."
    }
  }
  const hostname = url.hostname
  if (hostname === "" || isBlockedHostname(hostname)) {
    return { ok: false, code: "private_host", message: PRIVATE_HOST }
  }
  if (parseIpv4(hostname) !== undefined || hostname.includes(":")) {
    if (!isPublicAddress(hostname)) {
      return { ok: false, code: "private_host", message: PRIVATE_HOST }
    }
    return { addresses: [normalizeIpLiteral(hostname)] }
  }
  let addresses: ReadonlyArray<string>
  try {
    addresses = await resolveHost(hostname, signal)
  } catch (error) {
    // The shared deadline owns the abort wording; only a resolver fault is reported here.
    if (signal?.aborted === true) throw error
    /*
     * A resolver that errors (DoH 429/503, blocked egress, a network fault) is
     * not the same answer as a name that does not exist: the first is worth a
     * retry, the second is bad input. Carry the cause so the user, the model
     * and the operator can tell them apart.
     */
    const cause = error instanceof Error ? error.message : "unknown error"
    return {
      ok: false,
      code: "resolver_unavailable",
      message: `The name resolver did not answer (${cause}); try again.`
    }
  }
  if (addresses.length === 0) {
    return { ok: false, code: "unresolved", message: `The host ${hostname} could not be resolved.` }
  }
  for (const address of addresses) {
    if (!isPublicAddress(address)) {
      return {
        ok: false,
        code: "private_host",
        message: "That address resolves to a private host, which the browser tool never reads."
      }
    }
  }
  return { addresses }
}

/** Pull the readable text out of an HTML page: no scripts, no styles, no tags.
 * @since 1.0.0
 * @category conversions
 */
export const extractReadableText = (html: string): string => {
  // Fold ASCII only so case-insensitive tag offsets still index the original Unicode text.
  const lower = html.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  const parts: Array<string> = []
  let cursor = 0
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor)
    if (start === -1) {
      parts.push(html.slice(cursor))
      break
    }
    parts.push(html.slice(cursor, start), " ")
    // Every search consumes the region it scans. Missing closers discard the
    // remainder instead of retrying from each unmatched opener (quadratic work).
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4)
      if (end === -1) break
      cursor = end + 3
      continue
    }
    const block = /^<(script|style|noscript)\b/.exec(lower.slice(start, start + 11))
    if (block !== null) {
      const closing = `</${block[1]}`
      let search = start + block[0].length
      cursor = html.length
      while (search < html.length) {
        const end = lower.indexOf(closing, search)
        if (end === -1) break
        search = end + closing.length
        while (search < html.length && /\s/.test(html[search]!)) search += 1
        if (html[search] === ">") {
          cursor = search + 1
          break
        }
      }
      continue
    }
    const end = html.indexOf(">", start + 1)
    if (end === -1) break
    cursor = end + 1
  }
  const withoutTags = parts.join("")
  const decoded = withoutTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
  return decoded.replace(/\s+/g, " ").trim().slice(0, BROWSER_FETCH_MAX_TEXT)
}

const ANY_ORIGIN_TOKENS = new Set(["*", "*:*", "https:", "http:", "https://*"])

/*
 * Every enforced Content-Security-Policy applies on its own: a page delivered
 * with two policies must satisfy both, so a permissive first policy cannot
 * override a later `frame-ancestors 'none'`. `Headers.get` joins repeated
 * headers with a comma, and a single header may also carry comma-separated
 * policies, so both spellings are split the same way. Source expressions never
 * contain a comma or a semicolon, which makes the split safe.
 */
const frameAncestorsDirectives = (headers: Headers): Array<string> => {
  const csp = headers.get("content-security-policy")
  if (csp === null) return []
  const directives: Array<string> = []
  for (const policy of csp.split(",")) {
    for (const directive of policy.split(";")) {
      const match = /^\s*frame-ancestors(?:\s+(.*))?$/i.exec(directive)
      if (match !== null) directives.push((match[1] ?? "").trim())
    }
  }
  return directives
}

/** May this response's page be framed by the app? XFO and CSP frame-ancestors answer. */
const frameability = (headers: Headers): { frameable: boolean; blockReason: string | null } => {
  const xfo = headers.get("x-frame-options")
  if (xfo !== null) {
    const value = xfo.toLowerCase()
    if (value.includes("deny") || value.includes("sameorigin")) {
      return { frameable: false, blockReason: `The site refuses embedding (X-Frame-Options: ${xfo.trim()}).` }
    }
  }
  for (const ancestors of frameAncestorsDirectives(headers)) {
    /*
     * frame-ancestors is an allowlist of parents. Unless it admits ANY
     * origin, this app is not on it and the iframe would render blank —
     * so the card says what happened instead (§2d′: never a silent
     * blank). A named-origin list is reported as refusing embedding, and
     * the first policy that refuses is the one named.
     */
    const tokens = ancestors.split(/\s+/).filter((token) => token !== "")
    if (!tokens.some((token) => ANY_ORIGIN_TOKENS.has(token))) {
      return {
        frameable: false,
        blockReason: `The site refuses embedding (Content-Security-Policy frame-ancestors ${ancestors}).`
      }
    }
  }
  return { frameable: true, blockReason: null }
}

/** The same deadline covers DNS, response headers, redirects and body bytes. */
const abortable = <T>(pending: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    signal.addEventListener("abort", abort, { once: true })
  })

const readCapped = async (body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<string> => {
  const reader = body.getReader()
  const chunks: Array<Uint8Array> = []
  let received = 0
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>
    try {
      chunk = await abortable(reader.read(), signal)
    } catch (error) {
      void reader.cancel(error).catch(() => {})
      throw error
    }
    const { value, done } = chunk
    if (done) break
    received += value.byteLength
    chunks.push(value)
    if (received >= BROWSER_FETCH_MAX_BYTES) {
      void reader.cancel("size cap").catch(() => {})
      break
    }
  }
  const merged = new Uint8Array(Math.min(received, BROWSER_FETCH_MAX_BYTES))
  let offset = 0
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, Math.min(chunk.byteLength, merged.byteLength - offset))
    merged.set(slice, offset)
    offset += slice.byteLength
    if (offset >= merged.byteLength) break
  }
  return new TextDecoder().decode(merged)
}

/**
 * The browser fetch deps contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export interface BrowserFetchDeps {
  readonly resolveHost: ResolveHost
  /**
   * Connects to `address` while preserving the URL hostname for Host and TLS
   * certificate/SNI verification. An ordinary hostname-based fetch is not a
   * valid implementation because it would perform a second DNS lookup.
   */
  readonly fetchImpl?: (input: string, init: RequestInit, address: string) => Promise<Response>
  readonly timeoutMs?: number
}

const TOO_MANY_REDIRECTS: BrowserFetchFailure = {
  ok: false,
  code: "too_many_redirects",
  message: "The page redirected too many times."
}

/** Fetch-and-extract one page under the browser tool's hard guards.
 * `timeoutMs` bounds caller settlement across DNS, headers, redirects and body reads.
 * Transport cleanup is best-effort and fire-and-forget; cancellation failures are ignored.
 * @since 1.0.0
 * @category conversions
 */
export const browserFetch = async (
  rawUrl: string,
  deps: BrowserFetchDeps
): Promise<BrowserFetchOutcome> => {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, code: "invalid_url", message: "That is not a URL I can read." }
  }
  const timeoutMs = deps.timeoutMs ?? BROWSER_FETCH_TIMEOUT_MS
  const timeout = AbortSignal.timeout(timeoutMs)

  let current = url
  const failedRead = (error: unknown): BrowserFetchFailure => ({
    ok: false,
    code: timeout.aborted ? "timeout" : "read_failed",
    message: timeout.aborted
      ? `Reading ${current.host} took too long and was stopped.`
      : `Reading ${current.host} failed: ${error instanceof Error ? error.message : "unknown error"}`
  })
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let guarded: Awaited<ReturnType<typeof guardTarget>>
    try {
      guarded = await abortable(guardTarget(current, deps.resolveHost, timeout), timeout)
    } catch (error) {
      return failedRead(error)
    }
    if ("ok" in guarded) return guarded
    if (deps.fetchImpl === undefined) {
      return {
        ok: false,
        code: "egress_unavailable",
        message: "Secure pinned egress is unavailable for the browser tool."
      }
    }
    const address = guarded.addresses[0]!
    let response: Response
    try {
      response = await abortable(
        deps.fetchImpl(current.toString(), {
          method: "GET",
          redirect: "manual",
          signal: timeout,
          headers: {
            "user-agent": "smithers-browser",
            "accept-encoding": "identity",
            accept: "text/html,application/xhtml+xml,text/plain,text/markdown;q=0.8,*/*;q=0.5"
          }
        }, address),
        timeout
      )
    } catch (error) {
      return failedRead(error)
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      void response.body?.cancel().catch(() => {})
      if (location === null) {
        return {
          ok: false,
          code: "redirect_invalid",
          message: `The page answered HTTP ${response.status} with nowhere to go.`
        }
      }
      if (hop === MAX_REDIRECTS) return TOO_MANY_REDIRECTS
      try {
        current = new URL(location, current)
      } catch {
        return { ok: false, code: "redirect_invalid", message: "The page redirected somewhere unreadable." }
      }
      continue
    }
    const contentType = response.headers.get("content-type") ?? ""
    const { frameable, blockReason } = frameability(response.headers)
    if (response.body === null) {
      return {
        ok: true,
        status: response.status,
        finalUrl: current.toString(),
        contentType,
        text: "",
        frameable,
        blockReason
      }
    }
    let raw: string
    try {
      raw = await readCapped(response.body, timeout)
    } catch (error) {
      return failedRead(error)
    }
    const text = contentType.includes("html") || contentType.includes("xhtml")
      ? extractReadableText(raw)
      : raw.slice(0, BROWSER_FETCH_MAX_TEXT)
    return {
      ok: true,
      status: response.status,
      finalUrl: current.toString(),
      contentType,
      text,
      frameable,
      blockReason
    }
  }
  return TOO_MANY_REDIRECTS
}

/** The workerd DNS resolver: DNS-over-HTTPS, since workerd exposes no dns module.
 * @since 1.0.0
 * @category conversions
 */
export const resolveHostOverHttps: ResolveHost = async (hostname, signal) => {
  const query = async (type: string): Promise<Array<string>> => {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
      { headers: { accept: "application/dns-json" }, ...(signal === undefined ? {} : { signal }) }
    )
    if (!response.ok) {
      // A resolver fault is not an empty answer set: surface it so guardTarget can say "try again".
      await response.body?.cancel().catch(() => {})
      throw new Error(`status ${response.status}`)
    }
    const body = (await response.json().catch(() => undefined)) as
      | { Status?: unknown; Answer?: Array<{ type?: unknown; data?: unknown }> }
      | undefined
    // An unreadable body or a SERVFAIL/REFUSED rcode is an outage, never an unknown name.
    if (typeof body !== "object" || body === null) throw new Error("malformed resolver answer")
    if (body.Status !== undefined && body.Status !== 0 && body.Status !== 3) {
      throw new Error(`DNS status ${String(body.Status)}`)
    }
    const wanted = type === "A" ? 1 : 28
    return (body.Answer ?? [])
      .filter((answer) => answer.type === wanted && typeof answer.data === "string")
      .map((answer) => answer.data as string)
  }
  const [a, aaaa] = await Promise.all([query("A"), query("AAAA")])
  return [...a, ...aaaa]
}

/** The JSON body the /api/tools/browser-fetch route answers with. A failure carries
 * the Worker failure code, so the app reads its fault from the registry rather than the status.
 * @since 1.0.0
 * @category conversions
 */
export const browserFetchResponseBody = (
  outcome: BrowserFetchOutcome
): Record<string, unknown> =>
  outcome.ok
    ? {
      status: outcome.status,
      finalUrl: outcome.finalUrl,
      contentType: outcome.contentType,
      text: outcome.text,
      frameable: outcome.frameable,
      blockReason: outcome.blockReason
    }
    : { status: "error", code: browserFetchWorkerCode(outcome.code), message: outcome.message }
