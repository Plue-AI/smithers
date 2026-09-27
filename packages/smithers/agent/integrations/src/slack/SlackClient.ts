/**
 * The Slack Web API client.
 *
 * Every Web API method is a `POST <base>/<method>` carrying a bearer token and
 * a form-encoded body, and every answer is a JSON envelope whose `ok` says
 * whether Slack performed the call. Parameters that are objects or arrays
 * (`blocks`, `metadata`) are sent as JSON strings inside the form, which is the
 * encoding Slack documents for form bodies. What the client adds over a bare
 * `fetch`:
 *
 * - **Refusals are typed.** `ok: false` fails with an `IntegrationError`
 *   carrying Slack's own `error` code in `details.slackError`. Slack validates
 *   a call before acting on it, so a refusal is a known outcome: nothing
 *   happened. Authentication and scope refusals are `permission-denied`.
 * - **Rate limits.** HTTP 429 with `Retry-After`, and `ok: false` with
 *   `error: "ratelimited"`, are retried for every method, because a refused
 *   call was not performed. The wait honors `Retry-After`, capped.
 * - **Ambiguous writes.** `chat.*`, `reactions.*`, `conversations.join` and
 *   `conversations.open` change the workspace. A 5xx, one of Slack's
 *   server-side error codes, a dropped connection, a timeout, or an unreadable
 *   answer on one of them fails with `outcomeUnknown: true` and is never
 *   repeated, because Slack may have posted the message and lost the answer.
 *   The same failures on a read are retried with bounded exponential backoff.
 * - **Pagination.** {@link SlackClient.paginate} follows
 *   `response_metadata.next_cursor` within a page budget and reports
 *   `truncated` when the budget ran out first.
 * - **Token hygiene.** A token reaches the `Authorization` header and nothing
 *   else. Method names are validated before they become a path, redirects are
 *   not followed, and every error is redacted of the token it was sent with.
 * - **Rotating tokens.** Tokens come from an `AccessTokenSource`. When a
 *   caller-supplied source's token is refused as expired or invalid, the
 *   client discards it and tries once more with a fresh one; the refusal was
 *   not performed, so this is safe for writes too.
 *
 * Every attempt carries its own `requestTimeout` over the headers and the
 * body, and interrupting the fiber aborts the request in flight.
 *
 * @since 1.0.0
 */

import { isRecord } from "@smthrs/canonical/Record"
import { Context, Duration, Effect, Layer, Redacted } from "effect"
import * as AccessToken from "../core/AccessToken.ts"
import { IntegrationError, isIntegrationError } from "../core/IntegrationError.ts"
import { redactedError } from "../core/RedactedError.ts"
import * as Environment from "../Environment.ts"
import { resolve, type SlackConfig } from "./Config.ts"

/**
 * Which of the app's tokens a call carries.
 *
 * `app` is the app-level token, which only `apps.connections.open` accepts.
 *
 * @category models
 * @since 1.0.0
 */
export type Auth = "bot" | "app"

/**
 * Per-call options.
 *
 * @category models
 * @since 1.0.0
 */
export interface CallOptions {
  /** The token to send. Defaults to `bot`. */
  readonly auth?: Auth | undefined
  /**
   * Whether the call changes the workspace, overriding {@link isWriteMethod}.
   * A write is never repeated after an ambiguous failure.
   */
  readonly write?: boolean | undefined
}

/**
 * Bounds for one {@link SlackClient.paginate} walk.
 *
 * @category models
 * @since 1.0.0
 */
export interface PageOptions extends CallOptions {
  /** Pages to read at most. Defaults to {@link DEFAULT_MAX_PAGES}; 1 to {@link MAX_PAGES_LIMIT}. */
  readonly maxPages?: number | undefined
  /** The `limit` sent with each page. Defaults to 200; 1 to 1000. */
  readonly limit?: number | undefined
}

/**
 * One pagination walk's result.
 *
 * @category models
 * @since 1.0.0
 */
export interface Page {
  readonly items: ReadonlyArray<unknown>
  /** True when the page budget ran out with a next cursor still outstanding. */
  readonly truncated: boolean
  /** The cursor that continues the walk, or `null` when the listing is complete. */
  readonly nextCursor: string | null
}

/**
 * The client service.
 *
 * @category services
 * @since 1.0.0
 */
export interface SlackClient {
  /** One Web API call, answering the whole `ok: true` envelope. */
  readonly call: (
    method: string,
    params?: Readonly<Record<string, unknown>>,
    options?: CallOptions
  ) => Effect.Effect<Readonly<Record<string, unknown>>, IntegrationError>
  /**
   * Walks a cursor-paginated method and concatenates the array under
   * `itemsKey` (`messages`, `channels`, `members`) from every page.
   */
  readonly paginate: (
    method: string,
    itemsKey: string,
    params?: Readonly<Record<string, unknown>>,
    options?: PageOptions
  ) => Effect.Effect<Page, IntegrationError>
}

