/**
 * The Telegram Bot API client.
 *
 * Plain `fetch`, no telegraf or grammY. What it adds over a bare call:
 *
 * - **Token redaction.** The token appears in the request path, so a transport
 *   error's message contains it. {@link redactBotToken} strips it from every
 *   message this module raises, and from any `/bot<digits>:<secret>/` shaped
 *   substring, so a token cannot reach a log through an error it did not
 *   construct.
 * - **Rate limits.** A 429 is retried, waiting the server's capped
 *   `parameters.retry_after`.
 * - **Long messages.** `sendMessageSmart` chunks at 4096 characters, converts
 *   markdown to MarkdownV2, and resends a chunk as plain text when Telegram
 *   rejects the entities, so a formatting failure costs formatting rather than
 *   the whole message.
 *
 * One `AbortController` per attempt spans the request and the body read, so an
 * interrupt at either stage aborts the exchange, and each attempt carries its
 * own deadline, `requestTimeout`, over both. `getUpdates` adds the long poll it
 * asked the server to hold, and the best-effort typing action is capped far
 * shorter, because a reader waiting on the message is not served by a slow
 * indicator.
 *
 * @since 1.0.0
 */

import { isRecord } from "@smthrs/canonical/Record"
import { hasSmithersErrorShape, SmithersError } from "@smthrs/errors/SmithersError"
import { Context, Duration, Effect, Layer, Option, Schedule } from "effect"
import { isMessageId } from "../core/ActionFailure.ts"
import { IntegrationError, type Reason, reasons } from "../core/IntegrationError.ts"
import * as Environment from "../Environment.ts"
import { chunk } from "./Chunk.ts"
import { resolve as resolveConfig, type TelegramConfig } from "./Config.ts"
import { clean, toTelegram } from "./Markdown.ts"

const DEFAULT_API_BASE_URL = "https://api.telegram.org"
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 3
const DEFAULT_MAX_RETRY_AFTER_SECONDS = 30
const DEFAULT_REQUEST_TIMEOUT = Duration.seconds(30)
// The typing indicator is cosmetic and is awaited before the first chunk, so
// it gets its own short cap rather than the full request deadline.
const TYPING_TIMEOUT_MS = 5_000

/**
 * A failure reported by the Bot API.
 *
 * Carries the API's own `error_code` and `description`, plus the parsed
 * `retry_after` for a 429. The bot token is never part of any field.
 *
 * @category errors
 * @since 1.0.0
 */
export class TelegramApiError extends SmithersError {
  readonly errorCode: number | null
  readonly retryAfterSeconds: number | null
  /**
   * The messages a partially completed multi-chunk send had already delivered.
   *
   * A long message is several `sendMessage` calls. One that fails after the
   * third of five leaves three messages the reader can see, so the failure
   * names them: a caller deciding whether to resend knows what the chat
   * already holds.
   */
  readonly deliveredMessageIds: ReadonlyArray<number>
  /**
   * The classification to use instead of the one the error code implies.
   *
   * Success headers alone cannot classify a failed acknowledgement. A lost
   * body is a delivery failure; a fully received but malformed body is a
   * decode failure. Write ambiguity is carried separately in details.
   */
  readonly reason: Reason | null

  constructor(message: string, options: {
    readonly method: string
    readonly errorCode?: number | null | undefined
    readonly description?: string | null | undefined
    readonly retryAfterSeconds?: number | null | undefined
    readonly deliveredMessageIds?: ReadonlyArray<number> | undefined
    readonly reason?: Reason | undefined
    readonly cause?: unknown
    readonly causeDescription?: string | undefined
    readonly outcomeUnknown?: boolean | undefined
    /** The client's own deadline expired, rather than the API answering. */
    readonly timedOut?: boolean | undefined
  }) {
    super("TELEGRAM_API_ERROR", message, {
      method: options.method,
      errorCode: options.errorCode ?? null,
      description: options.description ?? null,
      retryAfterSeconds: options.retryAfterSeconds ?? null,
      deliveredMessageIds: options.deliveredMessageIds ?? [],
      ...(options.causeDescription === undefined ? {} : { cause: options.causeDescription }),
      ...(options.outcomeUnknown === undefined ? {} : { outcomeUnknown: options.outcomeUnknown }),
      ...(options.timedOut === undefined ? {} : { timedOut: options.timedOut })
    }, { cause: options.cause, name: "TelegramApiError" })
    this.reason = options.reason ?? null
    this.errorCode = options.errorCode ?? null
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
    this.deliveredMessageIds = options.deliveredMessageIds ?? []
  }
}

