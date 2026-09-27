/**
 * Declared secrets for PACKAGE.ts targets.
 *
 * A secret declaration names the environment variable a value is read from. It
 * is inert: `Secret("SMITHERS_CACHE_TOKEN")` performs no read, so PACKAGE.ts
 * evaluation stays pure and a PACKAGE.ts file never contains a credential.
 *
 * The source declaration is still not authority to send the value. A child
 * target must wrap it in {@link HttpSecret}, binding it to exact HTTP origins.
 * It then receives an unguessable placeholder, minted per run, and the proxy
 * resolves that placeholder only while constructing a request for one of
 * those origins. A tool therefore holds a token-shaped string that is
 * worthless anywhere except through the scoped proxy.
 *
 * Three properties follow, and each is the reason for one design choice.
 *
 * - **Explicit dependency and audience.** A target reaches a secret only by
 *   declaring a destination-bound credential in attrs. Placeholders are minted
 *   per run and handed only to that target. A guessed placeholder or a request
 *   for another origin cannot resolve it.
 * - **No value in key material.** The declaration carries a variable name.
 *   Keys record the name; they never record the value, and a cache entry
 *   therefore cannot carry a credential between machines.
 * - **Lazy, request-scoped resolution.** The host variable is read once when
 *   an authorized request needs it, not when PACKAGE.ts is evaluated or planned.
 *   Exact values echoed by the upstream are replaced before the response is
 *   returned to the job.
 *
 * This replaces the previous model, where a target hardcoded an environment
 * variable name and the exec runner deleted it from every child's environment.
 * Withholding is a blunt instrument: it makes a secret unusable rather than
 * usable safely, which is why the remote cache had to reach around it.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as NodeUtil from "node:util/types"

/**
 * Maximum length of a declared environment-variable name.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumNameLength = 256

/**
 * Maximum number of exact HTTP origins one credential may target.
 * @category constants
 * @since 0.1.0
 */
export const maximumAudiences = 32

/**
 * Maximum UTF-16 length of one normalized HTTP origin.
 * @category constants
 * @since 0.1.0
 */
export const maximumAudienceLength = 2_048

/**
 * Maximum length of a public fallback carried in a declaration.
 * @category constants
 * @since 0.1.0
 */
export const maximumFallbackLength = 16 * 1024

const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/
const wellFormedText = Schema.makeFilter((value: string) => value.isWellFormed(), { title: "wellFormedText" })

/**
 * Schema for one inert secret source.
 *
 * The declaration is the variable name and nothing else. A placeholder is not
 * part of it: placeholders are minted per run by the executor, so two runs of
 * the same graph never reuse one and a declaration can be cached without ever
 * pinning a substitution token.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Declaration = Schema.TaggedStruct("Secret", {
  /** The environment variable the value is read from at execution time. */
  env: Schema.NonEmptyString.check(
    Schema.isMaxLength(maximumNameLength),
    Schema.isPattern(environmentName),
    wellFormedText
  ),
  /** Public fallback used only when the environment variable is absent. */
  fallback: Schema.optional(Schema.NonEmptyString.check(Schema.isMaxLength(maximumFallbackLength), wellFormedText))
})

/**
 * One declared secret.
 *
 * @category models
 * @since 0.1.0
 */
export type Secret = typeof Declaration.Type

const ownData = (value: object, name: PropertyKey): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  return descriptor !== undefined && "value" in descriptor && descriptor.enumerable ? descriptor.value : undefined
}

/**
 * Declares one secret source, read lazily at a host-owned request boundary.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const cacheToken = Smithers.Secret("SMITHERS_CACHE_TOKEN")
 * export const github = Smithers.HttpSecret(
 *   Smithers.Secret("GITHUB_TOKEN"),
 *   ["https://api.github.com"]
 * )
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const Secret = (env: string, options: { readonly fallback?: string | undefined } = {}): Secret => {
  if (typeof env !== "string") throw new TypeError("Secret name must be a string")
  if (env.length > maximumNameLength || !env.isWellFormed()) {
    throw new Error("Secret name must be bounded well-formed text")
  }
  const trimmed = env.trim()
  if (!environmentName.test(trimmed)) {
    throw new Error(`Secret name must be an environment variable name: ${JSON.stringify(env)}`)
  }
  if (
    typeof options !== "object" || options === null || NodeUtil.isProxy(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
  ) throw new TypeError("Secret options must be a plain object")
  if (Object.getOwnPropertySymbols(options).length > 0) {
    throw new TypeError("Secret options must not contain symbol properties")
  }
  for (const key of Object.getOwnPropertyNames(options)) {
    if (key !== "fallback") throw new TypeError(`Secret received unknown option ${JSON.stringify(key)}`)
  }
  const fallbackDescriptor = Object.getOwnPropertyDescriptor(options, "fallback")
  if (
    fallbackDescriptor !== undefined &&
    (!("value" in fallbackDescriptor) || fallbackDescriptor.enumerable !== true)
  ) throw new TypeError("Secret option fallback must be an enumerable data property")
  const fallback = fallbackDescriptor !== undefined && "value" in fallbackDescriptor
    ? fallbackDescriptor.value
    : undefined
  if (
    fallback !== undefined &&
    (typeof fallback !== "string" || fallback === "" || fallback.length > maximumFallbackLength ||
      !fallback.isWellFormed())
  ) {
    throw new TypeError("Secret fallback must be bounded non-empty well-formed text")
  }
  return Object.freeze(Declaration.make({ env: trimmed, ...(fallback === undefined ? {} : { fallback }) }))
}

/**
 * Checks whether a value is a declared secret.
 *
 * @category guards
 * @since 0.1.0
 */
