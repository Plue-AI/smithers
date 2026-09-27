/**
 * The X (Twitter) API v2 client.
 *
 * It covers what a personal-account connector needs: the account itself,
 * `GET /users/:id/mentions` (with `since_id` and `pagination_token`),
 * `GET /users/:id/tweets` for reconciliation, `GET /dm_events` and the
 * one-to-one conversation's events, `POST /tweets`, and
 * `POST /dm_conversations/with/:participant_id/messages`. The behaviors that
 * justify it over a bare `fetch`:
 *
 * - **Grant first.** With a `Connection` bound, each call checks the
 *   connection's scopes against `Capabilities` before anything is sent.
 * - **Rate limits.** A 429 was refused, not performed, so it is retried for
 *   every call, after `x-rate-limit-reset` (epoch seconds) when X sent it. X
 *   windows last fifteen minutes; a wait longer than `maxRetryAfter` is not
 *   sat out in process, and the call fails at once as retryable, carrying
 *   `retryAfterMs`.
 * - **Ambiguous writes.** A 5xx, a timeout or a dropped connection on a read
 *   is retried. On a post or a direct message X may have acted and lost the
 *   answer, so the client reports `outcomeUnknown` and never repeats it; the
 *   caller reconciles by looking the post up. A 2xx whose body does not decode
 *   is reported the same way.
 * - **Tokens.** Each attempt asks the `AccessTokenSource` for the current
 *   token. A 401 discards it and repeats the request once with a fresh one; a
 *   second 401 is `permission-denied`. The token reaches the `Authorization`
 *   header only, and errors redact it if a peer echoes it.
 *
 * Every user and post id is validated as a decimal id before it becomes a
 * path segment.
 *
 * @since 1.0.0
 */

import { Clock, Context, Duration, Effect, Layer, Option, Redacted, Schedule, Schema } from "effect"
import { IntegrationError, isRetryable } from "../core/IntegrationError.ts"
import { redactedError } from "../core/RedactedError.ts"
import * as Environment from "../Environment.ts"
import { type Operation, refusal } from "./Capabilities.ts"
import { PROVIDER, resolve, type XConfig } from "./Config.ts"

/**
 * An X user, post or direct-message event id: a decimal snowflake.
 *
 * @category schemas
 * @since 1.0.0
 */
export const XId = Schema.String.check(Schema.isPattern(/^[0-9]{1,19}$/))

/**
 * A user, as the `users` expansion returns one.
 *
 * @category schemas
 * @since 1.0.0
 */
export const User = Schema.Struct({
  id: XId,
  name: Schema.optionalKey(Schema.String),
  username: Schema.optionalKey(Schema.String)
})

/**
 * A user.
 *
 * @category models
 * @since 1.0.0
 */
export type User = typeof User.Type

/**
 * A post another post refers to.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ReferencedTweet = Schema.Struct({
  type: Schema.String,
  id: XId
})

/**
 * A post.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Tweet = Schema.Struct({
  id: XId,
  text: Schema.String,
  author_id: Schema.optionalKey(XId),
  created_at: Schema.optionalKey(Schema.String),
  conversation_id: Schema.optionalKey(XId),
  in_reply_to_user_id: Schema.optionalKey(XId),
  referenced_tweets: Schema.optionalKey(Schema.Array(ReferencedTweet))
})

/**
 * A post.
 *
 * @category models
 * @since 1.0.0
 */
export type Tweet = typeof Tweet.Type

/**
 * Expanded objects that accompany a page.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Includes = Schema.Struct({
  users: Schema.optionalKey(Schema.Array(User))
})

/**
 * Expanded objects that accompany a page.
 *
 * @category models
 * @since 1.0.0
 */
export type Includes = typeof Includes.Type

/**
 * One page of a timeline: mentions or a user's posts, newest first.
 *
 * @category schemas
 * @since 1.0.0
 */
export const TimelinePage = Schema.Struct({
  data: Schema.optionalKey(Schema.Array(Tweet)),
  includes: Schema.optionalKey(Includes),
  meta: Schema.optionalKey(Schema.Struct({
    result_count: Schema.optionalKey(Schema.Number),
    newest_id: Schema.optionalKey(XId),
    oldest_id: Schema.optionalKey(XId),
    next_token: Schema.optionalKey(Schema.String)
  }))
})

