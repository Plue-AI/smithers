/**
 * The GitHub REST client.
 *
 * Three behaviors are the reason this exists rather than a bare `fetch`:
 *
 * - **Rate limits.** GitHub signals them as a 429 *and* as a 403 whose
 *   `x-ratelimit-remaining` is `0` or whose body mentions the secondary or
 *   abuse limit. All three are retried for every method, because a rejected
 *   request was not performed, waiting the server's `Retry-After` or
 *   `x-ratelimit-reset`, capped so a skewed clock cannot park a call for hours.
 *   A 5xx or a transport failure is retried only for a read: on a POST, PATCH,
 *   PUT, or DELETE the outcome is unknown, so the client reports
 *   `outcomeUnknown` rather than posting the comment twice. A caller that
 *   knows its endpoint is idempotent opts in with `retryUnsafeWrites`.
 * - **Pagination.** `paginate` follows RFC 5988 `Link: rel="next"` within a
 *   declared page budget and says when it ran out.
 * - **Token hygiene.** The token reaches the `Authorization` header and
 *   nothing else, not a message, not `details`, not a log line, and every
 *   request URL, including a `rel="next"` target, is pinned to the configured
 *   API origin so a redirected link cannot carry the token elsewhere. Errors
 *   redact echoed credentials from summaries, details, and cause messages. The
 *   origin pin is not a path pin: a caller that builds a path from provider
 *   data uses `Repository.repositoryPath`, which validates each segment,
 *   because `new URL` resolves `..` inside a path.
 *
 * Interruption is forwarded to `fetch`, so interrupting the fiber aborts the
 * request in flight rather than leaving it running. Every attempt also carries
 * its own deadline, `requestTimeout`, spanning the response headers and the
 * body read: the retry budget counts completed attempts, so without a deadline
 * a peer that answers and then trickles the body forever holds the call open.
 *
 * @since 1.0.0
 */

import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { IntegrationError, isIntegrationError, isRetryable } from "../core/IntegrationError.ts"
import { redactedError } from "../core/RedactedError.ts"
import * as Environment from "../Environment.ts"
import { type GitHubConfig, resolve } from "./Config.ts"

// Upper bound on an honored Retry-After / x-ratelimit-reset, so a hostile or
// clock-skewed header cannot park a call for hours.
const MAX_RETRY_AFTER_MS = 60_000

/**
 * The largest `per_page` GitHub accepts.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_PER_PAGE = 100

/**
 * The default page budget {@link GitHubClient.paginate} spends, and the
 * largest one it accepts.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_MAX_PAGES = 10

/**
 * The largest page budget {@link GitHubClient.paginate} accepts.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_PAGES_LIMIT = 1000

/**
 * The REST verbs this client issues.
 *
 * @category models
 * @since 1.0.0
 */
export type RequestMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE"

/**
 * The verbs whose effect the server may already have applied when the answer
 * is lost.
 *
 * A 5xx or a dropped connection on one of these does not say whether the
 * write happened, so the client does not repeat it: see
 * {@link RequestOptions.retryUnsafeWrites}.
 *
 * @category constants
 * @since 1.0.0
 */
export const UNSAFE_METHODS: ReadonlyArray<RequestMethod> = ["POST", "PATCH", "PUT", "DELETE"]

/**
 * Per-request options for a call whose response the client does not check.
 *
 * @category models
 * @since 1.0.0
 */
export interface RequestOptions {
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>> | undefined
  /**
   * Repeat a POST, PATCH, PUT, or DELETE whose outcome is unknown.
   *
   * Off by default. A 5xx or a transport failure on a write is the classic
   * ambiguous case: GitHub may have committed it and lost the answer, so
   * repeating posts a second comment or creates a second hook. Only a caller
   * that knows the endpoint is idempotent should turn this on. Rate limits are
   * retried for every method regardless, because a rejected request was not
   * performed.
   */
  readonly retryUnsafeWrites?: boolean | undefined
}

/**
 * Per-request options that decode the response.
 *
 * The schema is required, and the request's result type is the schema's type:
 * a caller cannot name a response type the client never checked.
 *
 * @category models
 * @since 1.0.0
 */
export interface DecodedRequestOptions<A> extends RequestOptions {
  /** Decodes the response body, failing `decode-failed` when it does not fit. */
  readonly schema: Schema.Schema<A>
}

