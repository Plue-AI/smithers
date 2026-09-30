/**
 * Finite memory maintenance Effects intended for explicit schedules.
 *
 * @since 0.1.0
 */

import * as Digest from "@smthrs/core/Digest"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { MemoryError } from "./MemoryError.ts"
import { MemoryStore, type Message, type Service } from "./MemoryStore.ts"

/**
 * Result of one TTL garbage-collection pass.
 *
 * @category models
 * @since 0.1.0
 */
export interface TtlGcResult {
  readonly deletedFacts: number
}

/**
 * Deletes facts whose TTL has elapsed.
 *
 * @category effects
 * @since 0.1.0
 */
export const ttlGc: Effect.Effect<TtlGcResult, MemoryError, MemoryStore> = Effect.service(MemoryStore).pipe(
  Effect.flatMap((store) => store.deleteExpiredFacts),
  Effect.map((deletedFacts) => ({ deletedFacts }))
)

/**
 * Options for {@link layerTtlGc}.
 *
 * @category models
 * @since 1.0.0
 */
export interface TtlGcScheduleOptions {
  /** Time between passes. Defaults to ten minutes. */
  readonly interval?: Duration.Input | undefined
}

/**
 * Runs {@link ttlGc} once while the layer builds and then on every interval
 * for as long as the layer's scope is open. A failed pass is logged and the
 * next one still runs; a pass that deletes rows logs how many.
 *
 * The first pass completes before the layer is built, and the interval fiber
 * starts at once, so its first sleep is already scheduled when the build
 * returns: the interval is measured from the built layer, whatever the
 * database's latency.
 *
 * Compose it in the host that owns the memory database, so expired facts and
 * their FTS and vector projections are deleted, not only hidden from reads.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerTtlGc = (options: TtlGcScheduleOptions = {}): Layer.Layer<never, never, MemoryStore> => {
  const pass = ttlGc.pipe(
    Effect.tap(({ deletedFacts }) =>
      deletedFacts > 0 ? Effect.logInfo("memory TTL GC deleted expired facts", { deletedFacts }) : Effect.void
    ),
    Effect.withSpan("Maintenance.ttlGc"),
    Effect.catch((error) => Effect.logWarning("memory TTL GC pass failed", error))
  )
  return Layer.effectDiscard(
    pass.pipe(
      Effect.andThen(
        pass.pipe(
          Effect.delay(options.interval ?? "10 minutes"),
          Effect.forever,
          Effect.forkScoped({ startImmediately: true })
        )
      )
    )
  )
}

/**
 * Configuration for one history token-limiter pass.
 *
 * @category models
 * @since 0.1.0
 */
export interface TokenLimiterOptions {
  readonly maxTokens: number
  readonly charsPerToken?: number | undefined
}

/**
 * Result of one history token-limiter pass.
 *
 * @category models
 * @since 0.1.0
 */
export interface TokenLimiterResult {
  readonly deletedMessages: number
}

const MESSAGE_PAGE_SIZE = 256

// Visits one thread's messages oldest first, one page at a time, until the
// history ends or `visit` answers false.
const forEachPage = <E, R>(
  store: Service,
  threadId: string,
  visit: (page: ReadonlyArray<Message>) => Effect.Effect<boolean, E, R>
): Effect.Effect<void, MemoryError | E, R> =>
  Effect.gen(function*() {
    let cursor: { readonly at: number; readonly id: string } | undefined
    while (true) {
      const page = yield* store.listMessages({
        threadId,
        limit: MESSAGE_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor })
      })
      const last = page.at(-1)
      if (last === undefined || !(yield* visit(page)) || page.length < MESSAGE_PAGE_SIZE) return
      cursor = { at: last.at, id: last.id }
    }
  })

/**
 * Deletes the oldest messages in every thread until the configured
 * approximate token budget is met.
 *
 * @category effects
 * @since 0.1.0
 */
export const limitHistory = (
  options: TokenLimiterOptions
): Effect.Effect<TokenLimiterResult, MemoryError, MemoryStore> =>
  Effect.gen(function*() {
    if (!Number.isFinite(options.maxTokens) || options.maxTokens < 0) {
      return yield* Effect.fail(
        new MemoryError({
          code: "invalid_argument",
          message: "maxTokens must be a non-negative finite number",
          path: ["maxTokens"]
        })
      )
    }
    const charsPerToken = options.charsPerToken ?? 4
    if (!Number.isFinite(charsPerToken) || charsPerToken <= 0) {
      return yield* Effect.fail(
        new MemoryError({
          code: "invalid_argument",
          message: "charsPerToken must be a positive finite number",
          path: ["charsPerToken"]
        })
      )
    }
    const store = yield* MemoryStore
    const threadIds = yield* store.listThreadIds
    const deleted = yield* Effect.forEach(
      threadIds,
      (threadId) =>
        Effect.gen(function*() {
          const budget = options.maxTokens * charsPerToken
          // JavaScript length lies between SQLite's code points and bytes, so
          // the SQL aggregate settles every thread that fits by bytes, and
          // every all-ASCII thread exactly, without reading message bodies.
          const stats = yield* store.messageStats({ threadId })
          if (stats.bytes <= budget) return 0
          let chars = stats.codePoints === stats.bytes ? stats.bytes : 0
          if (stats.codePoints !== stats.bytes) {
            yield* forEachPage(store, threadId, (page) =>
              Effect.sync(() => {
                chars += page.reduce((total, message) => total + message.text.length, 0)
                return true
              }))
          }
          let deleted = 0
          if (chars <= budget) return deleted
          yield* forEachPage(store, threadId, (page) =>
            Effect.gen(function*() {
              const ids: Array<string> = []
              for (const message of page) {
                if (chars <= budget) break
                ids.push(message.id)
                chars -= message.text.length
              }
              deleted += yield* store.deleteMessages({ threadId, ids })
              return chars > budget
            }))
          return deleted
        }),
      { concurrency: 1 }
    )
    return { deletedMessages: deleted.reduce((total, count) => total + count, 0) }
  })

