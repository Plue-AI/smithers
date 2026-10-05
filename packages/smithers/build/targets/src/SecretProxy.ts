/**
 * Placeholder minting and outbound substitution for declared secrets.
 *
 * `Secret.ts` declares which environment variable holds a value. This module
 * is the execution half: it mints the placeholder a target actually receives,
 * and it replaces that placeholder with the real value on the way out.
 *
 * Four substitution seams exist, and they cover different things.
 *
 * 1. **Request-scoped.** {@link Vault.request} opens an exact-origin boundary.
 *    It resolves each authorized placeholder once while constructing that
 *    request and replaces an exact value echoed in the response.
 * 2. **Child request fields.** {@link startProxy} runs a local HTTP proxy a
 *    spawned tool is pointed at. Plain-HTTP request headers and bodies are
 *    rewritten. HTTPS `CONNECT` streams remain opaque because the boundary
 *    does not terminate TLS, so a tunnel to a declared audience is refused
 *    before any connection reaches it. Tunnels to other hosts pass through,
 *    since a placeholder is worthless anywhere but this proxy.
 * 3. **Secret destination URLs.** {@link Proxy.urlFor} gives a child a
 *    loopback capability URL. The proxy resolves the real HTTP or HTTPS URL
 *    only when the child calls that capability, then performs the outbound
 *    request itself. The true destination never enters child argv or env, and
 *    the boundary is seeded with the resolved URL, its origin, and its request
 *    target, so an upstream that echoes any of them back gets the capability
 *    URL rewritten over it before the child sees the response.
 * 4. **Brokered origins.** {@link Proxy.originFor} binds one loopback
 *    `http://127.0.0.1:<port>` origin per declared audience. The child sends
 *    plain HTTP there; the proxy forwards to the audience over TLS,
 *    substitutes the placeholders bound to it, and rewrites the audience
 *    origin in responses back to the loopback origin. This is how an HTTPS
 *    audience receives a header credential: `S.SecretOrigin(audience)` in an
 *    exec target's argv or env resolves to that origin at spawn time.
 *
 * The value is read from the host environment at substitution time and kept
 * only in the request-local boundary, never in the durable vault. A run that
 * plans without executing, or never reaches an authorized request, never
 * reads the variable at all.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import { randomBytes } from "node:crypto"
import * as NodeHttp from "node:http"
import * as NodeHttps from "node:https"
import * as NodeNet from "node:net"
import * as NodeUtil from "node:util/types"
import * as Secret from "./Secret.ts"
import { placeholderPattern, placeholderPrefix } from "./Secret.ts"

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

/**
 * Raised when a declared secret has no value on this host.
 *
 * Failing is the only safe answer. Substituting nothing would send the
 * placeholder itself to a remote service, which reads as a malformed
 * credential at best and is recorded in someone else's logs at worst.
 *
 * @category errors
 * @since 0.1.0
 */
export class SecretUnavailable extends Schema.TaggedError<SecretUnavailable>()("smithers-build/SecretUnavailable", {
  /** The environment variable that carries no value. */
  env: Schema.String
}) {
  override readonly name = "SecretUnavailable"
  override get message(): string {
    return `the declared secret ${this.env} is not set on this host`
  }
}

/**
 * Raised before egress when a placeholder is used for the wrong origin.
 * @category errors
 * @since 0.1.0
 */
export class SecretAudienceDenied extends Schema.TaggedError<SecretAudienceDenied>()(
  "smithers-build/SecretAudienceDenied",
  {
    /** The environment name identifying the declaration, never its value. */
    env: Schema.String,
    /** The normalized origin the request attempted to reach. */
    audience: Schema.String
  }
) {
  override readonly name = "SecretAudienceDenied"
  override get message(): string {
    return `the declared secret ${this.env} is not authorized for ${this.audience}`
  }
}

/**
 * Raised when a host value cannot safely cross an HTTP request boundary.
 * @category errors
 * @since 0.1.0
 */
export class SecretValueInvalid extends Schema.TaggedError<SecretValueInvalid>()(
  "smithers-build/SecretValueInvalid",
  {
    /** The environment name identifying the declaration, never its value. */
    env: Schema.String
  }
) {
  override readonly name = "SecretValueInvalid"
  override get message(): string {
    return `the declared secret ${this.env} is not bounded control-free text`
  }
}

/**
 * Parses and validates an HTTP CONNECT authority.
 *
 * @category parsing
 * @since 0.1.0
 */