/**
 * One `paginate` walk's result.
 *
 * @category models
 * @since 1.0.0
 */
export interface Page {
  readonly items: ReadonlyArray<unknown>
  /**
   * True when the page budget ran out with a `rel="next"` link still
   * outstanding, so `items` is a prefix of the resource rather than all of it.
   */
  readonly truncated: boolean
}

/**
 * The client service.
 *
 * @category services
 * @since 1.0.0
 */
export interface GitHubClient {
  /**
   * One REST call.
   *
   * Without a schema the result is the parsed JSON as `unknown`: nothing was
   * validated, so nothing is promised. Passing a
   * {@link DecodedRequestOptions.schema} is the only way to name the response
   * type, and the decode failing is reported as `decode-failed`.
   */
  readonly request: {
    <A>(
      method: RequestMethod,
      path: string,
      body: unknown,
      options: DecodedRequestOptions<A>
    ): Effect.Effect<A, IntegrationError>
    (
      method: RequestMethod,
      path: string,
      body?: unknown,
      options?: RequestOptions
    ): Effect.Effect<unknown, IntegrationError>
  }
  /**
   * Follows `Link: rel="next"` and concatenates the pages.
   *
   * The walk is bounded: `perPage` defaults to {@link MAX_PER_PAGE} and
   * `maxPages` to {@link DEFAULT_MAX_PAGES}, so the default ceiling is a
   * thousand items. Hitting the ceiling is reported as `truncated`, never as a
   * short but complete answer, because a caller that reconciles against a
   * truncated list plans work for resources it simply did not see.
   */
  readonly paginate: (
    path: string,
    options?: { readonly perPage?: number | undefined; readonly maxPages?: number | undefined }
  ) => Effect.Effect<Page, IntegrationError>
}

/**
 * Service tag for the GitHub REST client.
 *
 * @category services
 * @since 1.0.0
 */
export const GitHubClient: Context.Service<GitHubClient, GitHubClient> = Context.Service(
  "@smthrs/integrations/GitHubClient"
)

/**
 * Whether a response is GitHub telling us to slow down.
 *
 * A 403 counts when the remaining budget is exhausted or the body names the
 * rate or abuse limit, which is how GitHub reports a secondary limit.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isRateLimitResponse = (status: number, headers: Headers, body: unknown): boolean => {
  if (status === 429) return true
  if (status !== 403) return false
  if (headers.get("x-ratelimit-remaining") === "0") return true
  const message = typeof body === "object" && body !== null && "message" in body &&
      typeof (body as { message?: unknown }).message === "string"
    ? (body as { message: string }).message.toLowerCase()
    : ""
  return message.includes("rate limit") || message.includes("abuse")
}

/**
 * How long to wait before retrying, from `Retry-After` (seconds) or
 * `x-ratelimit-reset` (epoch seconds), capped at one minute.
 *
 * @category getters
 * @since 1.0.0
 */
export const retryAfterMs = (headers: Headers, nowMs: number = Date.now()): number | null => {
  const retryAfter = headers.get("retry-after")
  if (retryAfter !== null) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
  }
  const reset = headers.get("x-ratelimit-reset")
  if (reset !== null) {
    const resetMs = Number(reset) * 1000 - nowMs
    if (Number.isFinite(resetMs) && resetMs > 0) return Math.min(resetMs, MAX_RETRY_AFTER_MS)
  }
  return null
}

/**
 * The `rel="next"` URL in an RFC 5988 `Link` header, or `null`.
 *
 * @category getters
 * @since 1.0.0
 */
export const nextPageUrl = (linkHeader: string | null): string | null => {
  if (linkHeader === null || linkHeader.length === 0) return null
  for (const part of linkHeader.split(",")) {
    const match = /^<([^>]+)>;\s*rel="next"$/.exec(part.trim())
    if (match !== null) return match[1] ?? null
  }
  return null
}

/**
 * A caller-supplied bound, or a typed `invalid-config` failure.
 *
 * `Infinity` as a page budget is an unbounded walk against a paid API, and a
 * fractional one silently truncates, so both are refused before the first
 * request rather than producing a strange result.
 */