/**
 * One page of a timeline.
 *
 * @category models
 * @since 1.0.0
 */
export type TimelinePage = typeof TimelinePage.Type

/**
 * A direct-message event.
 *
 * @category schemas
 * @since 1.0.0
 */
export const DmEvent = Schema.Struct({
  id: XId,
  event_type: Schema.String,
  text: Schema.optionalKey(Schema.String),
  sender_id: Schema.optionalKey(XId),
  dm_conversation_id: Schema.optionalKey(Schema.NonEmptyString),
  created_at: Schema.optionalKey(Schema.String),
  participant_ids: Schema.optionalKey(Schema.Array(XId))
})

/**
 * A direct-message event.
 *
 * @category models
 * @since 1.0.0
 */
export type DmEvent = typeof DmEvent.Type

/**
 * One page of direct-message events, newest first.
 *
 * @category schemas
 * @since 1.0.0
 */
export const DmEventsPage = Schema.Struct({
  data: Schema.optionalKey(Schema.Array(DmEvent)),
  includes: Schema.optionalKey(Includes),
  meta: Schema.optionalKey(Schema.Struct({
    result_count: Schema.optionalKey(Schema.Number),
    next_token: Schema.optionalKey(Schema.String),
    previous_token: Schema.optionalKey(Schema.String)
  }))
})

/**
 * One page of direct-message events.
 *
 * @category models
 * @since 1.0.0
 */
export type DmEventsPage = typeof DmEventsPage.Type

/**
 * The post X created.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CreatedTweet = Schema.Struct({
  data: Schema.Struct({ id: XId, text: Schema.String })
})

/**
 * The direct message X sent.
 *
 * @category schemas
 * @since 1.0.0
 */
export const SentDirectMessage = Schema.Struct({
  data: Schema.Struct({ dm_conversation_id: Schema.NonEmptyString, dm_event_id: XId })
})

const Me = Schema.Struct({ data: User })

/**
 * Post fields every timeline read requests.
 *
 * @category constants
 * @since 1.0.0
 */
export const TWEET_FIELDS = "author_id,conversation_id,created_at,in_reply_to_user_id,referenced_tweets"

/**
 * Direct-message event fields every event read requests.
 *
 * @category constants
 * @since 1.0.0
 */
export const DM_EVENT_FIELDS = "id,text,event_type,created_at,dm_conversation_id,sender_id,participant_ids"

/**
 * User fields every expansion requests.
 *
 * @category constants
 * @since 1.0.0
 */
export const USER_FIELDS = "username,name"

/**
 * Where a timeline read starts and how much it reads.
 *
 * @category models
 * @since 1.0.0
 */
export interface TimelineOptions {
  /** Only posts newer than this id. */
  readonly sinceId?: string | undefined
  readonly paginationToken?: string | undefined
  /** Only posts created at or after this ISO 8601 instant. */
  readonly startTime?: string | undefined
  /** Between 5 and 100. */
  readonly maxResults?: number | undefined
}

/**
 * How much of a direct-message event list to read.
 *
 * @category models
 * @since 1.0.0
 */
export interface DmEventsOptions {
  readonly paginationToken?: string | undefined
  /** Between 1 and 100. */
  readonly maxResults?: number | undefined
}

/**
 * The client service.
 *
 * @category services
 * @since 1.0.0
 */
export interface XClient {
  /** The connection the client acts for, when one is bound. */
  readonly connectionId: string | undefined
  /** `GET /users/me`: the account the token belongs to. */
  readonly me: Effect.Effect<User, IntegrationError>
  /** `GET /users/:id/mentions`: one page, newest first. */
  readonly mentions: (userId: string, options?: TimelineOptions) => Effect.Effect<TimelinePage, IntegrationError>
  /** `GET /users/:id/tweets`: one page, newest first. */
  readonly userTweets: (userId: string, options?: TimelineOptions) => Effect.Effect<TimelinePage, IntegrationError>
  /** `GET /dm_events`: one page of message events across conversations, newest first. */
  readonly dmEvents: (options?: DmEventsOptions) => Effect.Effect<DmEventsPage, IntegrationError>
  /** `GET /dm_conversations/with/:participant_id/dm_events`: one page, newest first. */
  readonly conversationEvents: (
    participantId: string,
    options?: DmEventsOptions
  ) => Effect.Effect<DmEventsPage, IntegrationError>
  /** `POST /tweets`. Never repeated after an ambiguous failure. */
  readonly createTweet: (request: {
    readonly text: string
    readonly replyToTweetId?: string | undefined
  }) => Effect.Effect<typeof CreatedTweet.Type, IntegrationError>
  /** `POST /dm_conversations/with/:participant_id/messages`. Never repeated after an ambiguous failure. */
  readonly sendDirectMessage: (
    participantId: string,
    text: string
  ) => Effect.Effect<typeof SentDirectMessage.Type, IntegrationError>
}