/**
 * Service tag for the Slack Web API client.
 *
 * @category services
 * @since 1.0.0
 */
export const SlackClient: Context.Service<SlackClient, SlackClient> = Context.Service(
  "@smthrs/integrations/SlackClient"
)

/**
 * The token sources a client asks for its bearer tokens.
 *
 * A source supplied here takes precedence over the configured token string,
 * and is treated as rotating: a token Slack refuses as expired or invalid is
 * invalidated and the call is tried once more.
 *
 * @category models
 * @since 1.0.0
 */
export interface Tokens {
  readonly bot?: AccessToken.AccessTokenSource | undefined
  readonly app?: AccessToken.AccessTokenSource | undefined
}

/**
 * The default page budget of {@link SlackClient.paginate}.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_MAX_PAGES = 10

/**
 * The largest page budget {@link SlackClient.paginate} accepts.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_PAGES_LIMIT = 1000

const WRITE_PREFIXES: ReadonlyArray<string> = ["chat.", "reactions."]
const WRITE_METHODS: ReadonlySet<string> = new Set(["conversations.join", "conversations.open"])
const READS_UNDER_WRITE_PREFIXES: ReadonlySet<string> = new Set([
  "chat.getPermalink",
  "chat.scheduledMessages.list",
  "reactions.get",
  "reactions.list"
])

/**
 * Whether `method` changes the workspace, so an ambiguous failure must not be
 * repeated: `chat.*` and `reactions.*` except their reads, plus
 * `conversations.join` and `conversations.open`.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isWriteMethod = (method: string): boolean =>
  WRITE_METHODS.has(method) ||
  (!READS_UNDER_WRITE_PREFIXES.has(method) && WRITE_PREFIXES.some((prefix) => method.startsWith(prefix)))

/**
 * Slack error codes that say the server failed partway, so a write may have
 * been applied.
 *
 * @category constants
 * @since 1.0.0
 */
export const SERVER_ERRORS: ReadonlySet<string> = new Set([
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout"
])

/**
 * Slack error codes that refuse the credential rather than the call.
 *
 * @category constants
 * @since 1.0.0
 */
export const AUTH_ERRORS: ReadonlySet<string> = new Set([
  "not_authed",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "no_permission",
  "missing_scope",
  "not_allowed_token_type",
  "access_denied",
  "ekm_access_denied",
  "team_access_not_granted"
])

const REAUTH_ERRORS: ReadonlySet<string> = new Set(["invalid_auth", "token_expired"])

const METHOD_NAME = /^[a-z][A-Za-z]*(?:\.[a-z][A-Za-z]*)+$/
const MAX_BACKOFF_MS = 30_000

/**
 * The `response_metadata.next_cursor` of an answer, or `null` when the
 * listing is complete.
 *
 * @category getters
 * @since 1.0.0
 */
export const nextCursor = (answer: Readonly<Record<string, unknown>>): string | null => {
  const metadata = answer["response_metadata"]
  const cursor = isRecord(metadata) ? metadata["next_cursor"] : undefined
  return typeof cursor === "string" && cursor.length > 0 ? cursor : null
}

const invalidConfig = (message: string, details: Record<string, unknown>): IntegrationError =>
  new IntegrationError("invalid-config", message, { ...details, retryable: false, outcomeUnknown: false })

/**
 * Form-encodes call parameters. Strings pass through, numbers and booleans
 * are stringified, objects and arrays become JSON, and absent values are
 * omitted. Throws for a value JSON cannot represent.
 */
const encodeParams = (params: Readonly<Record<string, unknown>>): string => {
  const form = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    form.set(key, typeof value === "object" ? JSON.stringify(value) : String(value))
  }
  return form.toString()
}

const bounded = (
  name: string,
  value: number | undefined,
  fallback: number,
  max: number
): Effect.Effect<number, IntegrationError> =>
  value === undefined
    ? Effect.succeed(fallback)
    : Number.isSafeInteger(value) && value >= 1 && value <= max
    ? Effect.succeed(value)
    : Effect.fail(invalidConfig(`Slack ${name} must be an integer from 1 to ${max}.`, { [name]: value }))

interface Answer {
  readonly status: number
  readonly headers: Headers
  readonly text: string
}