/**
 * Whether `error` is a {@link TelegramApiError}.
 *
 * Every field read is guarded. A caller-supplied getter that throws is not a
 * Bot API failure this module can vouch for, so the refinement answers false
 * and lets the action boundary use its unclassified path.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isTelegramApiError = (error: unknown): error is TelegramApiError => {
  try {
    if (
      !(error instanceof Error) ||
      (!(error instanceof TelegramApiError) && error.name !== "TelegramApiError") ||
      !hasSmithersErrorShape(error) ||
      error.code !== "TELEGRAM_API_ERROR"
    ) return false
    // A name is forgeable, so every field a reader of this refinement touches has
    // to be there too, `deliveredMessageIds` included: `toIntegrationError`
    // spreads it, and spreading a missing array throws a bare `TypeError` inside
    // `Effect.mapError`, where a throw is a defect rather than a classified
    // failure. An error that only claims the name, whether a forgery or a
    // `TelegramApiError` from an older copy of this module, falls through to the
    // caller's unclassified path instead.
    const candidate = error as {
      readonly summary?: unknown
      readonly errorCode?: unknown
      readonly deliveredMessageIds?: unknown
    }
    const summary = candidate.summary
    const errorCode = candidate.errorCode
    const deliveredMessageIds = candidate.deliveredMessageIds
    return typeof summary === "string" &&
      (errorCode === null || typeof errorCode === "number") &&
      Array.isArray(deliveredMessageIds) &&
      deliveredMessageIds.every(isMessageId)
  } catch {
    return false
  }
}

/**
 * The classification a Bot API failure carries once it leaves this module.
 *
 * A `TelegramApiError` is not an `IntegrationError`, so an action that mapped
 * it through `ActionFailure.fromIntegrationError` reported every Telegram
 * failure as an unclassified, non-retryable `delivery-failed`: a rate limit
 * that exhausted its retries looked exactly like a chat that does not exist.
 * This is the mapping that keeps the package's one promise, that every failure
 * carries a machine-readable reason, true for Telegram as well.
 * A field getter that starts throwing after the refinement leaves the original
 * value unchanged, so the total action-boundary conversion can classify it.
 *
 * @category conversions
 * @since 1.0.0
 */
export const toIntegrationError = (error: unknown): unknown => {
  if (!isTelegramApiError(error)) return error
  try {
    const code = error.errorCode
    const overrideValue = error.reason
    const summary = error.summary
    const details = error.details
    const deliveredMessageIds = error.deliveredMessageIds
    // Read as an absent override rather than as a value. The refinement admits a
    // `TelegramApiError` from a copy of this module built before `reason`
    // existed, whose `reason` is `undefined` and not `null`, and one whose
    // `reason` is a string this build cannot encode. Either would otherwise turn
    // an exhausted rate limit into a non-retryable failure with a known outcome.
    const override = reasons.includes(overrideValue as Reason) ? overrideValue as Reason : null
    const transient = (code === 429 || (typeof code === "number" && code >= 500)) && override === null
    const reason = override ?? (transient
      ? "delivery-failed" as const
      : code === 401 || code === 403
      ? "permission-denied" as const
      : code === 400 || code === 404
      ? "decode-failed" as const
      : "delivery-failed" as const)
    return new IntegrationError(reason, summary, {
      method: details?.["method"],
      errorCode: code,
      // A 429 that outlived its retries is worth another attempt later; a chat
      // that does not exist is not.
      retryable: transient,
      // Lost bodies can make writes ambiguous even after success headers.
      outcomeUnknown: details?.["outcomeUnknown"] === true ||
        (override === null && (code === null || (typeof code === "number" && code >= 500))),
      ...(typeof details?.["cause"] === "string" ? { cause: details["cause"] } : {}),
      deliveredMessageIds: [...deliveredMessageIds]
    }, { cause: error })
  } catch {
    return error
  }
}