/**
 * Service tag for the X client.
 *
 * @category services
 * @since 1.0.0
 */
export const XClient: Context.Service<XClient, XClient> = Context.Service("@smthrs/integrations/XClient")

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The message in an X error body: a problem `detail` or `title`, or the first
 * entry of `errors`. Anything else yields an empty message.
 *
 * @category getters
 * @since 1.0.0
 */
export const xError = (body: unknown): string => {
  const record = isRecord(body) ? body : {}
  const errors = Array.isArray(record["errors"]) ? record["errors"] : []
  const first: Record<string, unknown> = isRecord(errors[0]) ? errors[0] : {}
  const message = [record["detail"], record["title"], first["message"], first["detail"]]
    .find((candidate) => typeof candidate === "string")
  return typeof message === "string" ? message.slice(0, 300) : ""
}

/**
 * The wait `x-rate-limit-reset` asks for, in milliseconds from `nowMs`, or
 * `null` when the header is absent or malformed.
 *
 * @category getters
 * @since 1.0.0
 */
export const retryAfterMs = (headers: Headers, nowMs: number): number | null => {
  const value = headers.get("x-rate-limit-reset")
  const seconds = value === null || value.trim() === "" ? Number.NaN : Number(value)
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000 - nowMs) : null
}

type Query = Readonly<Record<string, string | number | undefined>>

interface Call<A> {
  readonly method: "GET" | "POST"
  readonly path: string
  readonly operation: Operation
  readonly schema: Schema.Codec<A>
  readonly query?: Query | undefined
  readonly body?: unknown
}

const invalid = (message: string, details: Record<string, unknown>): IntegrationError =>
  new IntegrationError("invalid-config", message, { ...details, retryable: false })

const duration = (name: string, input: Duration.Input, allowZero: boolean): Duration.Duration => {
  const parsed = Option.getOrUndefined(Duration.fromInput(input))
  const millis = parsed === undefined || !Duration.isFinite(parsed) ? Number.NaN : Duration.toMillis(parsed)
  if (!(millis > 0 || (allowZero && millis === 0))) {
    throw invalid(`X ${name} must be a finite${allowZero ? ", non-negative" : ", positive"} duration.`, {
      [name]: String(input)
    })
  }
  return parsed as Duration.Duration
}

const bounded = (value: number | undefined, min: number): Effect.Effect<number | undefined, IntegrationError> =>
  value === undefined || (Number.isSafeInteger(value) && value >= min && value <= 100)
    ? Effect.succeed(value)
    : Effect.fail(invalid(`X maxResults must be an integer between ${min} and 100.`, { maxResults: value }))

const requireId = (kind: string, id: string): Effect.Effect<string, IntegrationError> =>
  Schema.is(XId)(id) ? Effect.succeed(id) : Effect.fail(invalid(`X ${kind} id is not a decimal id.`, { kind }))

