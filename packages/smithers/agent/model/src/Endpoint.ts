/**
 * The credential-free HTTP target of a model route, and its validation.
 * An endpoint is public data: it is part of a sealed step's key material, so
 * nothing secret may appear in it.
 *
 * @since 0.1.0
 */

import * as Result from "effect/Result"
import { isCredentialName } from "./Auth.ts"
import { ModelError } from "./ModelError.ts"

/**
 * The public, credential-free HTTP target of a model route.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Endpoint {
  readonly method: "POST"
  readonly url: string
  readonly query: ReadonlyArray<readonly [string, string]>
}

/**
 * Input used to construct a deterministic route endpoint.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface MakeOptions {
  readonly url: string
  readonly path?: string
  readonly query?: ReadonlyArray<readonly [string, string]> | Readonly<Record<string, string>>
}

const invalid = (message: string): ModelError => new ModelError({ code: "invalid_request", message })

const hasCredentialQueryKey = (name: string): boolean => isCredentialName(name) || /^(key|sig)$/i.test(name)

const collectQuery = (input: MakeOptions["query"]): Array<readonly [string, string]> =>
  input === undefined
    ? []
    : Array.isArray(input)
    ? input.map(([name, value]) => [name, value] as const)
    : Object.entries(input)

// The URL parser resolves `%2e` to `.` while it normalizes a pathname, so
// `%2e%2e` and `.%2e` are traversals wearing a disguise: comparing raw
// segments lets them through and the assignment below then collapses them.
const isRelativeSegment = (segment: string): boolean => {
  const decoded = segment.replace(/%2e/gi, ".")
  return decoded === "." || decoded === ".."
}

const joinPath = (url: URL, path: string | undefined): Result.Result<void, ModelError> => {
  if (path === undefined || path === "") return Result.succeed(undefined)
  if (path.includes("?") || path.includes("#")) {
    return Result.fail(invalid("Endpoint paths must not contain query strings or fragments"))
  }
  if (path.split("/").some(isRelativeSegment)) {
    return Result.fail(invalid("Endpoint paths must not contain relative segments"))
  }
  const base = url.pathname.replace(/\/+$/, "")
  url.pathname = `${base}/${path.replace(/^\/+/, "")}`
  // Belt and braces: whatever the parser did with the joined path, the result
  // has to still extend the base rather than climb out of it.
  if (!url.pathname.startsWith(base === "" ? "/" : `${base}/`)) {
    return Result.fail(invalid("Endpoint paths must not contain relative segments"))
  }
  return Result.succeed(undefined)
}

/**
 * Constructs a validated POST endpoint. Query pairs are sorted so both the
 * wire target and the sealed request view remain deterministic.
 *
 * Embedded URL credentials and credential-looking query parameters are
 * rejected because endpoint values are public route identity.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const make = (input: MakeOptions): Result.Result<Endpoint, ModelError> =>
  Result.gen(function*() {
    const url = yield* Result.try({
      try: () => new URL(input.url),
      catch: () => invalid("Endpoint URL could not be parsed")
    })

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return yield* Result.fail(invalid("Endpoint URLs must use http or https"))
    }
    if (url.username !== "" || url.password !== "") {
      return yield* Result.fail(invalid("Endpoint URLs must not embed credentials"))
    }
    if (url.hash !== "") {
      return yield* Result.fail(invalid("Endpoint URLs must not contain fragments"))
    }

    const query: Array<readonly [string, string]> = [...url.searchParams.entries(), ...collectQuery(input.query)]
    for (const [name] of query) {
      if (hasCredentialQueryKey(name)) {
        return yield* Result.fail(invalid(`Endpoint query parameter ${name} must not carry credentials`))
      }
    }
    query.sort(([leftName, leftValue], [rightName, rightValue]) => {
      if (leftName < rightName) return -1
      if (leftName > rightName) return 1
      if (leftValue < rightValue) return -1
      if (leftValue > rightValue) return 1
      return 0
    })

    url.search = ""
    yield* joinPath(url, input.path)
    return { method: "POST", url: url.toString(), query }
  })

/**
 * Renders an endpoint to the exact deterministic HTTP URL.
 *
 * @since 0.1.0
 * @category formatting
 * @slop
 */
export const render = (endpoint: Endpoint): string => {
  const url = new URL(endpoint.url)
  const query = new URLSearchParams()
  for (const [name, value] of endpoint.query) query.append(name, value)
  url.search = query.toString()
  return url.toString()
}

/**
 * The origin of every provider a Smithers Cloud model proxy can front.
 * OpenRouter's origin carries its `/api` prefix, so the proxy segment replaces
 * `https://openrouter.ai/api` whole.
 *
 * @since 1.0.0-rc.1
 * @category constants
 */
export const providerOrigins = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  cerebras: "https://api.cerebras.ai",
  openrouter: "https://openrouter.ai/api",
  vercel: "https://ai-gateway.vercel.sh",
  /** The ChatGPT-subscription backend (`OpenAIChatGPT.defaultBaseUrl`). */
  chatgpt: "https://chatgpt.com/backend-api"
} as const

/**
 * A provider {@link providerOrigins} names.
 *
 * @since 1.0.0-rc.1
 * @category models
 */
export type ProxiedProvider = keyof typeof providerOrigins

/**
 * The variable naming a metered model proxy, such as Smithers Cloud's
 * `{base}/api/model`.
 *
 * @since 1.0.0-rc.1
 * @category constants
 */
export const modelProxyVariable = "SMITHERS_MODEL_PROXY_URL"

/**
 * The variable limiting {@link modelProxyVariable} to the comma-separated
 * providers it serves, such as `anthropic,vercel`. Unset, the proxy serves
 * every provider; set, a provider it omits keeps its own origin, so a key the
 * guest holds for that provider never reaches the proxy.
 *
 * @since 1.0.0-rc.1
 * @category constants
 */
export const modelProxyProvidersVariable = "SMITHERS_MODEL_PROXY_PROVIDERS"

/**
 * The metered proxy's origin for `provider`, or `undefined` when no proxy is
 * set or {@link modelProxyProvidersVariable} leaves `provider` out.
 *
 * @since 1.0.0-rc.1
 * @category getters
 */
export const proxyOrigin = (
  provider: string,
  environment: Readonly<Record<string, string | undefined>>
): string | undefined => {
  const proxy = environment[modelProxyVariable]
  if (proxy === undefined || proxy === "") return undefined
  const providers = environment[modelProxyProvidersVariable]
  if (providers !== undefined && !providers.split(",").map((item) => item.trim()).includes(provider)) return undefined
  return `${proxy.replace(/\/+$/, "")}/${provider}`
}

/**
 * The origin a request to `provider` goes to: the metered proxy's
 * ({@link proxyOrigin}) when it serves `provider`, otherwise the provider's
 * own origin.
 *
 * @since 1.0.0-rc.1
 * @category getters
 */
export const providerOrigin = (
  provider: ProxiedProvider,
  environment: Readonly<Record<string, string | undefined>>
): string => proxyOrigin(provider, environment) ?? providerOrigins[provider]
