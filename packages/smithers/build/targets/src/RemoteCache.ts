/**
 * Inert remote-cache configuration for a workspace root PACKAGE.ts file.
 *
 * @since 0.1.0
 */

import * as NodeUtil from "node:util/types"
import * as Secret from "./Secret.ts"

/**
 * Runtime marker for a remote-cache declaration.
 *
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("smithers-build/RemoteCache") as never

/**
 * Environment variable read for the bearer token when none is declared.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultTokenEnv = "SMITHERS_CACHE_TOKEN"

/**
 * Maximum UTF-8 size of one remote-cache endpoint.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumEndpointBytes = 8 * 1024

/**
 * Maximum length of the environment-variable name carrying a cache token.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumTokenEnvironmentLength = 256

/**
 * A pure remote-cache declaration.
 *
 * The declaration carries only the HTTPS endpoint and the name of the
 * environment variable holding its bearer token. The token value remains
 * host state and is never part of PACKAGE.ts or target key material.
 *
 * @category models
 * @since 0.1.0
 */
export interface RemoteCache {
  readonly [TypeId]: typeof TypeId
  readonly endpoint: string
  /**
   * The declared secret holding the bearer token reads authenticate with.
   *
   * A {@link Secret.Secret} rather than a bare variable name, so the remote
   * cache uses the same declaration every other secret-taking target uses. The
   * value is still host state: the declaration names where to read it, and
   * nothing here ever holds it.
   */
  readonly token: Secret.Secret
  /**
   * The declared secret holding the bearer token writes authenticate with,
   * when the declaration splits read and write credentials. Undefined means
   * one token serves both directions.
   */
  readonly write: Secret.Secret | undefined
  /**
   * A public read token committed to the repository, or undefined.
   *
   * The one credential that may appear in PACKAGE.ts as a literal. Smithers Cloud mints
   * it per repository (`smithers cache token create`); it can only read that
   * repository's cache, is refused with 403 on every publication before the
   * body is read, and never authenticates anywhere else, so committing it is
   * the same posture as an Nx read-only access token. Reads use it; writes
   * still read {@link RemoteCache.write} (or {@link RemoteCache.token} when no
   * write secret is declared) from the environment.
   */
  readonly publicReadToken: string | undefined
}

// The prefix every public read token carries; the rest is 40 lowercase hex
// characters. Anything else offered as a literal is refused, so a personal
// token pasted by mistake never lands in a committed file.
const publicReadTokenPrefix = "smithers_cachero_"

const publicReadTokenShape = new RegExp(`^${publicReadTokenPrefix}[0-9a-f]{40}$`)

/**
 * Validates a public read token literal.
 *
 * @category validation
 * @since 0.1.0
 */
export const normalizePublicReadToken = (value: string): string => {
  if (typeof value !== "string") throw new TypeError("remote cache publicReadToken must be a string")
  const trimmed = value.trim()
  if (!publicReadTokenShape.test(trimmed)) {
    throw new Error(
      `remote cache publicReadToken must be a Smithers Cloud public read token (${publicReadTokenPrefix} followed by 40 hex characters); ` +
        "any other credential belongs in the environment, never in PACKAGE.ts"
    )
  }
  return trimmed
}

/**
 * The Smithers Cloud API base a {@link smithersCloud} declaration derives its endpoint from.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultSmithersCloudApiBase = "https://api.jjhub.tech"

/**
 * Options accepted by {@link make}.
 *
 * Two forms: the single-token form (`token`, defaulting to
 * `Secret("SMITHERS_CACHE_TOKEN")`) and the split form (`read` plus an
 * optional `write`). `token` and `read` name the same slot and are exclusive.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly endpoint: string
  /** @default Secret("SMITHERS_CACHE_TOKEN") */
  readonly token?: Secret.Secret | undefined
  /** The read token; an alias of `token` for the split read/write form. */
  readonly read?: Secret.Secret | undefined
  /** The write token of the split form. */
  readonly write?: Secret.Secret | undefined
  /**
   * A committed public read token. Exclusive with `token` and `read`: reads
   * use the literal, and `write` (default `Secret("SMITHERS_CACHE_TOKEN")`)
   * names the publishing credential.
   */
  readonly publicReadToken?: string | undefined
}