/**
 * Input supplied to an injected summarizer.
 *
 * @category models
 * @since 0.1.0
 */
export interface SummarizerInput {
  readonly threadId: string
  readonly messages: ReadonlyArray<Message>
  readonly rendered: string
}

/**
 * Injected summarizer Effect. Implementations may invoke a model flow, a test
 * fake, or another caller-owned summarization route.
 *
 * @category models
 * @since 0.1.0
 */
export interface Summarizer<E = never, R = never> {
  readonly summarize: (input: SummarizerInput) => Effect.Effect<string, E, R>
}

/**
 * Configuration for one compaction pass.
 *
 * @category models
 * @since 0.1.0
 */
export interface CompactionOptions<E = never, R = never> {
  readonly summarizer: Summarizer<E, R>
  readonly threadId?: string | undefined
  readonly keepRecent?: number | undefined
  /**
   * Most messages handed to one summarizer call, at least 2 and defaulting to
   * 1024. Longer histories compact in several windows, each folding the
   * previous summary into the next oldest messages.
   */
  readonly maxMessagesPerSummary?: number | undefined
  readonly makeSummaryId?: ((threadId: string, messages: ReadonlyArray<Message>) => string) | undefined
}

/**
 * Result of one compaction pass.
 *
 * @category models
 * @since 0.1.0
 */
export interface CompactionResult {
  readonly compactedThreads: number
  readonly deletedMessages: number
}

const render = (messages: ReadonlyArray<Message>): string =>
  messages.map((message) => `${message.role}: ${message.text}`).join("\n")

const DEFAULT_MAX_MESSAGES_PER_SUMMARY = 1024

/**
 * Summarizes old history and atomically replaces it with a summary.
 *
 * The summarizer runs before the write transaction. After it succeeds,
 * `MemoryStore.compactMessages` verifies the full source rows, then inserts the
 * summary and deletes the sources in one `Database.write`. Changed or missing
 * sources fail with `compaction_conflict`. Failure or fiber interruption before that
 * commit leaves the source messages intact.
 *
 * @category effects
 * @since 0.1.0
 */
export const compact = <E, R>(
  options: CompactionOptions<E, R>
): Effect.Effect<CompactionResult, E | MemoryError, R | MemoryStore> =>
  Effect.gen(function*() {
    const keepRecent = options.keepRecent ?? 2
    if (!Number.isSafeInteger(keepRecent) || keepRecent < 0) {
      return yield* Effect.fail(
        new MemoryError({
          code: "invalid_argument",
          message: "keepRecent must be a non-negative safe integer",
          path: ["keepRecent"]
        })
      )
    }
    const maxMessagesPerSummary = options.maxMessagesPerSummary ?? DEFAULT_MAX_MESSAGES_PER_SUMMARY
    if (!Number.isSafeInteger(maxMessagesPerSummary) || maxMessagesPerSummary < 2) {
      return yield* Effect.fail(
        new MemoryError({
          code: "invalid_argument",
          message: "maxMessagesPerSummary must be a safe integer of at least 2",
          path: ["maxMessagesPerSummary"]
        })
      )
    }
    const store = yield* MemoryStore
    const threadIds = options.threadId === undefined ? yield* store.listThreadIds : [options.threadId]
    let compactedThreads = 0
    let deletedMessages = 0
    for (const threadId of threadIds) {
      // Old messages still to summarize. Every window after the first also
      // carries the previous window's summary. The summary is carried
      // explicitly: it keeps the oldest source timestamp, but under a tied
      // timestamp its id may sort after messages it did not summarize.
      let unsummarized = (yield* store.countMessages({ threadId })) - keepRecent
      let carried: Message | undefined
      while (unsummarized > 0) {
        const take = Math.min(maxMessagesPerSummary - (carried === undefined ? 0 : 1), unsummarized)
        const page = yield* store.listMessages({
          threadId,
          limit: take + (carried === undefined ? 0 : 1)
        })
        const sources = page.filter((message) => message.id !== carried?.id).slice(0, take)
        if (sources.length === 0 || (carried === undefined && sources.length === 1 && sources[0]!.role === "system")) {
          break
        }
        const oldMessages = Object.freeze(
          (carried === undefined ? sources : [carried, ...sources]).map((message) => Object.freeze({ ...message }))
        )
        const summaryText = yield* options.summarizer.summarize({
          threadId,
          messages: oldMessages,
          rendered: render(oldMessages)
        })
        const summaryId = options.makeSummaryId?.(threadId, oldMessages) ??
          `summary-${
            Digest.digest(Digest.canonical({ threadId, messageIds: oldMessages.map((message) => message.id) }))
          }`
        const summary: Message = { threadId, id: summaryId, role: "system", text: summaryText, at: oldMessages[0]!.at }
        deletedMessages += yield* store.compactMessages({ threadId, summary, sourceMessages: oldMessages })
        if (carried === undefined) compactedThreads += 1
        unsummarized -= sources.length
        carried = summary
      }
    }
    return { compactedThreads, deletedMessages }
  })