/**
 * Builds a Web API client bound to `config`.
 *
 * `env` is the fallback source for anything `config` omits, and replaces the
 * ambient environment rather than layering over it. `tokens` supplies token
 * sources that take precedence over configured token strings.
 *
 * Throws `IntegrationError` with reason `invalid-config` for a bad config.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  config: SlackConfig = {},
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment(),
  tokens: Tokens = {}
): SlackClient => {
  const resolved = resolve(config, env)
  const requestTimeoutMs = Duration.toMillis(resolved.requestTimeout)
  const retryBaseMs = Duration.toMillis(resolved.retryBaseDelay)
  const fixed = (token: Redacted.Redacted<string> | undefined) =>
    token === undefined ? undefined : AccessToken.fixed(token)
  const sources: Readonly<Record<Auth, AccessToken.AccessTokenSource | undefined>> = {
    bot: tokens.bot ?? fixed(resolved.botToken),
    app: tokens.app ?? fixed(resolved.appToken)
  }
  const rotating: Readonly<Record<Auth, boolean>> = { bot: tokens.bot !== undefined, app: tokens.app !== undefined }

  const retryAfterMs = (headers: Headers): number => {
    const header = headers.get("retry-after")
    const seconds = header === null ? 1 : Number(header)
    const honored = Number.isFinite(seconds) && seconds >= 0 ? seconds : 1
    return Math.min(honored, resolved.maxRetryAfterSeconds) * 1000
  }

  const attemptOnce = (
    method: string,
    write: boolean,
    body: string,
    token: Redacted.Redacted<string>
  ): Effect.Effect<Readonly<Record<string, unknown>>, IntegrationError> => {
    const secret = Redacted.value(token)
    const failure = redactedError([secret, `Bearer ${secret}`])
    const base = { method, write }
    // A server failure, a lost connection, a timeout and an unreadable answer
    // all leave a write's outcome unknown. A read is simply worth another try.
    const ambiguous = (summary: string, details: Record<string, unknown>, cause?: unknown) =>
      failure(
        "delivery-failed",
        `${summary}${write ? " (outcome unknown: the write was not repeated)" : ""}`,
        { ...base, ...details, retryable: !write, rateLimited: false, outcomeUnknown: write },
        { cause }
      )
    const classify = (
      { headers, status, text }: Answer
    ): Effect.Effect<Readonly<Record<string, unknown>>, IntegrationError> => {
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        json = undefined
      }
      const envelope = isRecord(json) && typeof json["ok"] === "boolean" ? json : undefined
      const slackError = envelope !== undefined && envelope["ok"] === false
        ? typeof envelope["error"] === "string" ? envelope["error"] : "unknown_error"
        : null
      if (status === 429 || slackError === "ratelimited") {
        const wait = retryAfterMs(headers)
        return Effect.fail(failure("delivery-failed", `Slack rate-limited ${method}; retry after ${wait} ms.`, {
          ...base,
          status,
          slackError,
          retryable: true,
          rateLimited: true,
          outcomeUnknown: false,
          retryAfterMs: wait
        }))
      }
      if (status >= 500 || (slackError !== null && SERVER_ERRORS.has(slackError))) {
        return Effect.fail(ambiguous(`Slack ${method} failed on the server: ${slackError ?? `HTTP ${status}`}`, {
          status,
          slackError
        }))
      }
      if (slackError !== null) {
        return Effect.fail(
          failure(
            AUTH_ERRORS.has(slackError) ? "permission-denied" : "delivery-failed",
            `Slack refused ${method}: ${slackError}`,
            {
              ...base,
              status,
              slackError,
              retryable: false,
              rateLimited: false,
              outcomeUnknown: false,
              reauth: REAUTH_ERRORS.has(slackError)
            }
          )
        )
      }
      if (status > 299) {
        return Effect.fail(
          failure(
            status === 401 || status === 403 ? "permission-denied" : "delivery-failed",
            `Slack refused ${method}: HTTP ${status}`,
            { ...base, status, retryable: false, rateLimited: false, outcomeUnknown: false }
          )
        )
      }
      if (envelope === undefined) {
        // A write the server answered 2xx has probably happened; only the
        // answer is unreadable, so its outcome is reported as unknown.
        return Effect.fail(
          failure("decode-failed", `Slack ${method} answered with something that is not a Web API envelope.`, {
            ...base,
            status,
            retryable: false,
            rateLimited: false,
            outcomeUnknown: write
          })
        )
      }
      return Effect.succeed(envelope)
    }
    return Effect.tryPromise({
      try: async (signal): Promise<Answer> => {
        const response = await fetch(`${resolved.apiBaseUrl}/${method}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/x-www-form-urlencoded; charset=utf-8"
          },
          body,
          redirect: "manual",
          signal
        })
        return { status: response.status, headers: response.headers, text: await response.text() }
      },
      catch: (cause) => ambiguous(`Slack ${method} failed before an answer arrived.`, { transport: true }, cause)
    }).pipe(
      Effect.timeoutOrElse({
        duration: resolved.requestTimeout,
        orElse: () =>
          Effect.fail(ambiguous(`Slack ${method} timed out after ${requestTimeoutMs} ms.`, {
            timedOut: true,
            requestTimeoutMs
          }))
      }),
      Effect.flatMap(classify)
    )
  }

  const call: SlackClient["call"] = (method, params = {}, options = {}) =>
    Effect.gen(function*() {
      if (!METHOD_NAME.test(method)) {
        return yield* Effect.fail(invalidConfig("Slack method name is not a Web API method.", { method }))
      }
      const auth = options.auth ?? "bot"
      const source = sources[auth]
      if (source === undefined) {
        return yield* Effect.fail(
          new IntegrationError(
            "credentials-missing",
            `Slack ${auth} token is not configured for ${method}. Pass config.${auth}Token, set SMITHERS_SLACK_${auth.toUpperCase()}_TOKEN, or supply a token source.`,
            { method, auth, retryable: false, outcomeUnknown: false }
          )
        )
      }
      const write = options.write ?? isWriteMethod(method)
      const body = yield* Effect.try({
        try: () => encodeParams(params),
        catch: (cause) =>
          new IntegrationError("invalid-config", `Slack ${method} parameters could not be encoded.`, {
            method,
            retryable: false,
            outcomeUnknown: false
          }, { cause })
      })
      const attempt = (
        rateLimits: number,
        retries: number,
        reauthed: boolean
      ): Effect.Effect<Readonly<Record<string, unknown>>, IntegrationError> =>
        source.token.pipe(
          Effect.flatMap((token) => attemptOnce(method, write, body, token)),
          Effect.catch((error) => {
            // An IntegrationError always carries details: its reason at least.
            const details = error.details as Readonly<Record<string, unknown>>
            if (details["rateLimited"] === true) {
              return rateLimits < resolved.maxRateLimitRetries
                ? Effect.sleep(Duration.millis(details["retryAfterMs"] as number)).pipe(
                  Effect.andThen(attempt(rateLimits + 1, retries, reauthed))
                )
                : Effect.fail(error)
            }
            if (details["reauth"] === true && rotating[auth] && !reauthed) {
              return source.invalidate.pipe(Effect.andThen(attempt(rateLimits, retries, true)))
            }
            if (details["retryable"] === true && retries < resolved.maxRetries) {
              const delay = Math.min(retryBaseMs * 2 ** retries, MAX_BACKOFF_MS)
              return Effect.sleep(Duration.millis(delay)).pipe(
                Effect.andThen(attempt(rateLimits, retries + 1, reauthed))
              )
            }
            return Effect.fail(error)
          })
        )
      return yield* attempt(0, 0, false)
    }).pipe(Effect.withSpan("SlackClient.call", { attributes: { "slack.method": method } }))

  const paginate: SlackClient["paginate"] = (method, itemsKey, params = {}, options = {}) =>
    Effect.gen(function*() {
      const maxPages = yield* bounded("maxPages", options.maxPages, DEFAULT_MAX_PAGES, MAX_PAGES_LIMIT)
      const limit = yield* bounded("limit", options.limit, 200, 1000)
      const items: Array<unknown> = []
      let cursor: string | null = null
      let pages = 0
      do {
        const answer: Readonly<Record<string, unknown>> = yield* call(
          method,
          { ...params, limit, ...(cursor === null ? {} : { cursor }) },
          options
        )
        const page = answer[itemsKey]
        if (!Array.isArray(page)) {
          return yield* Effect.fail(
            new IntegrationError("decode-failed", `Slack ${method} answered without a "${itemsKey}" array.`, {
              method,
              itemsKey,
              retryable: false,
              outcomeUnknown: false
            })
          )
        }
        items.push(...page)
        cursor = nextCursor(answer)
        pages += 1
      } while (cursor !== null && pages < maxPages)
      return { items, truncated: cursor !== null, nextCursor: cursor }
    }).pipe(Effect.withSpan("SlackClient.paginate", { attributes: { "slack.method": method } }))

  return SlackClient.of({ call, paginate })
}

/**
 * Layer for a client bound to `config`.
 *
 * A config error is a typed layer failure; anything else `make` throws is a
 * defect and stays one.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  config: SlackConfig = {},
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment(),
  tokens: Tokens = {}
): Layer.Layer<SlackClient, IntegrationError> =>
  Layer.effect(SlackClient)(Effect.suspend(() => {
    try {
      return Effect.succeed(make(config, env, tokens))
    } catch (error) {
      if (isIntegrationError(error)) return Effect.fail(error)
      throw error
    }
  }))