export const parseConnectAuthority = (
  authority: string
): { readonly host: string; readonly port: number } | undefined => {
  let host: string
  let rawPort: string
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]")
    if (close <= 1 || authority[close + 1] !== ":" || NodeNet.isIP(authority.slice(1, close)) !== 6) {
      return undefined
    }
    host = authority.slice(1, close)
    rawPort = authority.slice(close + 2)
  } else {
    const separator = authority.lastIndexOf(":")
    if (separator <= 0 || authority.indexOf(":") !== separator) return undefined
    host = authority.slice(0, separator)
    rawPort = authority.slice(separator + 1)
  }
  if (/[/\\\s\u0000-\u001f\u007f]/.test(host) || !/^\d+$/.test(rawPort)) return undefined
  const port = Number(rawPort)
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? { host, port } : undefined
}

/**
 * Reads one host environment variable.
 *
 * @category models
 * @since 0.1.0
 */
export type Read = (name: string) => string | undefined

/**
 * Maximum UTF-8 bytes accepted for one resolved credential.
 * @category constants
 * @since 0.1.0
 */
export const maximumSecretValueBytes = 16 * 1024

/**
 * Request-scoped substitution and reverse-redaction state.
 * @category models
 * @since 0.1.0
 */
export interface RequestBoundary {
  /** Replaces authorized placeholders, resolving each declaration once. */
  readonly substitute: (text: string) => string
  /**
   * Replaces authorized placeholders in a request target, percent-encoding
   * each substituted value.
   *
   * A resolved value is arbitrary bounded text. Written into a request path
   * verbatim, a space or a code point above U+00FF is rejected by the HTTP
   * client itself, so the value is encoded on the way in and both forms are
   * redacted on the way out.
   */
  readonly substitutePath: (text: string) => string
  /** Replaces authorized placeholders in a header record. */
  readonly substituteHeaders: (
    headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>
  ) => Record<string, string | Array<string>>
  /** Replaces resolved values in response text with their placeholders. */
  readonly redact: (text: string) => string
  /** Replaces resolved values in response bytes with their placeholders. */
  readonly redactBytes: (bytes: Uint8Array) => Buffer
  /**
   * The environment names this boundary has resolved so far, never a value.
   *
   * A transport-level rejection names the declaration the operator has to fix
   * without the diagnostic carrying the credential itself.
   */
  readonly resolvedDeclarations: () => ReadonlyArray<string>
}

/**
 * One value a boundary must never let back out, and what stands in for it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Protected {
  /** The text the child already holds and may see. */
  readonly placeholder: string
  /** The host-owned text that must never reach the child. */
  readonly value: string
}

/**
 * Mints placeholders and substitutes them lazily.
 *
 * @category models
 * @since 0.1.0
 */
export interface Vault {
  /**
   * Mints the placeholder that stands in for one declared secret.
   *
   * Minting twice for the same declaration returns the same placeholder within
   * one vault, so a target that declares a secret in two attrs sees one value.
   */
  readonly mint: (credential: Secret.HttpCredential) => string
  /** Resolves a source for a host-owned destination capability. */
  readonly resolve: (secret: Secret.Secret) => string
  /**
   * Opens one exact-origin request boundary.
   *
   * `protect` seeds the boundary with values it did not resolve itself. The
   * secret-destination path resolves its URL before the boundary exists, so
   * without this the one value that matters is the one value redaction cannot
   * see.
   */
  readonly request: (audience: string, protect?: ReadonlyArray<Protected> | undefined) => RequestBoundary
  /** Whether any placeholder has been minted. */
  readonly isEmpty: () => boolean
  /** Every normalized origin a minted placeholder is bound to. */
  readonly audiences: () => ReadonlySet<string>
}