export const isSecret = (value: unknown): value is Secret => {
  if (typeof value !== "object" || value === null || NodeUtil.isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const keys = Reflect.ownKeys(value)
  if (
    keys.some((key) => typeof key !== "string" || !["_tag", "env", "fallback"].includes(key)) ||
    !keys.includes("_tag") || !keys.includes("env")
  ) return false
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) return false
  }
  const own = (name: "_tag" | "env" | "fallback"): unknown => {
    return ownData(value, name)
  }
  const tag = own("_tag")
  const env = own("env")
  const fallback = own("fallback")
  return tag === "Secret" && typeof env === "string" && env.length <= maximumNameLength &&
    env.isWellFormed() && environmentName.test(env) &&
    (fallback === undefined || typeof fallback === "string" && fallback !== "" &&
        fallback.length <= maximumFallbackLength && fallback.isWellFormed())
}

const loopbackHost = (hostname: string): boolean =>
  hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]"

/**
 * Normalizes an exact HTTP origin accepted as a credential audience.
 *
 * Public credentials require TLS. Plain HTTP is accepted only on loopback,
 * where the request remains inside the host boundary.
 *
 * @category parsing
 * @since 0.1.0
 */
export const normalizeAudience = (input: string): string => {
  if (typeof input !== "string" || input === "" || input.length > maximumAudienceLength || !input.isWellFormed()) {
    throw new TypeError("secret audience must be bounded well-formed text")
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    // Never echo the input: a mistyped audience may carry userinfo or a token.
    throw new TypeError("secret audience must be an exact HTTP origin")
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "" ||
    url.pathname !== "/" || url.search !== "" || url.hash !== "" ||
    (url.protocol === "http:" && !loopbackHost(url.hostname))
  ) {
    throw new TypeError("secret audience must be an exact HTTPS or loopback HTTP origin")
  }
  return url.origin
}

const normalizedAudience = (value: string): boolean => {
  try {
    return normalizeAudience(value) === value
  } catch {
    return false
  }
}

/**
 * Exact normalized HTTP origin to which a credential may be sent.
 * @category schemas
 * @since 0.1.0
 */
export const Audience = Schema.NonEmptyString.check(
  Schema.isMaxLength(maximumAudienceLength),
  Schema.makeFilter(normalizedAudience, { title: "normalizedSecretAudience" })
)

/**
 * A secret source bound to the exact HTTP origins allowed to receive it.
 *
 * The binding, not the source declaration, belongs in an exec target's
 * `secrets` attr. Keeping the two concepts separate lets a host-owned adapter
 * bind one source to the public endpoint it already controls without making
 * that endpoint part of the source declaration.
 *
 * @category schemas
 * @since 0.1.0
 */
export const HttpCredential = Schema.TaggedStruct("HttpCredential", {
  secret: Declaration,
  audiences: Schema.NonEmptyArray(Audience).check(Schema.isMaxLength(maximumAudiences))
})

/**
 * A destination-bound HTTP credential declaration.
 * @category models
 * @since 0.1.0
 */
export type HttpCredential = typeof HttpCredential.Type

/**
 * Binds a declared secret to one or more exact HTTP origins.
 *
 * @category constructors
 * @since 0.1.0
 */
export const HttpSecret = (secret: Secret, audiences: ReadonlyArray<string>): HttpCredential => {
  if (!isSecret(secret)) throw new TypeError("HttpSecret requires a secret declaration")
  if (
    !Array.isArray(audiences) || NodeUtil.isProxy(audiences) || Object.getPrototypeOf(audiences) !== Array.prototype ||
    audiences.length === 0 || audiences.length > maximumAudiences
  ) throw new TypeError(`HttpSecret requires between 1 and ${maximumAudiences} audiences`)
  const keys = Reflect.ownKeys(audiences)
  if (keys.length !== audiences.length + 1 || !keys.includes("length") || keys.some((key) => typeof key !== "string")) {
    throw new TypeError("HttpSecret audiences must be a dense array without extra properties")
  }
  const normalized: Array<string> = []
  for (let index = 0; index < audiences.length; index += 1) {
    const value = ownData(audiences, String(index))
    if (typeof value !== "string") throw new TypeError("HttpSecret audiences must contain only text data")
    normalized.push(normalizeAudience(value))
  }
  if (new Set(normalized).size !== normalized.length) throw new TypeError("HttpSecret audiences contain a duplicate")
  const source = Secret(secret.env, secret.fallback === undefined ? {} : { fallback: secret.fallback })
  const binding = HttpCredential.make({ secret: source, audiences: normalized as [string, ...Array<string>] })
  Object.freeze(binding.audiences)
  return Object.freeze(binding)
}