/**
 * Options accepted by {@link smithersCloud}.
 *
 * @category models
 * @since 0.1.0
 */
export interface SmithersCloudOptions {
  /** The repository as `owner/name`. */
  readonly repo: string
  /** The committed public read token, when the repository is private or publishes. */
  readonly publicReadToken?: string | undefined
  /** The write credential; defaults to `Secret("SMITHERS_CACHE_TOKEN")`. */
  readonly write?: Secret.Secret | undefined
  /** The Smithers Cloud API base; defaults to {@link defaultSmithersCloudApiBase}. */
  readonly apiBase?: string | undefined
}

const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Validates and normalizes a remote-cache endpoint.
 *
 * @category validation
 * @since 0.1.0
 */
export const normalizeEndpoint = (value: string): string => {
  if (typeof value !== "string") throw new TypeError("remote cache endpoint must be a string")
  if (
    value.length > maximumEndpointBytes ||
    !value.isWellFormed() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) throw new Error("remote cache endpoint must be bounded well-formed text without control characters")
  const trimmed = value.trim()
  if (trimmed === "" || new TextEncoder().encode(trimmed).byteLength > maximumEndpointBytes) {
    throw new Error("remote cache endpoint must be a bounded absolute HTTPS URL")
  }
  let endpoint: URL
  try {
    endpoint = new URL(trimmed)
  } catch {
    // Never echo the input: a mistyped endpoint may carry userinfo or a token.
    throw new Error("remote cache endpoint must be an absolute HTTPS URL")
  }
  // Credentials are rejected before the protocol so an http:// mistake with
  // userinfo names the credential problem first.
  if (endpoint.username !== "" || endpoint.password !== "") {
    throw new Error("remote cache endpoint must not contain credentials")
  }
  if (endpoint.protocol !== "https:") {
    throw new Error("remote cache endpoint must use HTTPS")
  }
  if (endpoint.search !== "" || endpoint.hash !== "") {
    throw new Error("remote cache endpoint must not contain a query or fragment")
  }
  return endpoint.href.replace(/\/+$/, "")
}

/**
 * Validates one bearer-token environment variable name.
 *
 * @category validation
 * @since 0.1.0
 */
export const normalizeTokenEnv = (value: string): string => {
  if (typeof value !== "string") throw new TypeError("remote cache tokenEnv must be a string")
  if (
    value.length > maximumTokenEnvironmentLength ||
    !value.isWellFormed() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) throw new Error("remote cache tokenEnv must be bounded well-formed text")
  const trimmed = value.trim()
  if (!environmentName.test(trimmed)) {
    throw new Error(`remote cache tokenEnv must be an environment variable name: ${value}`)
  }
  if (trimmed === "SMITHERS_CACHE_URL") {
    throw new Error("remote cache tokenEnv must not be SMITHERS_CACHE_URL")
  }
  return trimmed
}