/**
 * Creates a vault.
 *
 * `read` exists so tests can supply an environment without mutating the
 * process, and so a future host layer can supply one that is not
 * `process.env`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeVault = (options: { readonly read?: Read | undefined } = {}): Vault => {
  if (
    typeof options !== "object" || options === null || NodeUtil.isProxy(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null) ||
    Object.getOwnPropertySymbols(options).length > 0
  ) throw new TypeError("secret vault options must be a plain string-keyed object")
  const names = Object.getOwnPropertyNames(options)
  if (names.some((name) => name !== "read")) throw new TypeError("secret vault received an unknown option")
  const readDescriptor = Object.getOwnPropertyDescriptor(options, "read")
  if (readDescriptor !== undefined && (!("value" in readDescriptor) || readDescriptor.enumerable !== true)) {
    throw new TypeError("secret vault read must be an enumerable data property")
  }
  const declaredRead = readDescriptor !== undefined && "value" in readDescriptor ? readDescriptor.value : undefined
  if (declaredRead !== undefined && typeof declaredRead !== "function") {
    throw new TypeError("secret vault read must be a function")
  }
  const read: Read = declaredRead ?? ((name) => process.env[name])
  const byBinding = new Map<string, string>()
  const byPlaceholder = new Map<string, Secret.HttpCredential>()
  const resolveSecret = (secret: Secret.Secret): string => {
    const hostValue = read(secret.env)
    const value = hostValue === undefined ? secret.fallback : hostValue
    if (value === undefined || value === "") throw new SecretUnavailable({ env: secret.env })
    if (
      typeof value !== "string" || !value.isWellFormed() ||
      Buffer.byteLength(value, "utf8") > maximumSecretValueBytes ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) throw new SecretValueInvalid({ env: secret.env })
    return value
  }
  const mint = (credential: Secret.HttpCredential): string => {
    if (!Secret.isHttpCredential(credential)) throw new TypeError("vault mint requires an HTTP credential binding")
    const snapshot = Secret.HttpSecret(credential.secret, [...credential.audiences])
    const key = JSON.stringify([
      snapshot.secret.env,
      snapshot.secret.fallback ?? null,
      snapshot.audiences
    ])
    const existing = byBinding.get(key)
    if (existing !== undefined) return existing
    const placeholder = `${placeholderPrefix}${toHex(randomBytes(32))}`
    byBinding.set(key, placeholder)
    byPlaceholder.set(placeholder, snapshot)
    return placeholder
  }
  return {
    mint,
    resolve: (secret) => {
      if (!Secret.isSecret(secret)) throw new TypeError("vault resolve requires a secret declaration")
      return resolveSecret(secret)
    },
    request: (audience, protect) => {
      let parsed: URL
      try {
        parsed = new URL(audience)
      } catch {
        throw new TypeError("secret request audience must be an HTTP origin")
      }
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== audience ||
        parsed.username !== "" || parsed.password !== ""
      ) throw new TypeError("secret request audience must be an exact HTTP origin")
      const normalized = parsed.origin
      const resolved = new Map<string, string>()
      const declarations = new Set<string>()
      // Protected text keyed by the exact bytes that must never leave, so one
      // value written in two encodings is two entries pointing at one
      // placeholder.
      const protectedValues = new Map<string, string>()
      const protectValue = (value: string, placeholder: string): void => {
        if (value === "" || protectedValues.has(value)) return
        protectedValues.set(value, placeholder)
      }
      for (const entry of protect ?? []) protectValue(entry.value, entry.placeholder)
      const replaceIn = (text: string, render: (value: string) => string): string => {
        if (byPlaceholder.size === 0 || !text.includes(placeholderPrefix)) return text
        return text.replace(placeholderPattern, (match) => {
          const credential = byPlaceholder.get(match)
          // An unminted placeholder is not ours. Leaving it untouched is what
          // keeps substitution a capability: a target cannot obtain a value
          // by spelling a placeholder it was never given.
          if (credential === undefined) return match
          if (!credential.audiences.includes(normalized)) {
            throw new SecretAudienceDenied({ env: credential.secret.env, audience: normalized })
          }
          const previous = resolved.get(match)
          const value = previous ?? resolveSecret(credential.secret)
          if (previous === undefined) resolved.set(match, value)
          declarations.add(credential.secret.env)
          protectValue(value, match)
          const rendered = render(value)
          protectValue(rendered, match)
          return rendered
        })
      }
      const substitute = (text: string): string => replaceIn(text, (value) => value)
      // Longest first, so a value that contains another is replaced whole
      // rather than leaving the remainder of it in the output.
      const protections = (): ReadonlyArray<readonly [string, string]> =>
        [...protectedValues.entries()].sort((left, right) => right[0].length - left[0].length)
      const redact = (text: string): string => {
        let output = text
        for (const [value, placeholder] of protections()) output = output.split(value).join(placeholder)
        return output
      }
      const redactBytes = (input: Uint8Array): Buffer => {
        let output = Buffer.from(input)
        for (const [value, placeholder] of protections()) {
          const needle = Buffer.from(value, "utf8")
          if (needle.byteLength === 0) continue
          const replacement = Buffer.from(placeholder, "utf8")
          const pieces: Array<Buffer> = []
          let offset = 0
          let index = output.indexOf(needle, offset)
          while (index !== -1) {
            pieces.push(output.subarray(offset, index), replacement)
            offset = index + needle.byteLength
            index = output.indexOf(needle, offset)
          }
          if (pieces.length > 0) {
            pieces.push(output.subarray(offset))
            output = Buffer.concat(pieces)
          }
        }
        return output
      }
      return {
        substitute,
        substitutePath: (text) => replaceIn(text, encodeURIComponent),
        resolvedDeclarations: () => [...declarations],
        substituteHeaders: (headers) => {
          const output: Record<string, string | Array<string>> = {}
          for (const [name, value] of Object.entries(headers)) {
            if (value === undefined) continue
            output[name] = typeof value === "string" ? substitute(value) : value.map(substitute)
          }
          return output
        },
        redact,
        redactBytes
      }
    },
    isEmpty: () => byPlaceholder.size === 0,
    audiences: () => new Set([...byPlaceholder.values()].flatMap((credential) => credential.audiences))
  }
}

/**
 * A running substitution proxy.
 *
 * @category models
 * @since 0.1.0
 */
