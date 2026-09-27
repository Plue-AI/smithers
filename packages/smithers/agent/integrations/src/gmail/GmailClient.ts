/**
 * The Gmail REST client.
 *
 * It covers the calls a mailbox connector needs and nothing else: the
 * profile, `users.messages.list` and `users.messages.get` (`metadata` or
 * `full`), `users.history.list`, `users.drafts.create` and
 * `users.messages.send`. Four behaviors are why it exists rather than a bare
 * `fetch`:
 *
 * - **Grant first.** When a `Connection` is bound, each call checks the
 *   connection's scopes against `Capabilities` before anything is sent, and an
 *   operation the grant does not cover fails as `permission-denied`.
 * - **Rate limits.** A 429, or a 403 whose reason is `rateLimitExceeded` or
 *   `userRateLimitExceeded`, was refused rather than performed, so it is
 *   retried for every call, after the server's `Retry-After` when it sent one.
 *   A wait longer than `maxRetryAfter` is not sat out in process: the call
 *   fails at once as retryable and carries `retryAfterMs`.
 * - **Ambiguous writes.** A 5xx, a timeout or a dropped connection on a read
 *   is retried. On `drafts.create` or `messages.send` Google may have acted
 *   and lost the answer, so the client reports `outcomeUnknown` and never
 *   repeats the request. A 2xx whose body does not decode is reported the same
 *   way: the write happened, but its identity is unknown.
 * - **Tokens.** Each attempt asks the `AccessTokenSource` for the current
 *   token. A 401 discards it and repeats the request once with a fresh one,
 *   which is safe for a write too, because Google refused the first; a second
 *   401 is `permission-denied`. The token reaches the `Authorization` header
 *   and nothing else, and errors redact it if a peer echoes it.
 *
 * Every message, draft and thread id is validated before it becomes a path
 * segment, so provider data cannot walk the token-bearing request to another
 * endpoint.
 *
 * @since 1.0.0
 */

import { Context, Duration, Effect, Layer, Option, Redacted, Schedule, Schema } from "effect"
import { IntegrationError, isRetryable } from "../core/IntegrationError.ts"
import { redactedError } from "../core/RedactedError.ts"
import * as Environment from "../Environment.ts"
import { type Operation, refusal } from "./Capabilities.ts"
import { type GmailConfig, PROVIDER, resolve } from "./Config.ts"

/**
 * A Gmail message, thread or draft id.
 *
 * @category schemas
 * @since 1.0.0
 */
export const GmailId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/))

/**
 * A mailbox history id: an unsigned decimal integer.
 *
 * @category schemas
 * @since 1.0.0
 */
export const HistoryId = Schema.String.check(Schema.isPattern(/^[0-9]{1,20}$/))

/**
 * A message's identity in a listing.
 *
 * @category schemas
 * @since 1.0.0
 */
export const MessageRef = Schema.Struct({
  id: GmailId,
  threadId: GmailId
})

/**
 * One page of `users.messages.list`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const MessageList = Schema.Struct({
  messages: Schema.optionalKey(Schema.Array(MessageRef)),
  nextPageToken: Schema.optionalKey(Schema.String),
  resultSizeEstimate: Schema.optionalKey(Schema.Number)
})

/**
 * One page of `users.messages.list`.
 *
 * @category models
 * @since 1.0.0
 */
export type MessageList = typeof MessageList.Type

/**
 * One message header.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Header = Schema.Struct({
  name: Schema.String,
  value: Schema.String
})

/**
 * The body of one MIME part. `data` is base64url when Google inlined it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const PartBody = Schema.Struct({
  size: Schema.optionalKey(Schema.Number),
  data: Schema.optionalKey(Schema.String),
  attachmentId: Schema.optionalKey(Schema.String)
})

/**
 * One MIME part of a message, with its children.
 *
 * @category models
 * @since 1.0.0
 */
export interface MessagePart {
  readonly partId?: string
  readonly mimeType?: string
  readonly filename?: string
  readonly headers?: ReadonlyArray<typeof Header.Type>
  readonly body?: typeof PartBody.Type
  readonly parts?: ReadonlyArray<MessagePart>
}

/**
 * One MIME part of a message, with its children.
 *
 * @category schemas
 * @since 1.0.0
 */