/**
 * Removes the bot token from a string.
 *
 * Both the literal token and any `/bot<id>:<secret>` path segment are
 * replaced, because an error from `fetch` or the platform may quote a URL this
 * module never formatted.
 *
 * @category constructors
 * @since 1.0.0
 */
export const redactBotToken = (text: string, botToken: string): string => {
  if (botToken.length === 0) return text
  return text.split(botToken).join("<redacted>").replace(/\/bot\d+:[A-Za-z0-9_-]+/g, "/bot<redacted>")
}

/** A 400 the Bot API raises when it cannot parse entities: retry as plain text. */
const isParseEntityError = (error: unknown): boolean => {
  if (!isTelegramApiError(error) || error.errorCode !== 400) return false
  return /parse|entit|too long/i.test(String(error.details?.["description"] ?? ""))
}

/**
 * One inline-keyboard button.
 *
 * @category models
 * @since 1.0.0
 */
export interface InlineKeyboardButton {
  readonly text: string
  readonly callback_data?: string | undefined
  readonly url?: string | undefined
  readonly web_app?: { readonly url: string } | undefined
}

/**
 * Rows of inline-keyboard buttons.
 *
 * @category models
 * @since 1.0.0
 */
export type InlineKeyboard = ReadonlyArray<ReadonlyArray<InlineKeyboardButton>>

/**
 * How to format and address an outgoing message.
 *
 * @category models
 * @since 1.0.0
 */
export interface SendOptions {
  /**
   * `markdown` (the default) converts standard markdown to MarkdownV2 and
   * falls back to plain text when Telegram rejects the entities.
   * `MarkdownV2` and `HTML` send the text as-is under that parse mode, still
   * with the fallback. `none` sends raw text with no parse mode.
   */
  readonly parseMode?: "markdown" | "MarkdownV2" | "HTML" | "none" | undefined
  /** Attached to the first chunk only. */
  readonly replyToMessageId?: number | undefined
  /** Forum-topic thread id, attached to every chunk. */
  readonly messageThreadId?: number | undefined
  /** Attached to the last chunk only. */
  readonly inlineKeyboard?: InlineKeyboard | undefined
  /** Show a typing action before the first chunk. Defaults to true. */
  readonly typing?: boolean | undefined
  readonly disableNotification?: boolean | undefined
}

/**
 * What `sendMessageSmart` sent.
 *
 * @category models
 * @since 1.0.0
 */
export interface SendResult {
  readonly chatId: string
  /**
   * The `message_id` of every chunk, in send order. On success this always
   * has `chunkCount` members: a chunk whose answer carried no usable id fails
   * the send rather than leaving the record short.
   */
  readonly messageIds: ReadonlyArray<number>
  readonly chunkCount: number
  /** True when at least one chunk fell back to plain text. */
  readonly usedPlainTextFallback: boolean
}

/**
 * A document to upload: a URL or existing `file_id`, or raw bytes.
 *
 * @category models
 * @since 1.0.0
 */
export type DocumentInput = string | {
  readonly filename: string
  readonly content: string | Uint8Array
  readonly contentType?: string | undefined
}

/**
 * The client service.
 *
 * @category services
 * @since 1.0.0
 */
export interface TelegramClient {
  /** A raw Bot API call, returning the `result` field. Retries a 429. */
  readonly call: (method: string, params?: Record<string, unknown>) => Effect.Effect<unknown, SmithersError>
  readonly sendMessageSmart: (
    chatId: number | string,
    text: string,
    options?: SendOptions
  ) => Effect.Effect<SendResult, SmithersError>
  readonly editMessageSmart: (
    chatId: number | string,
    messageId: number,
    text: string,
    options?: Pick<SendOptions, "parseMode" | "inlineKeyboard">
  ) => Effect.Effect<unknown, SmithersError>
  readonly sendDocument: (
    chatId: number | string,
    document: DocumentInput,
    options?: {
      readonly caption?: string | undefined
      readonly replyToMessageId?: number | undefined
      readonly messageThreadId?: number | undefined
    }
  ) => Effect.Effect<unknown, SmithersError>
  readonly answerCallbackQuery: (
    callbackQueryId: string,
    options?: { readonly text?: string | undefined; readonly showAlert?: boolean | undefined }
  ) => Effect.Effect<unknown, SmithersError>
  /**
   * Answers a Mini App inline query: posts `result` to the chat on the user's
   * behalf and closes the Mini App.
   */
  readonly answerWebAppQuery: (
    webAppQueryId: string,
    result: Record<string, unknown>
  ) => Effect.Effect<unknown, SmithersError>
}

