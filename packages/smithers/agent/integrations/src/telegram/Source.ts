/**
 * The Telegram `getUpdates` long-poll source.
 *
 * Bot API semantics: the offset is the last `update_id` plus one, the server
 * holds the request open for `timeout` seconds, and `allowed_updates` filters
 * what comes back. Confirming an offset is what tells Telegram to forget those
 * updates, so the cursor is committed **after** the handler has processed the
 * batch. A process that dies mid-batch re-polls it; a redelivery is dropped
 * downstream on the event's dedupe key.
 *
 * Each delivered event carries exactly one correlation. A message in a forum
 * topic therefore emits two events, chat-scoped and thread-scoped, with
 * distinct dedupe keys, so both a chat listener and a thread listener wake and
 * neither can be double-signaled by one redelivery.
 *
 * @since 1.0.0
 */

import { Duration, Effect, Schedule } from "effect"
import type { ExternalEvent } from "../core/ExternalEvent.ts"
import { IntegrationError, isIntegrationError } from "../core/IntegrationError.ts"
import * as SignalName from "../core/SignalName.ts"
import * as CoreSource from "../core/Source.ts"
import * as Environment from "../Environment.ts"
import type { TelegramConfig } from "./Config.ts"
import { isTelegramApiError, make as makeClient, type TelegramClient } from "./TelegramClient.ts"

/**
 * The service segment of every Telegram signal name.
 *
 * @category constants
 * @since 1.0.0
 */
export const SERVICE = "telegram"

/**
 * The signal name for a new message.
 *
 * @category constants
 * @since 1.0.0
 */
export const MESSAGE_EVENT = SignalName.eventName(SERVICE, "message")

/**
 * The signal name for an edited message.
 *
 * @category constants
 * @since 1.0.0
 */
export const EDITED_MESSAGE_EVENT = SignalName.eventName(SERVICE, "edited_message")

/**
 * The signal name for a reaction change. Telegram sends it only to a chat
 * administrator bot that lists `message_reaction` in `allowed_updates`.
 *
 * @category constants
 * @since 1.0.0
 */
export const MESSAGE_REACTION_EVENT = SignalName.eventName(SERVICE, "message_reaction")

/**
 * The signal name for an inline-keyboard press.
 *
 * @category constants
 * @since 1.0.0
 */
export const CALLBACK_QUERY_EVENT = SignalName.eventName(SERVICE, "callback_query")

/**
 * The signal name for structured Mini App data.
 *
 * @category constants
 * @since 1.0.0
 */
export const WEB_APP_DATA_EVENT = SignalName.eventName(SERVICE, "web_app_data")

const DEFAULT_ALLOWED_UPDATES = ["message", "edited_message", "callback_query"]
const DEFAULT_POLL_TIMEOUT_SECONDS = 25
const pollRetryBase = Duration.millis(250)
const pollRetryCap = Duration.seconds(30)

// A network failure, a timeout, an exhausted 429, or a Bot API 5xx is worth
// another poll. A 4xx such as 401 (revoked token) never heals on its own.
const isTransientPollCause = (cause: unknown): boolean => {
  if (!isTelegramApiError(cause)) return true
  const code = cause.errorCode
  return code === null || code === 429 || code >= 500
}

const isRetryablePollFailure = (error: unknown): boolean =>
  isIntegrationError(error) && error.reason === "poll-failed" && error.details?.["retryable"] === true

/**
 * The correlation for a chat.
 *
 * @category constructors
 * @since 1.0.0
 */
export const chatCorrelationId = (chatId: number | string): string => `chat:${chatId}`

/**
 * The correlation for a forum-topic or reply thread.
 *
 * @category constructors
 * @since 1.0.0
 */
export const threadCorrelationId = (chatId: number | string, threadId: number | string): string =>
  `chat:${chatId}:thread:${threadId}`

/**
 * Maps one `getUpdates` Update onto events.
 *
 * @category constructors
 * @since 1.0.0
 */