export const MessagePart: Schema.Codec<MessagePart> = Schema.Struct({
  partId: Schema.optionalKey(Schema.String),
  mimeType: Schema.optionalKey(Schema.String),
  filename: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Array(Header)),
  body: Schema.optionalKey(PartBody),
  parts: Schema.optionalKey(Schema.Array(Schema.suspend((): Schema.Codec<MessagePart> => MessagePart)))
})

/**
 * A message as `users.messages.get` returns it.
 *
 * `internalDate` is Google's receipt time in Unix milliseconds, as a string.
 * `payload` carries headers only in the `metadata` format, and the whole MIME
 * tree in `full`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Message = Schema.Struct({
  id: GmailId,
  threadId: GmailId,
  labelIds: Schema.optionalKey(Schema.Array(Schema.String)),
  snippet: Schema.optionalKey(Schema.String),
  historyId: Schema.optionalKey(HistoryId),
  internalDate: Schema.optionalKey(Schema.String),
  sizeEstimate: Schema.optionalKey(Schema.Number),
  payload: Schema.optionalKey(MessagePart)
})

/**
 * A message as `users.messages.get` returns it.
 *
 * @category models
 * @since 1.0.0
 */
export type Message = typeof Message.Type

/**
 * A message named by a history record.
 *
 * @category schemas
 * @since 1.0.0
 */
export const HistoryMessage = Schema.Struct({
  id: GmailId,
  threadId: Schema.optionalKey(GmailId),
  labelIds: Schema.optionalKey(Schema.Array(Schema.String))
})

const HistoryChange = Schema.Struct({
  message: HistoryMessage,
  labelIds: Schema.optionalKey(Schema.Array(Schema.String))
})

/**
 * One mailbox change.
 *
 * @category schemas
 * @since 1.0.0
 */
export const HistoryRecord = Schema.Struct({
  id: HistoryId,
  messagesAdded: Schema.optionalKey(Schema.Array(HistoryChange)),
  messagesDeleted: Schema.optionalKey(Schema.Array(HistoryChange)),
  labelsAdded: Schema.optionalKey(Schema.Array(HistoryChange)),
  labelsRemoved: Schema.optionalKey(Schema.Array(HistoryChange))
})

/**
 * One mailbox change.
 *
 * @category models
 * @since 1.0.0
 */
export type HistoryRecord = typeof HistoryRecord.Type

/**
 * One page of `users.history.list`. `historyId` is the mailbox's current
 * history id.
 *
 * @category schemas
 * @since 1.0.0
 */
export const HistoryList = Schema.Struct({
  history: Schema.optionalKey(Schema.Array(HistoryRecord)),
  nextPageToken: Schema.optionalKey(Schema.String),
  historyId: HistoryId
})

/**
 * One page of `users.history.list`.
 *
 * @category models
 * @since 1.0.0
 */
export type HistoryList = typeof HistoryList.Type

/**
 * The mailbox profile. `historyId` is where a later history read starts.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Profile = Schema.Struct({
  emailAddress: Schema.String,
  messagesTotal: Schema.optionalKey(Schema.Number),
  threadsTotal: Schema.optionalKey(Schema.Number),
  historyId: HistoryId
})

/**
 * The mailbox profile.
 *
 * @category models
 * @since 1.0.0
 */
export type Profile = typeof Profile.Type

/**
 * A message Gmail stored as sent, or as a draft.
 *
 * @category schemas
 * @since 1.0.0
 */
export const StoredMessage = Schema.Struct({
  id: GmailId,
  threadId: Schema.optionalKey(GmailId),
  labelIds: Schema.optionalKey(Schema.Array(Schema.String))
})

/**
 * A message Gmail stored as sent, or as a draft.
 *
 * @category models
 * @since 1.0.0
 */
export type StoredMessage = typeof StoredMessage.Type

/**
 * A created draft.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Draft = Schema.Struct({
  id: GmailId,
  message: StoredMessage
})

/**
 * A created draft.
 *
 * @category models
 * @since 1.0.0
 */
export type Draft = typeof Draft.Type

/**
 * The largest page `messages.list` and `history.list` accept.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_PAGE_SIZE = 500

/**
 * What {@link GmailClient.listMessages} filters and pages by.
 *
 * @category models
 * @since 1.0.0
 */
export interface ListMessagesOptions {
  /** A Gmail search query. Needs the `read` operation. */
  readonly q?: string | undefined
  readonly labelIds?: ReadonlyArray<string> | undefined
  readonly pageToken?: string | undefined
  /** Between 1 and {@link MAX_PAGE_SIZE}. */
  readonly maxResults?: number | undefined
  readonly includeSpamTrash?: boolean | undefined
}