export interface Proxy {
  /** The loopback endpoint a child is pointed at. */
  readonly endpoint: string
  /** Mints a loopback URL that resolves one secret destination on request. */
  readonly urlFor: (secret: Secret.Secret) => string
  /**
   * Binds a loopback origin that forwards every request to one declared
   * audience and substitutes the placeholders bound to it.
   *
   * The child speaks plain HTTP to `http://127.0.0.1:<port>`; the proxy makes
   * the TLS request itself, so substitution works for HTTPS audiences without
   * a certificate or proxy support in the tool. Binding twice for one audience
   * returns the same origin. An audience no minted placeholder is bound to is
   * refused, because forwarding it would only broker a credential-free call.
   */
  readonly originFor: (audience: string) => Promise<string>
  /** Stops the proxy and every brokered origin, dropping in-flight connections. */
  readonly close: () => Promise<void>
}

/** Private path namespace used for secret destination capabilities. */
const secretUrlPath = "/.well-known/smithers-secret-url/"

/**
 * Maximum request body buffered for placeholder substitution.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumRequestBodyBytes = 16 * 1024 * 1024

/**
 * Maximum upstream response buffered so resolved values can be removed.
 * @category constants
 * @since 0.1.0
 */
export const maximumResponseBodyBytes = 16 * 1024 * 1024

/**
 * Elapsed deadline and socket idle timeout for one proxy-owned upstream request.
 * The deadline starts when the proxy sends the request and includes its response body.
 * @category constants
 * @since 0.1.0
 */
export const upstreamTimeoutMs = 2 * 60 * 1000

/** Hop-by-hop headers a proxy must not forward. */
const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
])

const connectionHeaders = (headers: NodeHttp.IncomingHttpHeaders): ReadonlySet<string> => {
  const value = headers.connection
  const fields = Array.isArray(value) ? value : value === undefined ? [] : [value]
  return new Set(fields.flatMap((field) => field.split(",")).map((field) => field.trim().toLowerCase()).filter(Boolean))
}

/**
 * Maximum brokered origins one proxy binds.
 * @category constants
 * @since 0.1.0
 */
export const maximumBrokeredOrigins = 64

/** Where one accepted child request goes and how its boundary is seeded. */
interface Route {
  readonly target: URL
  readonly protect?: ReadonlyArray<Protected> | undefined
  /** Whether placeholders in the request target are the child's to substitute. */
  readonly substitutePath: boolean
}

/**
 * Sends one accepted child request to its route through a request boundary,
 * and returns the bounded, redacted response.
 */
const delegation = new WeakMap<Vault, Readonly<Record<string, string>>>()