export const updateToEvents = (
  source: string,
  update: Record<string, any>,
  receivedAtMs: number
): ReadonlyArray<ExternalEvent> => {
  const updateId = update["update_id"]
  const events: Array<ExternalEvent> = []
  // Telegram scopes `update_id` per bot, so two configured sources routinely
  // produce the same number for unrelated updates. The key carries the source
  // as a length prefix rather than a delimiter, so a source id containing a
  // colon cannot forge another source's key. `SignalName.toNotification` uses
  // this key as the durable notification id, so a collision here silently
  // drops the second bot's event as a duplicate.
  const scope = `update:${source.length}:${source}:`
  const pushMessage = (eventName: string, message: Record<string, any>, keySuffix = "") => {
    const chatId = message?.["chat"]?.id
    if (chatId == null) return
    events.push({
      source,
      eventName,
      correlationId: chatCorrelationId(chatId),
      payload: message,
      dedupeKey: `${scope}${updateId}${keySuffix}`,
      receivedAtMs
    })
    // A thread-scoped variant whenever the message carries a thread id, so a
    // listener parked on the topic wakes as well as one parked on the chat.
    if (message["message_thread_id"] != null) {
      events.push({
        source,
        eventName,
        correlationId: threadCorrelationId(chatId, message["message_thread_id"]),
        payload: message,
        dedupeKey: `${scope}${updateId}${keySuffix}:thread`,
        receivedAtMs
      })
    }
  }
  if (update["message"] !== undefined) {
    pushMessage(MESSAGE_EVENT, update["message"])
    // A reply-keyboard Mini App's `sendData` arrives as an ordinary message
    // carrying `web_app_data`. Emit a separately deduped event so a run can
    // wait for structured Mini App data specifically.
    if (update["message"]["web_app_data"] !== undefined) {
      pushMessage(WEB_APP_DATA_EVENT, update["message"], ":webappdata")
    }
  } else if (update["edited_message"] !== undefined) {
    pushMessage(EDITED_MESSAGE_EVENT, update["edited_message"])
  } else if (update["message_reaction"] !== undefined) {
    // Reaction updates carry no topic, so they are chat-scoped only.
    pushMessage(MESSAGE_REACTION_EVENT, update["message_reaction"])
  } else if (update["callback_query"] !== undefined) {
    const callbackQuery = update["callback_query"]
    const chatId = callbackQuery?.["message"]?.chat?.id
    events.push({
      source,
      eventName: CALLBACK_QUERY_EVENT,
      correlationId: chatId == null ? null : chatCorrelationId(chatId),
      payload: callbackQuery,
      dedupeKey: `${scope}${updateId}`,
      receivedAtMs
    })
    const threadId = callbackQuery?.["message"]?.message_thread_id
    if (chatId != null && threadId != null) {
      events.push({
        source,
        eventName: CALLBACK_QUERY_EVENT,
        correlationId: threadCorrelationId(chatId, threadId),
        payload: callbackQuery,
        dedupeKey: `${scope}${updateId}:thread`,
        receivedAtMs
      })
    }
  }
  return events
}

/**
 * The idempotency key for one `getUpdates` update.
 *
 * A long poll has no `Channels.ingest` in front of it, but a host that routes
 * these events through the control plane needs the same delivery identity the
 * webhook providers supply. It is the event's dedupe key, which is already
 * scoped to the source, so two configured bots cannot collide.
 *
 * @category getters
 * @since 1.0.0
 */
export const idempotencyKey = (event: ExternalEvent): string => event.dedupeKey

const updateChatId = (update: Record<string, any>): number | string | null =>
  update["message"]?.chat?.id ?? update["edited_message"]?.chat?.id ??
    update["message_reaction"]?.chat?.id ?? update["callback_query"]?.message?.chat?.id ?? null