/**
 * How much of a message to read. `full` needs the `read` operation.
 *
 * @category models
 * @since 1.0.0
 */
export type MessageFormat = "minimal" | "metadata" | "full"

/**
 * What {@link GmailClient.getMessage} reads.
 *
 * @category models
 * @since 1.0.0
 */
export interface GetMessageOptions {
  /** Defaults to `metadata`. */
  readonly format?: MessageFormat | undefined
  /** In `metadata` format, the headers to include. */
  readonly metadataHeaders?: ReadonlyArray<string> | undefined
}

/**
 * A kind of mailbox change.
 *
 * @category models
 * @since 1.0.0
 */
export type HistoryType = "messageAdded" | "messageDeleted" | "labelAdded" | "labelRemoved"

/**
 * What {@link GmailClient.listHistory} reads.
 *
 * @category models
 * @since 1.0.0
 */
export interface ListHistoryOptions {
  readonly startHistoryId: string
  readonly pageToken?: string | undefined
  /** Between 1 and {@link MAX_PAGE_SIZE}. */
  readonly maxResults?: number | undefined
  readonly labelId?: string | undefined
  readonly historyTypes?: ReadonlyArray<HistoryType> | undefined
}

/**
 * The client service.
 *
 * @category services
 * @since 1.0.0
 */
export interface GmailClient {
  /** The connection the client acts for, when one is bound. */
  readonly connectionId: string | undefined
  /** The mailbox every call addresses. */
  readonly userId: string
  /** `users.getProfile`. */
  readonly getProfile: Effect.Effect<Profile, IntegrationError>
  /** `users.messages.list`: one page. */
  readonly listMessages: (options?: ListMessagesOptions) => Effect.Effect<MessageList, IntegrationError>
  /** `users.messages.get`. */
  readonly getMessage: (id: string, options?: GetMessageOptions) => Effect.Effect<Message, IntegrationError>
  /** `users.history.list`: one page. A stale start id fails with `details.status` 404. */
  readonly listHistory: (options: ListHistoryOptions) => Effect.Effect<HistoryList, IntegrationError>
  /** `users.drafts.create` from an RFC 2822 message. Never repeated after an ambiguous failure. */
  readonly createDraft: (
    rfc2822: string,
    options?: { readonly threadId?: string | undefined }
  ) => Effect.Effect<Draft, IntegrationError>
  /** `users.messages.send` of an RFC 2822 message. Never repeated after an ambiguous failure. */
  readonly sendMessage: (
    rfc2822: string,
    options?: { readonly threadId?: string | undefined }
  ) => Effect.Effect<StoredMessage, IntegrationError>
}

/**
 * Service tag for the Gmail client.
 *
 * @category services
 * @since 1.0.0
 */
export const GmailClient: Context.Service<GmailClient, GmailClient> = Context.Service(
  "@smthrs/integrations/GmailClient"
)

/**
 * Google's per-error reasons that mean "slow down" on a 403.
 *
 * @category constants
 * @since 1.0.0
 */
export const RATE_LIMIT_REASONS: ReadonlyArray<string> = ["rateLimitExceeded", "userRateLimitExceeded"]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The reasons and message in a Google error body, `{ error: { message,
 * status, errors: [{ reason }] } }`. Anything else yields none.
 *
 * @category getters
 * @since 1.0.0
 */
export const googleError = (body: unknown): { readonly reasons: ReadonlyArray<string>; readonly message: string } => {
  const error = isRecord(body) && isRecord(body["error"]) ? body["error"] : {}
  const errors = Array.isArray(error["errors"]) ? error["errors"] : []
  const reasons = errors.flatMap((entry) =>
    isRecord(entry) && typeof entry["reason"] === "string" ? [entry["reason"]] : []
  )
  if (typeof error["status"] === "string") reasons.push(error["status"])
  return { reasons, message: typeof error["message"] === "string" ? error["message"].slice(0, 300) : "" }
}

/**
 * The wait a `Retry-After` header asks for, in milliseconds, or `null`.
 *
 * @category getters
 * @since 1.0.0
 */
export const retryAfterMs = (headers: Headers): number | null => {
  const value = headers.get("retry-after")
  const seconds = value === null || value.trim() === "" ? Number.NaN : Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null
}

type Query = Readonly<Record<string, string | number | boolean | ReadonlyArray<string> | undefined>>