/**
 * Builds a client bound to `config`.
 *
 * Throws `invalid-config` for a connection to another provider, a base URL
 * that is not HTTP(S), or a retry budget, deadline or rate-limit cap out of
 * range.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  config: XConfig,
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): XClient => {
  const resolved = resolve(config, env)
  const connection = resolved.connection
  if (connection !== undefined && connection.provider !== PROVIDER) {
    throw invalid(`An X client cannot act for a "${connection.provider}" connection.`, {
      connectionId: connection.id,
      provider: connection.provider
    })
  }
  const baseUrl = resolved.apiBaseUrl.replace(/\/+$/, "")
  const parsed = URL.canParse(baseUrl) ? new URL(baseUrl) : undefined
  if (parsed === undefined || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw invalid("X apiBaseUrl must be an HTTP or HTTPS URL.", { apiBaseUrl: resolved.apiBaseUrl })
  }
  if (!Number.isSafeInteger(resolved.maxRetries) || resolved.maxRetries < 0 || resolved.maxRetries > 10) {
    throw invalid("X maxRetries must be an integer between 0 and 10.", { maxRetries: resolved.maxRetries })
  }
  const requestTimeout = duration("requestTimeout", resolved.requestTimeout, false)
  const requestTimeoutMs = Duration.toMillis(requestTimeout)
  const maxRetryAfterMs = Duration.toMillis(duration("maxRetryAfter", resolved.maxRetryAfter, true))
  const tokens = resolved.token

  const buildUrl = (path: string, query: Query | undefined): string => {
    const url = new URL(`${baseUrl}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  const attemptOnce = <A>(call: Call<A>, url: string, body: string | undefined) => {
    const write = call.method === "POST"
    const path = new URL(url).pathname
    const unknownSuffix = write ? " (outcome unknown: the write was not repeated)" : ""
    return Effect.all([tokens.token, Clock.currentTimeMillis]).pipe(Effect.flatMap(([token, nowMs]) => {
      const secret = Redacted.value(token)
      const failure = redactedError([secret, `Bearer ${secret}`])
      return Effect.tryPromise({
        try: async (signal): Promise<unknown> => {
          const headers: Record<string, string> = {
            accept: "application/json",
            authorization: `Bearer ${secret}`,
            "user-agent": "smithers-integrations"
          }
          if (body !== undefined) headers["content-type"] = "application/json"
          const response = await fetch(url, {
            method: call.method,
            headers,
            signal,
            ...(body === undefined ? {} : { body })
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
          if (response.ok) return json
          const status = response.status
          const rateLimited = status === 429
          const serverError = status >= 500
          const outcomeUnknown = serverError && write
          const wait = rateLimited ? retryAfterMs(response.headers, nowMs) : null
          throw failure(
            status === 401 || status === 403 ? "permission-denied" : "delivery-failed",
            `X ${call.operation} failed: ${call.method} ${path} -> ${status} ${xError(json) || response.statusText}${
              outcomeUnknown ? unknownSuffix : ""
            }`,
            {
              status,
              method: call.method,
              path,
              operation: call.operation,
              retryable: rateLimited || (serverError && !write),
              rateLimited,
              outcomeUnknown,
              unauthorized: status === 401,
              retryAfterMs: wait,
              rateLimitRemaining: response.headers.get("x-rate-limit-remaining")
            }
          )
        },
        catch: (cause) =>
          cause instanceof IntegrationError ? cause : failure(
            "delivery-failed",
            `X ${call.operation} failed: ${call.method} ${path} - ${String(cause)}${unknownSuffix}`,
            { method: call.method, path, operation: call.operation, retryable: !write, outcomeUnknown: write },
            { cause }
          )
      }).pipe(
        // The deadline spans headers and body. On a write it is the same
        // ambiguity as a dropped connection, so it is not repeated.
        Effect.timeoutOrElse({
          duration: requestTimeout,
          orElse: () =>
            Effect.fail(failure(
              "delivery-failed",
              `X ${call.operation} timed out after ${requestTimeoutMs} ms: ${call.method} ${path}${unknownSuffix}`,
              {
                method: call.method,
                path,
                operation: call.operation,
                retryable: !write,
                outcomeUnknown: write,
                timedOut: true
              }
            ))
        }),
        Effect.flatMap((json) =>
          (Schema.decodeUnknownEffect(call.schema)(json) as Effect.Effect<A, unknown>).pipe(
            Effect.mapError((cause) =>
              failure(
                "decode-failed",
                `X ${call.operation} response for ${call.method} ${path} did not match its schema.${
                  write ? " The write was accepted, but its identity is unknown; it was not repeated." : ""
                }`,
                { method: call.method, path, operation: call.operation, retryable: false, outcomeUnknown: write },
                { cause }
              )
            )
          )
        )
      )
    }))
  }

  const waitOf = (error: unknown): number => {
    const wait = (error as IntegrationError).details?.["retryAfterMs"]
    return typeof wait === "number" ? wait : 0
  }

  const schedule = Schedule.exponential("250 millis").pipe(
    Schedule.upTo({ times: resolved.maxRetries }),
    Schedule.while(({ input }) => isRetryable(input) && waitOf(input) <= maxRetryAfterMs),
    Schedule.passthrough,
    Schedule.addDelay(({ input }) => Effect.succeed(Duration.millis(waitOf(input))))
  )

  const send = <A>(call: Call<A>): Effect.Effect<A, IntegrationError> =>
    Effect.gen(function*() {
      const denied = connection === undefined ? undefined : refusal(connection.scopes, call.operation)
      if (denied !== undefined) return yield* Effect.fail(denied)
      const url = buildUrl(call.path, call.query)
      const body = call.body === undefined ? undefined : JSON.stringify(call.body)
      const attempt = attemptOnce(call, url, body)
      // A 401 is a refusal, so repeating it with a fresh token is safe for a
      // write too. Only once: a second 401 means the grant itself is gone.
      const refreshed = attempt.pipe(
        Effect.catchIf(
          (error) => error.details?.["unauthorized"] === true,
          () => Effect.andThen(tokens.invalidate, attempt)
        )
      )
      return yield* refreshed.pipe(Effect.retry(schedule))
    }).pipe(Effect.withSpan("XClient.request", { attributes: { "x.operation": call.operation } }))

  const me = Effect.map(
    send({ method: "GET", path: "/users/me", operation: "read", schema: Me, query: { "user.fields": USER_FIELDS } }),
    (answer) => answer.data
  )

  const timeline = (segment: "mentions" | "tweets") => (userId: string, options: TimelineOptions = {}) =>
    Effect.gen(function*() {
      const id = yield* requireId("user", userId)
      const maxResults = yield* bounded(options.maxResults, 5)
      return yield* send({
        method: "GET",
        path: `/users/${id}/${segment}`,
        operation: "read",
        schema: TimelinePage,
        query: {
          since_id: options.sinceId,
          pagination_token: options.paginationToken,
          start_time: options.startTime,
          max_results: maxResults,
          "tweet.fields": TWEET_FIELDS,
          expansions: "author_id",
          "user.fields": USER_FIELDS
        }
      })
    })

  const eventQuery = (options: DmEventsOptions, maxResults: number | undefined): Query => ({
    pagination_token: options.paginationToken,
    max_results: maxResults,
    event_types: "MessageCreate",
    "dm_event.fields": DM_EVENT_FIELDS,
    expansions: "sender_id",
    "user.fields": USER_FIELDS
  })

  const dmEvents: XClient["dmEvents"] = (options = {}) =>
    Effect.flatMap(bounded(options.maxResults, 1), (maxResults) =>
      send({
        method: "GET",
        path: "/dm_events",
        operation: "dm-read",
        schema: DmEventsPage,
        query: eventQuery(options, maxResults)
      }))

  const conversationEvents: XClient["conversationEvents"] = (participantId, options = {}) =>
    Effect.gen(function*() {
      const id = yield* requireId("participant", participantId)
      const maxResults = yield* bounded(options.maxResults, 1)
      return yield* send({
        method: "GET",
        path: `/dm_conversations/with/${id}/dm_events`,
        operation: "dm-read",
        schema: DmEventsPage,
        query: eventQuery(options, maxResults)
      })
    })

  const createTweet: XClient["createTweet"] = (request) =>
    Effect.flatMap(
      request.replyToTweetId === undefined
        ? Effect.succeed({})
        : Effect.map(requireId("reply", request.replyToTweetId), (id) => ({ reply: { in_reply_to_tweet_id: id } })),
      (reply) =>
        send({
          method: "POST",
          path: "/tweets",
          operation: "post",
          schema: CreatedTweet,
          body: { text: request.text, ...reply }
        })
    )

  const sendDirectMessage: XClient["sendDirectMessage"] = (participantId, text) =>
    Effect.flatMap(requireId("participant", participantId), (id) =>
      send({
        method: "POST",
        path: `/dm_conversations/with/${id}/messages`,
        operation: "dm-write",
        schema: SentDirectMessage,
        body: { text }
      }))

  return XClient.of({
    connectionId: connection?.id,
    me,
    mentions: timeline("mentions"),
    userTweets: timeline("tweets"),
    dmEvents,
    conversationEvents,
    createTweet,
    sendDirectMessage
  })
}

/**
 * Layer for a client bound to `config`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  config: XConfig,
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): Layer.Layer<XClient, IntegrationError> =>
  // `make` throws only `invalid-config`, which becomes a typed layer failure.
  Layer.effect(XClient)(Effect.try({ try: () => make(config, env), catch: (error) => error as IntegrationError }))