/**
 * Creates a pure remote-cache declaration.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options): RemoteCache => {
  if (
    typeof options !== "object" || options === null || NodeUtil.isProxy(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
  ) throw new TypeError("RemoteCache options must be a plain object")
  if (Object.getOwnPropertySymbols(options).length > 0) {
    throw new TypeError("RemoteCache options must not contain symbol properties")
  }
  const names = Object.getOwnPropertyNames(options)
  for (const name of names) {
    if (name !== "endpoint" && name !== "token" && name !== "read" && name !== "write" && name !== "publicReadToken") {
      throw new TypeError(`RemoteCache received unknown option ${JSON.stringify(name)}`)
    }
  }
  const own = (name: "endpoint" | "token" | "read" | "write" | "publicReadToken"): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(options, name)
    if (descriptor === undefined) return undefined
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`RemoteCache option ${name} must be an enumerable data property`)
    }
    return descriptor.value
  }
  const endpoint = own("endpoint")
  const token = own("token")
  const read = own("read")
  const write = own("write")
  const publicReadToken = own("publicReadToken")
  if (typeof endpoint !== "string") throw new TypeError("RemoteCache option endpoint must be a string")
  if (token !== undefined && read !== undefined) {
    throw new TypeError("RemoteCache options token and read name the same slot; declare one, not both")
  }
  if (publicReadToken !== undefined && (token !== undefined || read !== undefined)) {
    throw new TypeError("RemoteCache option publicReadToken replaces token and read; declare one form, not both")
  }
  if (publicReadToken !== undefined && typeof publicReadToken !== "string") {
    throw new TypeError("RemoteCache option publicReadToken must be a string")
  }
  for (const [name, value] of [["token", token], ["read", read], ["write", write]] as const) {
    if (value !== undefined && !Secret.isSecret(value)) {
      throw new TypeError(`RemoteCache option ${name} must be a Secret declaration`)
    }
  }
  const declared = (token ?? read ?? Secret.Secret(defaultTokenEnv)) as Secret.Secret
  return Object.freeze<RemoteCache>({
    [TypeId]: TypeId,
    endpoint: normalizeEndpoint(endpoint),
    // The endpoint override variable is reserved: a token read from it would
    // make one variable mean two things.
    token: Secret.Secret(normalizeTokenEnv(declared.env)),
    write: write === undefined ? undefined : Secret.Secret(normalizeTokenEnv((write as Secret.Secret).env)),
    publicReadToken: publicReadToken === undefined ? undefined : normalizePublicReadToken(publicReadToken)
  })
}

const repositoryShape = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Creates the declaration for a repository's Smithers Cloud-hosted cache.
 *
 * The endpoint is derived from the API base and the repository, so the only
 * thing a workspace commits is the repository name and, optionally, its
 * public read token. `smthrs cache connect` writes exactly this line.
 *
 * @category constructors
 * @since 0.1.0
 */
export const smithersCloud = (options: SmithersCloudOptions): RemoteCache => {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("RemoteCache.smithersCloud options must be an object")
  }
  for (const name of Object.getOwnPropertyNames(options)) {
    if (name !== "repo" && name !== "publicReadToken" && name !== "write" && name !== "apiBase") {
      throw new TypeError(`RemoteCache.smithersCloud received unknown option ${JSON.stringify(name)}`)
    }
  }
  if (typeof options.repo !== "string" || !repositoryShape.test(options.repo.trim())) {
    throw new Error("RemoteCache.smithersCloud repo must be owner/name")
  }
  const [owner, name] = options.repo.trim().split("/") as [string, string]
  const base = normalizeEndpoint(options.apiBase ?? defaultSmithersCloudApiBase)
  return make({
    endpoint: `${base}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/build-cache`,
    ...(options.publicReadToken === undefined ? {} : { publicReadToken: options.publicReadToken }),
    ...(options.write === undefined ? {} : { write: options.write })
  })
}

/**
 * Checks whether a PACKAGE.ts export is a remote-cache declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isRemoteCache = (value: unknown): value is RemoteCache => {
  if (typeof value !== "object" || value === null || NodeUtil.isProxy(value)) return false
  const own = (key: PropertyKey): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
  }
  const publicReadToken = own("publicReadToken")
  return own(TypeId) === TypeId &&
    typeof own("endpoint") === "string" &&
    Secret.isSecret(own("token")) &&
    (own("write") === undefined || Secret.isSecret(own("write"))) &&
    (publicReadToken === undefined ||
      (typeof publicReadToken === "string" && publicReadTokenShape.test(publicReadToken)))
}