const forward = (
  vault: Vault,
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  route: Route
): void => {
  const target = route.target
  if (target.username !== "" || target.password !== "") {
    response.writeHead(400).end("proxy request URLs must not contain credentials")
    return
  }
  const declaredLength = Number(request.headers["content-length"] ?? "0")
  if (Number.isFinite(declaredLength) && declaredLength > maximumRequestBodyBytes) {
    response.writeHead(413).end("proxy request body is too large")
    request.resume()
    return
  }
  const chunks: Array<Buffer> = []
  let bodyBytes = 0
  let rejected = false
  request.on("data", (chunk: Buffer) => {
    if (rejected) return
    bodyBytes += chunk.byteLength
    if (bodyBytes > maximumRequestBodyBytes) {
      rejected = true
      chunks.length = 0
      response.writeHead(413).end("proxy request body is too large")
      return
    }
    chunks.push(chunk)
  })
  request.on("end", () => {
    if (rejected) return
    let headers: Record<string, string | Array<string>>
    let body: Buffer
    let path: string
    let boundary: RequestBoundary
    try {
      const forwarded: Record<string, string | Array<string> | undefined> = {}
      const nominated = connectionHeaders(request.headers)
      for (const [name, value] of Object.entries(request.headers)) {
        const lower = name.toLowerCase()
        if (!hopByHop.has(lower) && !nominated.has(lower) && lower !== "host" && lower !== "accept-encoding") {
          forwarded[name] = value
        }
      }
      forwarded["accept-encoding"] = "identity"
      boundary = vault.request(target.origin, route.protect)
      headers = boundary.substituteHeaders(forwarded)
      headers.host = target.host
      const raw = Buffer.concat(chunks)
      const text = raw.toString("utf8")
      // Substituting a body only makes sense when it is text that survives
      // a round trip. Binary bodies are forwarded untouched.
      const substituted = Buffer.byteLength(text, "utf8") === raw.byteLength
        ? Buffer.from(boundary.substitute(text), "utf8")
        : raw
      body = substituted
      if (body.byteLength !== raw.byteLength) headers["content-length"] = String(body.byteLength)
      path = route.substitutePath
        ? boundary.substitutePath(`${target.pathname}${target.search}`)
        : `${target.pathname}${target.search}`
    } catch (cause) {
      const denied = cause instanceof SecretAudienceDenied
      const message = cause instanceof SecretUnavailable || cause instanceof SecretValueInvalid || denied
        ? cause.message
        : "secret substitution failed"
      response.writeHead(denied ? 403 : 502).end(message)
      return
    }
    const delegated = delegation.get(vault)?.[target.origin]
    const transportTarget = delegated === undefined ? target : new URL(delegated)
    const requestUpstream = transportTarget.protocol === "https:" ? NodeHttps.request : NodeHttp.request
    // Constructing the client request validates the method, the request
    // target, and every header value, and throws synchronously when one is
    // not something HTTP can carry. Outside a handler that throw is an
    // uncaught exception in an event listener, which ends the whole build
    // process instead of this one target.
    let upstream: NodeHttp.ClientRequest | undefined
    let incoming: NodeHttp.IncomingMessage | undefined
    const timer: { deadline: ReturnType<typeof setTimeout> | undefined } = { deadline: undefined }
    const responseChunks: Array<Buffer> = []
    let settled = false
    const clear = () => {
      clearTimeout(timer.deadline)
      upstream?.setTimeout(0)
      chunks.length = 0
      responseChunks.length = 0
    }
    const fail = (message: string) => {
      if (settled) return
      settled = true
      clear()
      incoming?.destroy()
      upstream?.destroy()
      if (response.headersSent || response.destroyed) response.destroy()
      else response.writeHead(502).end(boundary.redact(message))
    }
    const failError = (error: NodeJS.ErrnoException) => {
      // Error messages can contain secret destinations. Expose only a
      // bounded transport code, and redact even that request-local value.
      const code = typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
        ? `: ${error.code}`
        : ""
      fail(`upstream request failed${code}`)
    }
    try {
      upstream = requestUpstream(
        {
          protocol: transportTarget.protocol,
          hostname: transportTarget.hostname,
          port: transportTarget.port === "" ? (transportTarget.protocol === "https:" ? 443 : 80) : transportTarget.port,
          method: request.method,
          path,
          headers
        },
        (upstreamResponse) => {
          incoming = upstreamResponse
          upstreamResponse.once("error", failError)
          const endedEarly = () => fail("upstream request failed: upstream response ended early")
          upstreamResponse.once("aborted", endedEarly)
          upstreamResponse.once("close", endedEarly)
          if (settled) {
            upstreamResponse.destroy()
            return
          }
          const encoding = upstreamResponse.headers["content-encoding"]
          if (encoding !== undefined && encoding !== "identity") {
            fail("upstream returned an encoded response")
            return
          }
          let responseBytes = 0
          upstreamResponse.on("data", (chunk: Buffer) => {
            if (settled) return
            responseBytes += chunk.byteLength
            if (responseBytes > maximumResponseBodyBytes) {
              fail("upstream response is too large")
              return
            }
            responseChunks.push(chunk)
          })
          upstreamResponse.on("end", () => {
            if (settled) return
            const responseHeaders: Record<string, string | Array<string>> = {}
            const nominated = connectionHeaders(upstreamResponse.headers)
            for (const [name, value] of Object.entries(upstreamResponse.headers)) {
              const lower = name.toLowerCase()
              if (
                value !== undefined && !hopByHop.has(lower) && !nominated.has(lower) &&
                lower !== "content-length" && lower !== "content-encoding"
              ) {
                responseHeaders[name] = Array.isArray(value)
                  ? value.map(boundary.redact)
                  : boundary.redact(value)
              }
            }
            const redacted = boundary.redactBytes(Buffer.concat(responseChunks))
            responseHeaders["content-length"] = String(redacted.byteLength)
            settled = true
            clear()
            response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
            response.end(redacted)
          })
        }
      )
    } catch {
      const named = boundary.resolvedDeclarations()
      fail(
        named.length === 0
          ? "the request could not be represented as an http request"
          : `the declared secret ${named.join(", ")} produced an invalid request target`
      )
      return
    }
    const timedOut = () => fail("upstream request failed: timed out")
    upstream.setTimeout(upstreamTimeoutMs, timedOut)
    upstream.once("error", failError)
    response.once("close", () => {
      if (!response.writableEnded) fail("upstream request failed: child disconnected")
    })
    timer.deadline = setTimeout(timedOut, upstreamTimeoutMs)
    upstream.end(body)
  })
}