interface Call<A> {
  readonly method: "GET" | "POST"
  readonly path: string
  readonly operation: Operation
  readonly schema: Schema.Codec<A>
  readonly query?: Query | undefined
  readonly body?: unknown
}

const USER_ID = /^(?:me|[^\s/?#@]+@[^\s/?#@]+)$/

const invalid = (message: string, details: Record<string, unknown>): IntegrationError =>
  new IntegrationError("invalid-config", message, { ...details, retryable: false })

const positiveDuration = (name: string, input: Duration.Input, allowZero: boolean): Duration.Duration => {
  const duration = Option.getOrUndefined(Duration.fromInput(input))
  const millis = duration === undefined || !Duration.isFinite(duration) ? Number.NaN : Duration.toMillis(duration)
  if (!(millis > 0 || (allowZero && millis === 0))) {
    throw invalid(`Gmail ${name} must be a finite${allowZero ? ", non-negative" : ", positive"} duration.`, {
      [name]: String(input)
    })
  }
  return duration as Duration.Duration
}

const bounded = (name: string, value: number | undefined): Effect.Effect<number | undefined, IntegrationError> =>
  value === undefined || (Number.isSafeInteger(value) && value >= 1 && value <= MAX_PAGE_SIZE)
    ? Effect.succeed(value)
    : Effect.fail(invalid(`Gmail ${name} must be an integer between 1 and ${MAX_PAGE_SIZE}.`, { [name]: value }))

const requireId = (kind: string, id: string): Effect.Effect<string, IntegrationError> =>
  Schema.is(GmailId)(id)
    ? Effect.succeed(id)
    : Effect.fail(invalid(`Gmail ${kind} id is not a Gmail id.`, { kind }))

/**
 * Builds a client bound to `config`.
 *
 * Throws `invalid-config` for a connection to another provider, an origin
 * that is not HTTP(S), a malformed mailbox, or a retry budget, deadline or
 * rate-limit cap out of range.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  config: GmailConfig,
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): GmailClient => {
  const resolved = resolve(config, env)
  const connection = resolved.connection
  if (connection !== undefined && connection.provider !== PROVIDER) {
    throw invalid(`A Gmail client cannot act for a "${connection.provider}" connection.`, {
      connectionId: connection.id,
      provider: connection.provider
    })
  }
  const baseUrl = resolved.apiBaseUrl.replace(/\/+$/, "")
  const parsed = URL.canParse(baseUrl) ? new URL(baseUrl) : undefined
  if (parsed === undefined || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw invalid("Gmail apiBaseUrl must be an HTTP or HTTPS URL.", { apiBaseUrl: resolved.apiBaseUrl })
  }
  if (!USER_ID.test(resolved.userId)) {
    throw invalid("Gmail userId must be \"me\" or an email address.", { userId: resolved.userId })
  }
  if (!Number.isSafeInteger(resolved.maxRetries) || resolved.maxRetries < 0 || resolved.maxRetries > 10) {
    throw invalid("Gmail maxRetries must be an integer between 0 and 10.", { maxRetries: resolved.maxRetries })
  }
  const requestTimeout = positiveDuration("requestTimeout", resolved.requestTimeout, false)
  const requestTimeoutMs = Duration.toMillis(requestTimeout)
  const maxRetryAfterMs = Duration.toMillis(positiveDuration("maxRetryAfter", resolved.maxRetryAfter, true))
  const tokens = resolved.token
  const mailbox = `/gmail/v1/users/${encodeURIComponent(resolved.userId)}`

  const buildUrl = (path: string, query: Query | undefined): string => {
    const url = new URL(`${baseUrl}${mailbox}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue
      if (Array.isArray(value)) { for (const item of value) url.searchParams.append(key, item) }
      else url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  const attemptOnce = <A>(call: Call<A>, url: string, body: string | undefined) => {
    const write = call.method === "POST"
    const path = new URL(url).pathname
    const unknownSuffix = write ? " (outcome unknown: the write was not repeated)" : ""
    return tokens.token.pipe(Effect.flatMap((token) => {
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
          const provider = googleError(json)
          const rateLimited = status === 429 ||
            (status === 403 && provider.reasons.some((reason) => RATE_LIMIT_REASONS.includes(reason)))
          const serverError = status >= 500
          const outcomeUnknown = serverError && write
          const reason = rateLimited
            ? "delivery-failed"
            : status === 401 || status === 403
            ? "permission-denied"
            : "delivery-failed"
          const wait = rateLimited ? retryAfterMs(response.headers) : null
          throw failure(
            reason,
            `Gmail ${call.operation} failed: ${call.method} ${path} -> ${status} ${
              provider.message || response.statusText
            }${outcomeUnknown ? unknownSuffix : ""}`,
            {
              status,
              method: call.method,
              path,
              operation: call.operation,
              providerReasons: provider.reasons,
              retryable: rateLimited || (serverError && !write),
              rateLimited,
              outcomeUnknown,
              unauthorized: status === 401,
              retryAfterMs: wait
            }
          )
        },
        catch: (cause) =>
          cause instanceof IntegrationError ? cause : failure(
            "delivery-failed",
            `Gmail ${call.operation} failed: ${call.method} ${path} - ${String(cause)}${unknownSuffix}`,
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
              `Gmail ${call.operation} timed out after ${requestTimeoutMs} ms: ${call.method} ${path}${unknownSuffix}`,
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
                `Gmail ${call.operation} response for ${call.method} ${path} did not match its schema.${
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
    }).pipe(Effect.withSpan("GmailClient.request", { attributes: { "gmail.operation": call.operation } }))

  const getProfile = send({ method: "GET", path: "/profile", operation: "metadata", schema: Profile })

  const listMessages: GmailClient["listMessages"] = (options = {}) =>
    Effect.flatMap(bounded("maxResults", options.maxResults), (maxResults) =>
      send({
        method: "GET",
        path: "/messages",
        operation: options.q === undefined ? "metadata" : "read",
        schema: MessageList,
        query: {
          q: options.q,
          labelIds: options.labelIds,
          pageToken: options.pageToken,
          maxResults,
          includeSpamTrash: options.includeSpamTrash
        }
      }))

  const getMessage: GmailClient["getMessage"] = (id, options = {}) =>
    Effect.flatMap(requireId("message", id), (valid) => {
      const format = options.format ?? "metadata"
      return send({
        method: "GET",
        path: `/messages/${valid}`,
        operation: format === "full" ? "read" : "metadata",
        schema: Message,
        query: { format, metadataHeaders: format === "metadata" ? options.metadataHeaders : undefined }
      })
    })

  const listHistory: GmailClient["listHistory"] = (options) =>
    Effect.gen(function*() {
      if (!Schema.is(HistoryId)(options.startHistoryId)) {
        return yield* Effect.fail(invalid("Gmail startHistoryId must be a history id.", {}))
      }
      const maxResults = yield* bounded("maxResults", options.maxResults)
      return yield* send({
        method: "GET",
        path: "/history",
        operation: "metadata",
        schema: HistoryList,
        query: {
          startHistoryId: options.startHistoryId,
          pageToken: options.pageToken,
          maxResults,
          labelId: options.labelId,
          historyTypes: options.historyTypes
        }
      })
    })

  const threadOf = (threadId: string | undefined) =>
    threadId === undefined
      ? Effect.succeed({})
      : Effect.map(requireId("thread", threadId), (valid) => ({ threadId: valid }))

  const raw = (rfc2822: string): string => Buffer.from(rfc2822, "utf8").toString("base64url")

  const createDraft: GmailClient["createDraft"] = (rfc2822, options = {}) =>
    Effect.flatMap(threadOf(options.threadId), (thread) =>
      send({
        method: "POST",
        path: "/drafts",
        operation: "draft",
        schema: Draft,
        body: { message: { raw: raw(rfc2822), ...thread } }
      }))

  const sendMessage: GmailClient["sendMessage"] = (rfc2822, options = {}) =>
    Effect.flatMap(threadOf(options.threadId), (thread) =>
      send({
        method: "POST",
        path: "/messages/send",
        operation: "send",
        schema: StoredMessage,
        body: { raw: raw(rfc2822), ...thread }
      }))

  return GmailClient.of({
    connectionId: connection?.id,
    userId: resolved.userId,
    getProfile,
    listMessages,
    getMessage,
    listHistory,
    createDraft,
    sendMessage
  })
}

/**
 * Layer for a client bound to `config`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  config: GmailConfig,
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): Layer.Layer<GmailClient, IntegrationError> =>
  // `make` throws only `invalid-config`, which becomes a typed layer failure.
  Layer.effect(GmailClient)(Effect.try({ try: () => make(config, env), catch: (error) => error as IntegrationError }))