/**
 * Checks whether a value is a valid destination-bound HTTP credential.
 * @category guards
 * @since 0.1.0
 */
export const isHttpCredential = (value: unknown): value is HttpCredential => {
  if (typeof value !== "object" || value === null || NodeUtil.isProxy(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    const keys = Reflect.ownKeys(value)
    if (
      keys.length !== 3 || keys.some((key) => typeof key !== "string" || !["_tag", "secret", "audiences"].includes(key))
    ) return false
    if (ownData(value, "_tag") !== "HttpCredential" || !isSecret(ownData(value, "secret"))) return false
    const audiences = ownData(value, "audiences")
    if (
      !Array.isArray(audiences) || NodeUtil.isProxy(audiences) ||
      Object.getPrototypeOf(audiences) !== Array.prototype ||
      audiences.length === 0 || audiences.length > maximumAudiences
    ) return false
    const audienceKeys = Reflect.ownKeys(audiences)
    if (
      audienceKeys.length !== audiences.length + 1 || !audienceKeys.includes("length") ||
      audienceKeys.some((key) => typeof key !== "string")
    ) return false
    const seen = new Set<string>()
    for (let index = 0; index < audiences.length; index += 1) {
      const audience = ownData(audiences, String(index))
      if (typeof audience !== "string" || !normalizedAudience(audience) || seen.has(audience)) return false
      seen.add(audience)
    }
    return true
  } catch {
    return false
  }
}

/**
 * The fixed prefix every minted placeholder carries.
 *
 * The prefix exists so a placeholder that escapes into a log is recognisable
 * as a placeholder rather than mistaken for a leaked credential, and so the
 * substituting proxy can cheaply skip requests that contain no placeholder at
 * all.
 *
 * @category constants
 * @since 0.1.0
 */
export const placeholderPrefix = "smithers-build-secret-"

/**
 * Number of random bytes in a minted placeholder.
 *
 * A placeholder is an unguessable capability: holding one is what entitles a
 * request to substitution. 32 bytes puts guessing beyond reach for the
 * lifetime of a run.
 *
 * @category constants
 * @since 0.1.0
 */
export const placeholderBytes = 32

/**
 * Matches any minted placeholder.
 *
 * @category constants
 * @since 0.1.0
 */
export const placeholderPattern = new RegExp(`${placeholderPrefix}[0-9a-f]{${placeholderBytes * 2}}`, "g")

/**
 * Matches a brokered-origin token and captures the origin it names.
 *
 * @category constants
 * @since 0.1.0
 */
export const secretOriginPattern = /\{smthrs:secret-origin:([^{}\s]+)\}/g

/**
 * Names a declared HTTPS audience as a loopback origin the child can call.
 *
 * The proxy cannot see inside an HTTPS tunnel, so a placeholder sent through
 * `CONNECT` would reach the destination unresolved. This token instead
 * resolves, at spawn time, to a loopback `http://127.0.0.1:<port>` origin that
 * forwards every request to the audience over TLS and substitutes authorized
 * placeholders on the way. The tool needs no certificate and no proxy
 * support: the loopback origin is its destination.
 *
 * The token is a plan-time literal, so the ephemeral port never enters key
 * material or the recorded plan. A target must also declare an
 * {@link HttpSecret} bound to the same origin.
 *
 * @example
 * ```ts
 * import { Smithers as S } from "@smthrs/targets"
 *
 * export const whoami = S.Shell.Run({
 *   command: "curl -fsS -H \"authorization: token $GITHUB_TOKEN\" \"$GITHUB_API/user\"",
 *   env: { GITHUB_API: S.SecretOrigin("https://api.github.com") },
 *   secrets: [S.HttpSecret(S.Secret("GITHUB_TOKEN"), ["https://api.github.com"])]
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const SecretOrigin = (audience: string): string => `{smthrs:secret-origin:${normalizeAudience(audience)}}`

/**
 * Lists the origins named by brokered-origin tokens in one string, in order.
 *
 * The captured text is returned as written. A caller checks it against the
 * declared audiences, so a hand-written token that is not a normalized origin
 * never matches one.
 *
 * @category parsing
 * @since 0.1.0
 */
export const secretOriginsIn = (text: string): ReadonlyArray<string> =>
  Array.from(text.matchAll(secretOriginPattern), (match) => match[1]!)