const loopbackName = (hostname: string): boolean =>
  hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)

/**
 * The declared audience a CONNECT authority would reach, if any.
 *
 * A tunnel to an audience would carry its placeholder through bytes the proxy
 * cannot read, so the tool would authenticate with the placeholder itself.
 * Loopback names are compared as one host because a tool may spell
 * `localhost` for an audience declared as `127.0.0.1`.
 */
const audienceAt = (
  audiences: ReadonlySet<string>,
  authority: { readonly host: string; readonly port: number }
): string | undefined => {
  const host = authority.host.toLowerCase()
  for (const audience of audiences) {
    const url = new URL(audience)
    const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname
    const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port)
    if (port !== authority.port) continue
    if (hostname === host || (loopbackName(hostname) && loopbackName(host))) return audience
  }
  return undefined
}

/**
 * Starts a loopback HTTP proxy that substitutes authorized placeholders.
 *
 * The proxy binds `127.0.0.1` on an ephemeral port so nothing outside the host
 * can reach it. Requests arrive in absolute form, as an HTTP proxy requires.
 * Request paths, headers, and textual bodies are substituted only after the
 * exact destination origin is known. Upstream bodies are bounded and buffered
 * so exact resolved values can be replaced before the job sees the response.
 *
 * `CONNECT` is tunnelled unless its authority is a declared audience. A
 * placeholder that leaves through a tunnel to any other host is inert: it
 * resolves only through this loopback proxy, and only for its own audiences.
 * A tunnel to an audience is refused, because the placeholder would arrive
 * there encrypted and unresolved. Secret-bearing HTTPS requests use a
 * brokered origin from {@link Proxy.originFor}, or a brokered destination
 * from {@link Proxy.urlFor}; both perform the outbound TLS request here,
 * where substitution is possible.
 *
 * @category constructors
 * @since 0.1.0
 */