/**
 * One poll turn's result: the core `Source.Batch`.
 *
 * `cursor` is the offset to commit once `events` are handled. It is absent
 * when the poll returned nothing, which leaves the stored offset alone.
 *
 * @category models
 * @since 1.0.0
 */
export type Batch = CoreSource.Batch

/**
 * What the source needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options extends Partial<TelegramConfig> {
  /** The source id, which is also the cursor key and the dedupe scope. Defaults to `telegram`. */
  readonly sourceId?: string | undefined
  /** How long the Bot API holds a poll open, in seconds. Defaults to 25. */
  readonly pollTimeoutSeconds?: number | undefined
  /** `allowed_updates`. Defaults to message, edited_message, and callback_query. */
  readonly allowedUpdates?: ReadonlyArray<string> | undefined
  /**
   * Required and non-empty. Updates from other chats are dropped, and so is an update whose
   * chat this source cannot determine: an allowlist that admits what it cannot
   * classify is not one. A press on an inline keyboard whose message is
   * inaccessible is exactly that case. The offset still advances past every
   * dropped update once the rest of the batch is handled.
   */
  readonly allowedChatIds: ReadonlyArray<number | string>
  /** An already-built client, for a caller that has one. */
  readonly client?: TelegramClient | undefined
}

/**
 * A source bound to one bot: the core `Source.Source`.
 *
 * `poll` is one turn against the stored offset and commits nothing. `run`
 * reads the cursor, polls, hands the batch to `onBatch`, and commits the
 * offset only after `onBatch` succeeds. The default schedule polls forever
 * with 250 milliseconds between turns. A transient `getUpdates` failure is
 * logged and retried with capped exponential backoff; a permanent one fails
 * `run`. A caller-supplied finite schedule ends polling normally with
 * `undefined`.
 *
 * @category services
 * @since 1.0.0
 */
export type Source = CoreSource.Source