const bounded = (
  name: string,
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): Effect.Effect<number, IntegrationError> => {
  if (value === undefined) return Effect.succeed(fallback)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return Effect.fail(
      new IntegrationError(
        "invalid-config",
        `GitHub ${name} must be an integer between ${min} and ${max}.`,
        { [name]: value, retryable: false }
      )
    )
  }
  return Effect.succeed(value)
}

// Span attributes for a failed attempt: the classification, never the body.
const failureAttributes = (error: IntegrationError) =>
  Effect.annotateCurrentSpan({
    "integration.reason": error.reason,
    "http.response.status_code": error.details?.["status"] ?? null,
    "integration.retryable": error.details?.["retryable"] === true,
    "integration.rate_limited": error.details?.["rateLimited"] === true,
    "integration.outcome_unknown": error.details?.["outcomeUnknown"] === true
  })

/**
 * Builds a REST client bound to `config`.
 *
 * `env` is the fallback source for anything `config` omits. Passing one
 * replaces the ambient environment rather than layering over it, so a caller
 * that supplies its own credentials cannot be surprised by an ambient
 * `GITHUB_TOKEN` deciding which account a call runs as.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  config: GitHubConfig = {},
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): GitHubClient => {
  const resolved = resolve(config, env)
  const integrationError = redactedError([
    resolved.token,
    resolved.token === undefined ? undefined : `Bearer ${resolved.token}`
  ])
  const baseUrl = resolved.apiBaseUrl.replace(/\/+$/, "")
  if (!URL.canParse(baseUrl)) {
    throw integrationError(
      "invalid-config",
      "GitHub apiBaseUrl must be a valid HTTP or HTTPS URL.",
      { apiBaseUrl: resolved.apiBaseUrl, retryable: false }
    )
  }
  const parsedBaseUrl = new URL(baseUrl)
  if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
    throw integrationError(
      "invalid-config",
      "GitHub apiBaseUrl must be a valid HTTP or HTTPS URL.",
      { apiBaseUrl: resolved.apiBaseUrl, retryable: false }
    )
  }
  const apiOrigin = parsedBaseUrl.origin
  if (!Number.isSafeInteger(resolved.maxRetries) || resolved.maxRetries < 0 || resolved.maxRetries > 10) {
    throw integrationError(
      "invalid-config",
      "GitHub maxRetries must be an integer between 0 and 10.",
      { maxRetries: resolved.maxRetries, retryable: false }
    )
  }
  // A zero or infinite deadline is not a deadline: the first would fail every
  // request and the second is the unbounded wait this option exists to close.
  const requestTimeout = Option.getOrUndefined(Duration.fromInput(resolved.requestTimeout))
  if (
    requestTimeout === undefined || !Duration.isFinite(requestTimeout) || Duration.toMillis(requestTimeout) <= 0
  ) {
    throw integrationError(
      "invalid-config",
      "GitHub requestTimeout must be a finite, positive duration.",
      { requestTimeout: String(resolved.requestTimeout), retryable: false }
    )
  }
  const requestTimeoutMs = Duration.toMillis(requestTimeout)

  // Every request carries the bearer token, so an absolute request URL and a
  // `rel="next"` target must stay on the configured API origin. A foreign
  // destination would receive the token.
  const assertApiOrigin = (url: string): void => {
    const parsed = new URL(url)
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== apiOrigin) {
      throw integrationError(
        "delivery-failed",
        `GitHub request refused: ${parsed.origin} is not the configured GitHub API origin.`,
        { origin: parsed.origin, apiOrigin, retryable: false }
      )
    }
  }

  // `new URL` throws a bare TypeError for anything starting with "http" that
  // is not a URL (`httpx`, say). That throw runs before the request effect, so
  // it would escape the declared IntegrationError channel as a defect.
  const buildUrl = (path: string, query?: RequestOptions["query"]): string => {
    const absolute = path.startsWith("http") ? path : `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`
    if (!URL.canParse(absolute)) {
      throw integrationError("invalid-config", `GitHub request path is not a URL: ${path}`, {
        path,
        retryable: false
      })
    }
    const url = new URL(absolute)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  const urlFor = (
    path: string,
    query?: RequestOptions["query"]
  ): Effect.Effect<string, IntegrationError> =>
    Effect.try({ try: () => buildUrl(path, query), catch: (cause) => cause as IntegrationError })

  // Serialized once, before the attempt. `JSON.stringify` throws on a cyclic
  // or unserializable body, and inside the transport attempt that throw was
  // reported as an unknown write outcome even though no request was sent.
  const encodeBody = (body: unknown): Effect.Effect<string | undefined, IntegrationError> =>
    body === undefined ? Effect.succeed(undefined) : Effect.try({
      try: () => JSON.stringify(body),
      catch: (cause) =>
        integrationError(
          "invalid-config",
          "GitHub request body could not be serialized as JSON.",
          { retryable: false, outcomeUnknown: false },
          { cause }
        )
    })

  const attemptOnce = (
    method: RequestMethod,
    url: string,
    body?: string,
    retryUnsafeWrites: boolean = false
  ): Effect.Effect<{ readonly json: unknown; readonly headers: Headers }, IntegrationError> => {
    // A rate limit is a refusal: the request was not performed, so repeating
    // it is safe for every verb. A 5xx or a dropped connection on a write is
    // not, because GitHub may have applied it and lost the answer.
    const mayRepeatAmbiguously = retryUnsafeWrites || !UNSAFE_METHODS.includes(method)
    return Effect.tryPromise({
      try: async (signal) => {
        assertApiOrigin(url)
        const headers: Record<string, string> = {
          accept: "application/vnd.github+json",
          "user-agent": "smithers-integrations",
          "x-github-api-version": "2022-11-28"
        }
        if (resolved.token !== undefined) headers["authorization"] = `Bearer ${resolved.token}`
        if (body !== undefined) headers["content-type"] = "application/json"
        const response = await fetch(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          signal
        })
        const text = await response.text()
        let json: unknown = null
        if (text.length > 0) {
          try {
            json = JSON.parse(text)
          } catch {
            json = text
          }
        }
        if (response.ok) return { json, headers: response.headers }
        const rateLimited = isRateLimitResponse(response.status, response.headers, json)
        const serverError = response.status >= 500
        const outcomeUnknown = serverError && !mayRepeatAmbiguously
        const retryable = rateLimited || (serverError && mayRepeatAmbiguously)
        const message = typeof json === "object" && json !== null && "message" in json
          ? String(json.message)
          : response.statusText
        throw integrationError(
          "delivery-failed",
          `GitHub request failed: ${method} ${new URL(url).pathname} -> ${response.status} ${message}${
            outcomeUnknown ? " (outcome unknown: the write was not repeated)" : ""
          }`,
          {
            status: response.status,
            method,
            path: new URL(url).pathname,
            retryable,
            rateLimited,
            outcomeUnknown,
            retryAfterMs: retryable ? retryAfterMs(response.headers) : null,
            ratelimitRemaining: response.headers.get("x-ratelimit-remaining")
          }
        )
      },
      catch: (cause) =>
        cause instanceof IntegrationError
          ? integrationError(cause.reason, cause.summary, cause.details, { cause: cause.cause })
          : integrationError(
            "delivery-failed",
            `GitHub request failed: ${method} - ${cause instanceof Error ? cause.message : String(cause)}${
              mayRepeatAmbiguously ? "" : " (outcome unknown: the write was not repeated)"
            }`,
            { method, retryable: mayRepeatAmbiguously, outcomeUnknown: !mayRepeatAmbiguously },
            { cause }
          )
      // The deadline spans the whole exchange, headers and body alike. The
      // timeout interrupts the attempt, which aborts the `fetch` signal and
      // closes the socket, so a stalled peer stops holding the caller. On a
      // write it is the same ambiguity a dropped connection is: GitHub may
      // have applied it, so the outcome is reported as unknown rather than
      // repeated.
    }).pipe(
      Effect.timeoutOrElse({
        duration: requestTimeout,
        orElse: () =>
          Effect.fail(integrationError(
            "delivery-failed",
            `GitHub request timed out after ${requestTimeoutMs} ms: ${method}${
              mayRepeatAmbiguously ? "" : " (outcome unknown: the write was not repeated)"
            }`,
            {
              method,
              retryable: mayRepeatAmbiguously,
              outcomeUnknown: !mayRepeatAmbiguously,
              timedOut: true,
              requestTimeoutMs
            }
          ))
      })
    )
  }

  const requestUrl = (
    method: RequestMethod,
    url: string,
    body?: string,
    retryUnsafeWrites?: boolean
  ): Effect.Effect<{ readonly json: unknown; readonly headers: Headers }, IntegrationError> => {
    const schedule = Schedule.exponential("250 millis").pipe(
      Schedule.upTo({ times: resolved.maxRetries }),
      Schedule.while(({ input }) => isRetryable(input)),
      Schedule.passthrough,
      Schedule.addDelay(({ input }) => {
        if (!isRetryable(input)) return Effect.succeed(Duration.zero)
        const details = (input as IntegrationError).details as { readonly retryAfterMs?: number | null } | undefined
        const wait = details?.retryAfterMs
        return Effect.succeed(typeof wait === "number" && wait > 0 ? Duration.millis(wait) : Duration.zero)
      })
    )
    let attempts = 0
    return Effect.suspend(() => {
      attempts += 1
      return attemptOnce(method, url, body, retryUnsafeWrites)
    }).pipe(
      Effect.tapError((error) => failureAttributes(error)),
      Effect.retry(schedule),
      Effect.ensuring(Effect.suspend(() => Effect.annotateCurrentSpan("http.attempts", attempts))),
      Effect.withSpan("GitHubClient.request", {
        attributes: { "http.request.method": method, "url.path": new URL(url).pathname }
      })
    )
  }

  function request<A>(
    method: RequestMethod,
    path: string,
    body: unknown,
    options: DecodedRequestOptions<A>
  ): Effect.Effect<A, IntegrationError>
  function request(
    method: RequestMethod,
    path: string,
    body?: unknown,
    options?: RequestOptions
  ): Effect.Effect<unknown, IntegrationError>
  function request(
    method: RequestMethod,
    path: string,
    body?: unknown,
    options?: RequestOptions & { readonly schema?: Schema.Schema<any> | undefined }
  ): Effect.Effect<unknown, IntegrationError> {
    return Effect.all([urlFor(path, options?.query), encodeBody(body)]).pipe(
      Effect.flatMap(([url, encoded]) => requestUrl(method, url, encoded, options?.retryUnsafeWrites)),
      Effect.flatMap(({ json }) => {
        const schema = options?.schema
        if (schema === undefined) return Effect.succeed(json)
        return (Schema.decodeUnknownEffect(schema)(json) as Effect.Effect<unknown, unknown>).pipe(
          Effect.mapError((cause) =>
            integrationError(
              "decode-failed",
              `GitHub response for ${method} ${path} failed schema validation.`,
              { method, path },
              { cause }
            )
          )
        )
      })
    )
  }

  const paginate: GitHubClient["paginate"] = (path, options) =>
    Effect.gen(function*() {
      const perPage = yield* bounded("perPage", options?.perPage, MAX_PER_PAGE, 1, MAX_PER_PAGE)
      const maxPages = yield* bounded("maxPages", options?.maxPages, DEFAULT_MAX_PAGES, 1, MAX_PAGES_LIMIT)
      const items: Array<unknown> = []
      let url: string | null = yield* urlFor(path, { per_page: perPage })
      let pages = 0
      while (url !== null && pages < maxPages) {
        const page: { readonly json: unknown; readonly headers: Headers } = yield* requestUrl("GET", url)
        if (Array.isArray(page.json)) items.push(...page.json)
        else if (page.json !== null) items.push(page.json)
        url = nextPageUrl(page.headers.get("link"))
        pages += 1
      }
      yield* Effect.annotateCurrentSpan({ "github.pages": pages, "github.truncated": url !== null })
      return { items, truncated: url !== null }
    }).pipe(Effect.withSpan("GitHubClient.paginate", { attributes: { "github.path": path } }))

  return GitHubClient.of({ request, paginate })
}

/**
 * Layer for a client bound to `config`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  config: GitHubConfig = {},
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): Layer.Layer<GitHubClient, IntegrationError> =>
  Layer.effect(GitHubClient)(Effect.suspend(() => {
    // A config error is a typed layer failure. Anything else make throws is a
    // defect and stays one.
    try {
      return Effect.succeed(make(config, env))
    } catch (error) {
      if (isIntegrationError(error)) return Effect.fail(error)
      throw error
    }
  }))