export const startProxy = (
  vault: Vault,
  delegatedOrigins: Readonly<Record<string, string>> = JSON.parse(process.env.SMITHERS_SECRET_ORIGINS ?? "{}")
): Promise<Proxy> =>
  new Promise((resolve, reject) => {
    for (const origin of Object.values(delegatedOrigins)) {
      const url = new URL(origin)
      if (
        url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username !== "" || url.password !== "" ||
        url.pathname !== "/" || url.search !== "" || url.hash !== ""
      ) {
        reject(new TypeError("secret delegation requires a loopback origin"))
        return
      }
    }
    delegation.set(vault, { ...delegatedOrigins })
    const destinations = new Map<string, { readonly secret: Secret.Secret; readonly url: string }>()
    const destinationByDeclaration = new Map<string, string>()
    const origins = new Map<string, Promise<string>>()
    const originServers = new Set<NodeHttp.Server>()
    // A CONNECT socket leaves the HTTP server's bookkeeping once it is handed
    // over, so `closeAllConnections` never reaches it. Each accepted socket and
    // each upstream, pending or established, registers its teardown here for
    // `close` to run.
    const tunnels = new Set<() => void>()
    // Loopback origin to the route builder of the audience behind it, so a
    // tool that sends a brokered origin through the proxy anyway lands on the
    // same route instead of being denied for the loopback origin.
    const originRoutes = new Map<string, (requestTarget: string) => Route | string>()
    const originRoute = (audience: string, loopbackOrigin: string) => (requestTarget: string): Route | string => {
      if (!requestTarget.startsWith("/") || requestTarget.startsWith("//")) {
        return "brokered origin requires an origin-form request target"
      }
      const target = new URL(requestTarget, audience)
      if (target.origin !== audience) return "brokered origin requires an origin-form request target"
      return {
        target,
        // An upstream that echoes its own origin, in a redirect or a link,
        // gets the loopback origin written over it, so the child follows it
        // back through this boundary.
        protect: [{ placeholder: loopbackOrigin, value: audience }],
        substitutePath: true
      }
    }
    const server = NodeHttp.createServer((request, response) => {
      const requestUrl = request.url ?? ""
      if (requestUrl.startsWith(secretUrlPath)) {
        const route = requestUrl.slice(secretUrlPath.length)
        const entry = destinations.get(route)
        if (entry === undefined) {
          response.writeHead(404).end("unknown secret destination")
          return
        }
        const destination = entry.secret
        let resolved: string
        try {
          resolved = vault.resolve(destination)
        } catch (cause) {
          const message = cause instanceof SecretUnavailable || cause instanceof SecretValueInvalid
            ? cause.message
            : "secret substitution failed"
          response.writeHead(502).end(message)
          return
        }
        let target: URL
        try {
          target = new URL(resolved)
        } catch {
          response.writeHead(502).end(`the declared secret ${destination.env} is not an http(s) URL`)
          return
        }
        if (target.protocol !== "http:" && target.protocol !== "https:") {
          response.writeHead(502).end(`the declared secret ${destination.env} is not an http(s) URL`)
          return
        }
        // The credential here is the URL itself. An upstream that reflects the
        // request target in a body, a header, or an error page would hand it
        // straight back, so every part of it is protected by the loopback
        // capability the child already holds.
        const capability = new URL(entry.url)
        const requestTarget = `${target.pathname}${target.search}`
        forward(vault, request, response, {
          target,
          substitutePath: false,
          protect: [
            { placeholder: entry.url, value: target.href },
            { placeholder: entry.url, value: resolved },
            { placeholder: capability.origin, value: target.origin },
            ...(requestTarget === "/" ? [] : [{ placeholder: capability.pathname, value: requestTarget }]),
            // A bare slash and an empty search occur in unrelated response text
            // too often to replace safely. The boundary sorts every admitted
            // value longest-first before redacting, so whole URLs win over parts.
            ...(target.pathname === "/" ? [] : [{ placeholder: capability.pathname, value: target.pathname }]),
            ...(target.search === "" ? [] : [{ placeholder: capability.search, value: target.search }])
          ]
        })
        return
      }
      let target: URL
      try {
        target = new URL(requestUrl)
      } catch {
        response.writeHead(400).end("proxy requires an absolute request URL")
        return
      }
      if (target.protocol !== "http:") {
        response.writeHead(400).end("proxy forwards http requests only")
        return
      }
      const brokered = originRoutes.get(target.origin)
      if (brokered !== undefined) {
        const route = brokered(`${target.pathname}${target.search}`)
        if (typeof route === "string") response.writeHead(400).end(route)
        else forward(vault, request, response, route)
        return
      }
      forward(vault, request, response, { target, substitutePath: true })
    })
    server.on("connect", (request, socket: NodeNet.Socket, head: Buffer) => {
      // A refused CONNECT still holds its socket open until the child reads
      // the answer, so the accepted socket is proxy-owned from the start.
      const release = () => socket.destroy()
      tunnels.add(release)
      socket.once("close", () => tunnels.delete(release))
      const authority = parseConnectAuthority(request.url ?? "")
      if (authority === undefined) {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n")
        return
      }
      const audience = vault.isEmpty() ? undefined : audienceAt(vault.audiences(), authority)
      if (audience !== undefined) {
        const message = `CONNECT to ${request.url} refused: ${audience} is a declared secret audience; ` +
          `point the tool at S.SecretOrigin(${JSON.stringify(audience)})`
        socket.end(
          `HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Type: text/plain\r\n` +
            `Content-Length: ${Buffer.byteLength(message, "utf8")}\r\n\r\n${message}`
        )
        return
      }
      let upstream: NodeNet.Socket
      let connected = false
      try {
        upstream = NodeNet.connect(authority, () => {
          connected = true
          clearTimeout(deadline)
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
          if (head.byteLength > 0) upstream.write(head)
          socket.pipe(upstream)
          upstream.pipe(socket)
        })
      } catch {
        socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
        return
      }
      const drop = () => {
        clearTimeout(deadline)
        if (!connected && !socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
        else socket.destroy()
        upstream.destroy()
      }
      // A destination that black-holes the SYN never connects and never
      // errors. Without a deadline the child's CONNECT would wait for the
      // operating system's whole TCP connect timeout, so the same elapsed
      // bound as a proxy-owned request applies here.
      const deadline = setTimeout(drop, upstreamTimeoutMs)
      const teardown = () => {
        clearTimeout(deadline)
        upstream.destroy()
      }
      tunnels.add(teardown)
      upstream.once("error", drop)
      socket.once("error", drop)
      socket.once("close", () => upstream.destroy())
      upstream.once("close", () => {
        tunnels.delete(teardown)
        clearTimeout(deadline)
        socket.destroy()
      })
    })
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(new Error("secret proxy did not bind a loopback port"))
        return
      }
      const bindOrigin = (audience: string): Promise<string> =>
        new Promise((bound, failed) => {
          // A listener accepts nothing before `listen` calls back, and the
          // route exists from then on.
          let routeFor: (requestTarget: string) => Route | string = () => "brokered origin is not ready"
          const listener = NodeHttp.createServer((request, response) => {
            const route = routeFor(request.url ?? "")
            if (typeof route === "string") response.writeHead(400).end(route)
            else forward(vault, request, response, route)
          })
          listener.once("error", failed)
          listener.listen(0, "127.0.0.1", () => {
            const listening = listener.address()
            if (listening === null || typeof listening === "string") {
              listener.close()
              failed(new Error("secret proxy did not bind a brokered origin port"))
              return
            }
            const loopbackOrigin = `http://127.0.0.1:${listening.port}`
            routeFor = originRoute(audience, loopbackOrigin)
            originRoutes.set(loopbackOrigin, routeFor)
            bound(loopbackOrigin)
          })
          originServers.add(listener)
        })
      resolve({
        endpoint: `http://127.0.0.1:${address.port}`,
        urlFor: (secret) => {
          if (!Secret.isSecret(secret)) throw new TypeError("proxy urlFor requires a secret declaration")
          const snapshot = Secret.Secret(secret.env, secret.fallback === undefined ? {} : { fallback: secret.fallback })
          const key = JSON.stringify([snapshot.env, snapshot.fallback ?? null])
          const existing = destinationByDeclaration.get(key)
          if (existing !== undefined) return existing
          const route = toHex(randomBytes(32))
          const url = `http://127.0.0.1:${address.port}${secretUrlPath}${route}`
          destinations.set(route, { secret: snapshot, url })
          destinationByDeclaration.set(key, url)
          return url
        },
        originFor: (audience) => {
          let normalized: string
          try {
            normalized = Secret.normalizeAudience(audience)
          } catch (cause) {
            return Promise.reject(cause)
          }
          const existing = origins.get(normalized)
          if (existing !== undefined) return existing
          if (!vault.audiences().has(normalized)) {
            return Promise.reject(new TypeError(`no declared secret is bound to ${normalized}`))
          }
          if (origins.size >= maximumBrokeredOrigins) {
            return Promise.reject(new TypeError(`secret proxy brokers at most ${maximumBrokeredOrigins} origins`))
          }
          const bound = bindOrigin(normalized)
          origins.set(normalized, bound)
          return bound
        },
        close: () => {
          for (const teardown of tunnels) teardown()
          tunnels.clear()
          return Promise.all(
            [server, ...originServers].map((listening) =>
              new Promise<void>((done) => {
                listening.closeAllConnections()
                listening.close(() => done())
              })
            )
          ).then(() => undefined)
        }
      })
    })
  })