/**
 * Builds a long-poll source.
 *
 * `env` is the fallback source for the bot token, the same shape the clients
 * take: `Telegram.Source.make({ allowedChatIds: [chatId] })` with `SMITHERS_TELEGRAM_BOT_TOKEN` exported
 * works, and passing an explicit `env` replaces the ambient environment rather
 * than layering over it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  options: Options,
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): Source => {
  const sourceId = options?.sourceId ?? SERVICE
  // The source id is every event's `source` and the scope of every dedupe key.
  // An empty one produces events `ExternalEvent` refuses and keys two sources
  // could share, so it is refused where it is configured.
  if (typeof sourceId !== "string" || sourceId.trim().length === 0 || sourceId.trim() !== sourceId) {
    throw new IntegrationError(
      "invalid-config",
      "Telegram source id must be a non-empty string with no surrounding whitespace.",
      { sourceId }
    )
  }
  if (options?.allowedChatIds === undefined || options.allowedChatIds.length === 0) {
    throw new IntegrationError(
      "invalid-config",
      "Telegram allowedChatIds must be a non-empty list before polling can start.",
      { sourceId }
    )
  }
  const pollTimeoutSeconds = options.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS
  const allowedUpdates = options.allowedUpdates ?? DEFAULT_ALLOWED_UPDATES
  const allowedChats = new Set(options.allowedChatIds.map((id) => String(id)))
  const client = options.client ?? makeClient({
    ...(options.botToken === undefined ? {} : { botToken: options.botToken }),
    apiBaseUrl: options.apiBaseUrl,
    maxRateLimitRetries: options.maxRateLimitRetries,
    maxRetryAfterSeconds: options.maxRetryAfterSeconds,
    requestTimeout: options.requestTimeout
  }, env)

  const pollRetrySchedule = Schedule.exponential(pollRetryBase).pipe(
    Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, pollRetryCap))),
    Schedule.while(({ input }) => isRetryablePollFailure(input))
  )

  const poll: Source["poll"] = (cursor) =>
    Effect.gen(function*() {
      const params: Record<string, unknown> = { timeout: pollTimeoutSeconds, allowed_updates: allowedUpdates }
      if (cursor !== null) {
        // A cursor that does not parse used to be dropped, which sent
        // `getUpdates` with no offset and replayed Telegram's whole retained
        // backlog as if it were new. Unusable durable state is a failure, not
        // a reason to start over.
        // `Number()` accepts "", "0x10", and " 7 ", so a corrupt cursor could
        // silently skip or replay updates. Only the canonical decimal form the
        // source itself writes is accepted.
        const offset = /^\d+$/.test(cursor) ? Number(cursor) : Number.NaN
        if (!Number.isSafeInteger(offset)) {
          return yield* Effect.fail(
            new IntegrationError(
              "invalid-config",
              `Telegram source "${sourceId}" has a stored cursor that is not an update offset, so polling would replay the backlog.`,
              { sourceId, cursor }
            )
          )
        }
        params["offset"] = offset
      }
      const result = yield* client.call("getUpdates", params).pipe(
        Effect.mapError((cause) =>
          new IntegrationError(
            "poll-failed",
            `Telegram getUpdates failed for source "${sourceId}".`,
            { sourceId, retryable: isTransientPollCause(cause) },
            { cause }
          )
        )
      )
      // A non-array result is a Bot API contract change, not an empty batch.
      // Reading it as "no updates" would look like a healthy idle poll forever.
      if (!Array.isArray(result)) {
        return yield* Effect.fail(
          new IntegrationError(
            "decode-failed",
            `Telegram getUpdates returned a result that is not an update array for source "${sourceId}".`,
            { sourceId, resultType: result === null ? "null" : typeof result }
          )
        )
      }
      const receivedAtMs = Date.now()
      const events: Array<ExternalEvent> = []
      let maxUpdateId: number | null = null
      for (const [index, update] of (result as Array<Record<string, any>>).entries()) {
        const updateId = update?.["update_id"]
        if (typeof updateId !== "number" || !Number.isSafeInteger(updateId)) {
          return yield* Effect.fail(
            new IntegrationError(
              "decode-failed",
              `Telegram getUpdates returned an update with no numeric update_id for source "${sourceId}".`,
              { sourceId, index }
            )
          )
        }
        for (const key of ["message", "edited_message", "message_reaction", "callback_query"]) {
          const member = update[key]
          // `update["message"] !== undefined` is true for `null`, and
          // `updateToEvents` then reads through it and throws a TypeError,
          // which dies as a defect instead of failing decode-failed.
          if (member !== undefined && (typeof member !== "object" || member === null || Array.isArray(member))) {
            return yield* Effect.fail(
              new IntegrationError(
                "decode-failed",
                `Telegram getUpdates returned an update whose ${key} is not an object for source "${sourceId}".`,
                { sourceId, index, member: key }
              )
            )
          }
        }
        maxUpdateId = maxUpdateId === null ? updateId : Math.max(maxUpdateId, updateId)
        const chatId = updateChatId(update)
        // Fail closed. An update whose chat cannot be determined is exactly the
        // case an allowlist exists to refuse, and a callback query on an
        // inaccessible message is that case in practice.
        if (chatId == null || !allowedChats.has(String(chatId))) continue
        events.push(...updateToEvents(sourceId, update, receivedAtMs))
      }
      // The acknowledgement offset is proposed, not committed: `run` stores it
      // only after the batch has been handled.
      return maxUpdateId === null ? { events } : { events, cursor: String(maxUpdateId + 1) }
    })

  const run: Source["run"] = (onBatch, runOptions) =>
    CoreSource.runWithCursor(
      sourceId,
      (cursor) =>
        poll(cursor).pipe(
          Effect.tapError((error) =>
            isRetryablePollFailure(error)
              ? Effect.logWarning(`Telegram source "${sourceId}" poll failed; retrying`, error)
              : Effect.void
          ),
          Effect.retry(pollRetrySchedule)
        ),
      onBatch,
      runOptions
    )

  return { sourceId, poll, run }
}