/**
 * Service tag for the Telegram Bot API client.
 *
 * @category services
 * @since 1.0.0
 */
export const TelegramClient: Context.Service<TelegramClient, TelegramClient> = Context.Service(
  "@smthrs/integrations/TelegramClient"
)

const linkInterrupt = (signal: AbortSignal, controller: AbortController): void => {
  if (signal.aborted) {
    controller.abort(signal.reason)
    return
  }
  signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
}

/**
 * Builds a Bot API client bound to `config`.
 *
 * `env` is the fallback source for the bot token, the same shape the GitHub
 * and Linear clients take. Passing one replaces the ambient environment rather
 * than layering over it, so a caller that supplies its own credential cannot
 * be surprised by an ambient `SMITHERS_TELEGRAM_BOT_TOKEN` deciding which bot
 * a send runs as.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  config: Partial<TelegramConfig> = {},
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): TelegramClient => {
  const { botToken } = resolveConfig(config, env)
  const apiBaseUrl = (config.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "")
  const maxRateLimitRetries = config.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES
  const maxRetryAfterSeconds = config.maxRetryAfterSeconds ?? DEFAULT_MAX_RETRY_AFTER_SECONDS
  // A zero or infinite deadline is not a deadline: the first would fail every
  // request and the second is the unbounded wait this option exists to close.
  const configuredTimeout = config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT
  const requestTimeout = Option.getOrUndefined(Duration.fromInput(configuredTimeout))
  if (
    requestTimeout === undefined || !Duration.isFinite(requestTimeout) || Duration.toMillis(requestTimeout) <= 0
  ) {
    throw new SmithersError(
      "INVALID_INPUT",
      "Telegram requestTimeout must be a finite, positive duration.",
      { requestTimeout: String(configuredTimeout) }
    )
  }
  const requestTimeoutMs = Duration.toMillis(requestTimeout)
  const typingTimeout = Duration.millis(Math.min(requestTimeoutMs, TYPING_TIMEOUT_MS))

  // `getUpdates` asks Telegram to hold the request open for `timeout` seconds,
  // so its deadline is that poll plus the transport budget. Anything shorter
  // would cancel every long poll the source asks for.
  const deadlineFor = (method: string, params?: Record<string, unknown>): Duration.Duration => {
    const held = params?.["timeout"]
    if (method !== "getUpdates" || typeof held !== "number" || !Number.isFinite(held) || held <= 0) {
      return requestTimeout
    }
    return Duration.millis(held * 1000 + requestTimeoutMs)
  }

  // Retry only a 429, waiting the capped server-supplied retry_after.
  const rateLimitSchedule = Schedule.forever.pipe(
    Schedule.while(({ input }) => isTelegramApiError(input) && input.errorCode === 429),
    Schedule.addDelay(({ input }) => {
      const seconds = isTelegramApiError(input) && typeof input.retryAfterSeconds === "number"
        ? Math.min(Math.max(input.retryAfterSeconds, 0), maxRetryAfterSeconds)
        : 1
      return Effect.succeed(Duration.seconds(seconds))
    }),
    Schedule.upTo({ times: maxRateLimitRetries })
  )

  const rawCall = (
    method: string,
    request: { readonly body: BodyInit; readonly headers?: Record<string, string> | undefined },
    deadline: Duration.Duration = requestTimeout
  ): Effect.Effect<unknown, SmithersError> =>
    Effect.suspend(() => {
      const controller = new AbortController()
      const isWrite = !method.startsWith("get")
      let pendingResponse: Response | undefined
      let consumed = false
      return Effect.gen(function*() {
        const response = yield* Effect.tryPromise({
          try: (signal) => {
            linkInterrupt(signal, controller)
            return fetch(`${apiBaseUrl}/bot${botToken}/${method}`, {
              method: "POST",
              ...(request.headers === undefined ? {} : { headers: request.headers }),
              body: request.body,
              signal: controller.signal
            })
          },
          catch: (cause) =>
            new TelegramApiError(
              `Telegram API request failed for method "${method}": ${
                redactBotToken(cause instanceof Error ? cause.message : String(cause), botToken)
              }`,
              { method }
            )
        })
        pendingResponse = response
        const body = yield* Effect.tryPromise({
          try: (signal) => {
            linkInterrupt(signal, controller)
            return response.text()
          },
          catch: (cause) => {
            const causeDescription = redactBotToken(cause instanceof Error ? cause.message : String(cause), botToken)
            return new TelegramApiError(
              `Telegram API response body could not be read for method "${method}" (status ${response.status}).`,
              {
                method,
                errorCode: response.status,
                ...(response.ok ? { reason: "delivery-failed" as const } : {}),
                outcomeUnknown: isWrite && response.ok,
                causeDescription,
                cause: causeDescription
              }
            )
          }
        })
        consumed = true
        const payload = yield* Effect.try({
          try: () => JSON.parse(body) as unknown,
          catch: () =>
            new TelegramApiError(
              `Telegram API returned a non-JSON response for method "${method}" (status ${response.status}).`,
              {
                method,
                errorCode: response.status,
                ...(response.ok ? { reason: "decode-failed" as const, outcomeUnknown: isWrite } : {})
              }
            )
        })
        // The Bot API envelope is `{ ok, result }` or `{ ok: false, ... }`.
        // Anything else is not a Bot API answer, so it is reported as one
        // rather than read through a cast that happens not to throw.
        if (!isRecord(payload)) {
          return yield* Effect.fail(
            new TelegramApiError(
              `Telegram API returned a response that is not a Bot API envelope for method "${method}" (status ${response.status}).`,
              {
                method,
                errorCode: response.status,
                ...(response.ok ? { reason: "decode-failed" as const, outcomeUnknown: isWrite } : {})
              }
            )
          )
        }
        const ok = payload["ok"]
        if (typeof ok !== "boolean" || (ok && !Object.hasOwn(payload, "result"))) {
          return yield* Effect.fail(
            new TelegramApiError(
              `Telegram API returned a response that is not a Bot API envelope for method "${method}" (status ${response.status}).`,
              {
                method,
                errorCode: response.status,
                ...(response.ok ? { reason: "decode-failed" as const, outcomeUnknown: isWrite } : {})
              }
            )
          )
        }
        if (!ok) {
          const errorCode = typeof payload["error_code"] === "number" ? payload["error_code"] : response.status
          const description = redactBotToken(
            typeof payload["description"] === "string" ? payload["description"] : `HTTP ${response.status}`,
            botToken
          )
          const parameters = payload["parameters"]
          const retryAfterSeconds = isRecord(parameters) && typeof parameters["retry_after"] === "number"
            ? parameters["retry_after"]
            : null
          return yield* Effect.fail(
            new TelegramApiError(`Telegram API "${method}" failed: ${description}`, {
              method,
              errorCode,
              description,
              retryAfterSeconds
            })
          )
        }
        return payload["result"]
      }).pipe(
        Effect.ensuring(Effect.promise(async () => {
          controller.abort()
          if (!consumed) await pendingResponse?.body?.cancel().catch(() => {})
        })),
        // The deadline spans the whole exchange, headers and body alike. The
        // timeout interrupts the attempt, whose finalizer aborts the
        // controller and closes the socket. A write that ran out of time may
        // still have been applied, so it says the outcome is unknown rather
        // than being repeated.
        Effect.timeoutOrElse({
          duration: deadline,
          orElse: () =>
            Effect.fail(
              new TelegramApiError(
                `Telegram API request timed out after ${Duration.toMillis(deadline)} ms for method "${method}".`,
                {
                  method,
                  reason: "delivery-failed",
                  outcomeUnknown: isWrite,
                  timedOut: true
                }
              )
            )
        })
      )
    })

  // Serialized inside the Effect: a BigInt or cyclic parameter is a caller
  // error with a known outcome, since nothing was sent.
  const call: TelegramClient["call"] = (method, params) =>
    Effect.try({
      try: () => JSON.stringify(params ?? {}),
      catch: (cause) =>
        new TelegramApiError(`Telegram request parameters for method "${method}" could not be serialized as JSON.`, {
          method,
          reason: "invalid-config",
          outcomeUnknown: false,
          cause
        })
    }).pipe(
      Effect.flatMap((body) =>
        rawCall(method, { body, headers: { "content-type": "application/json" } }, deadlineFor(method, params))
      ),
      Effect.retry(rateLimitSchedule)
    )

  const sendChunk = (
    base: Record<string, unknown>,
    formatted: string,
    plain: string,
    parseMode: string | null
  ): Effect.Effect<{ readonly result: unknown; readonly usedPlainTextFallback: boolean }, SmithersError> => {
    if (parseMode === null) {
      return call("sendMessage", { ...base, text: plain }).pipe(
        Effect.map((result) => ({ result, usedPlainTextFallback: false }))
      )
    }
    return call("sendMessage", { ...base, text: formatted, parse_mode: parseMode }).pipe(
      Effect.map((result) => ({ result, usedPlainTextFallback: false })),
      Effect.catch((error) =>
        isParseEntityError(error)
          ? call("sendMessage", { ...base, text: plain }).pipe(
            Effect.map((result) => ({ result, usedPlainTextFallback: true }))
          )
          : Effect.fail(error)
      )
    )
  }

  const parseModeFor = (option: NonNullable<SendOptions["parseMode"]>): string | null =>
    option === "none" ? null : option === "markdown" ? "MarkdownV2" : option

  const sendMessageSmart: TelegramClient["sendMessageSmart"] = (chatId, text, options = {}) =>
    Effect.gen(function*() {
      const parseModeOption = options.parseMode ?? "markdown"
      const chunks = chunk(clean(text))
      if (chunks.length === 0) {
        return { chatId: String(chatId), messageIds: [], chunkCount: 0, usedPlainTextFallback: false }
      }
      if (options.typing !== false) {
        // Best effort: a failed chat action must not fail the send.
        yield* call("sendChatAction", {
          chat_id: chatId,
          action: "typing",
          ...(options.messageThreadId == null ? {} : { message_thread_id: options.messageThreadId })
        }).pipe(
          // Capped well under the request deadline: the reader is waiting on
          // the message, and a stalled indicator must not hold it back.
          Effect.timeoutOrElse({
            duration: typingTimeout,
            orElse: () =>
              Effect.fail(
                new TelegramApiError(
                  `Telegram typing action timed out after ${Duration.toMillis(typingTimeout)} ms.`,
                  { method: "sendChatAction", reason: "delivery-failed", timedOut: true }
                )
              )
          }),
          Effect.catch((error) =>
            Effect.annotateLogs(
              Effect.logWarning("Telegram typing action failed"),
              { chatId: String(chatId), error }
            )
          )
        )
      }
      const messageIds: Array<number> = []
      let usedPlainTextFallback = false
      for (const [index, piece] of chunks.entries()) {
        const isFirst = index === 0
        const isLast = index === chunks.length - 1
        const base = {
          chat_id: chatId,
          ...(options.messageThreadId == null ? {} : { message_thread_id: options.messageThreadId }),
          // Reply threading applies to the first chunk; the rest read as a
          // continuation. The keyboard goes on the last, where the reader is.
          ...(isFirst && options.replyToMessageId != null
            ? { reply_to_message_id: options.replyToMessageId }
            : {}),
          ...(isLast && options.inlineKeyboard !== undefined
            ? { reply_markup: { inline_keyboard: options.inlineKeyboard } }
            : {}),
          ...(options.disableNotification === true ? { disable_notification: true } : {})
        }
        const formatted = parseModeOption === "markdown" ? toTelegram(piece) : piece
        const sent = yield* sendChunk(base, formatted, piece, parseModeFor(parseModeOption)).pipe(
          // A chunk that fails after earlier ones landed leaves messages the
          // reader can already see. The failure says how many, so a caller
          // resending knows what the chat already holds rather than repeating
          // the whole message.
          Effect.mapError((error) =>
            chunks.length === 1 || !isTelegramApiError(error) ? error : new TelegramApiError(
              `${error.summary} (chunk ${index + 1} of ${chunks.length}; ${messageIds.length} already delivered)`,
              {
                method: "sendMessage",
                errorCode: error.errorCode,
                description: String(error.details?.["description"] ?? ""),
                retryAfterSeconds: error.retryAfterSeconds,
                deliveredMessageIds: [...messageIds],
                ...(error.reason === null ? {} : { reason: error.reason }),
                outcomeUnknown: error.details?.["outcomeUnknown"] === true,
                causeDescription: typeof error.details?.["cause"] === "string" ? error.details["cause"] : undefined,
                cause: error
              }
            )
          )
        )
        usedPlainTextFallback = usedPlainTextFallback || sent.usedPlainTextFallback
        const messageId = (sent.result as { message_id?: unknown } | null)?.message_id
        // The record has to name every message it claims to have sent, so a
        // result with no usable id is a decode failure rather than a silent
        // shortfall between `messageIds` and `chunkCount`.
        if (!isMessageId(messageId)) {
          return yield* Effect.fail(
            new TelegramApiError(
              `Telegram sendMessage returned no usable message_id for chunk ${index + 1} of ${chunks.length}.`,
              {
                method: "sendMessage",
                deliveredMessageIds: [...messageIds],
                reason: "decode-failed",
                outcomeUnknown: true
              }
            )
          )
        }
        messageIds.push(messageId)
      }
      return { chatId: String(chatId), messageIds, chunkCount: chunks.length, usedPlainTextFallback }
    })

  const editMessageSmart: TelegramClient["editMessageSmart"] = (chatId, messageId, text, options = {}) => {
    const parseModeOption = options.parseMode ?? "markdown"
    const plain = clean(text)
    const formatted = parseModeOption === "markdown" ? toTelegram(plain) : plain
    const parseMode = parseModeFor(parseModeOption)
    const base = {
      chat_id: chatId,
      message_id: messageId,
      ...(options.inlineKeyboard === undefined ? {} : { reply_markup: { inline_keyboard: options.inlineKeyboard } })
    }
    if (parseMode === null) return call("editMessageText", { ...base, text: plain })
    return call("editMessageText", { ...base, text: formatted, parse_mode: parseMode }).pipe(
      Effect.catch((error) =>
        isParseEntityError(error)
          // Show fresh content unformatted rather than leaving a stale message.
          ? call("editMessageText", { ...base, text: plain })
          : Effect.fail(error)
      )
    )
  }

  const sendDocument: TelegramClient["sendDocument"] = (chatId, document, options = {}) => {
    const caption = options.caption === undefined ? undefined : toTelegram(clean(options.caption))
    const shared: Record<string, string | number> = {
      ...(caption === undefined ? {} : { caption, parse_mode: "MarkdownV2" }),
      ...(options.messageThreadId == null ? {} : { message_thread_id: options.messageThreadId }),
      ...(options.replyToMessageId == null ? {} : { reply_to_message_id: options.replyToMessageId })
    }
    if (typeof document === "string") {
      return call("sendDocument", { chat_id: chatId, document, ...shared })
    }
    const form = new FormData()
    form.set("chat_id", String(chatId))
    for (const [key, value] of Object.entries(shared)) form.set(key, String(value))
    const bytes = typeof document.content === "string" ? new TextEncoder().encode(document.content) : document.content
    form.set(
      "document",
      new Blob([bytes as BlobPart], { type: document.contentType ?? "application/octet-stream" }),
      document.filename
    )
    return rawCall("sendDocument", { body: form }).pipe(Effect.retry(rateLimitSchedule))
  }

  return TelegramClient.of({
    call,
    sendMessageSmart,
    editMessageSmart,
    sendDocument,
    answerCallbackQuery: (callbackQueryId, options = {}) =>
      call("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...(options.text === undefined ? {} : { text: options.text }),
        ...(options.showAlert === true ? { show_alert: true } : {})
      }),
    answerWebAppQuery: (webAppQueryId, result) => call("answerWebAppQuery", { web_app_query_id: webAppQueryId, result })
  })
}

/**
 * Layer for a client bound to `config`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  config: Partial<TelegramConfig> = {},
  env: Readonly<Record<string, string | undefined>> = Environment.ambientEnvironment()
): Layer.Layer<TelegramClient, SmithersError> =>
  Layer.effect(TelegramClient)(Effect.suspend(() => {
    // A config error is a typed layer failure. Anything else make throws is a
    // defect and stays one.
    try {
      return Effect.succeed(make(config, env))
    } catch (error) {
      if (hasSmithersErrorShape(error)) return Effect.fail(error)
      throw error
    }
  }))
