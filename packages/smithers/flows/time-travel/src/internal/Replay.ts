/**
 * Deriving a run's past state from committed journal evidence alone.
 *
 * This is what makes a frame an address rather than a snapshot: nothing stores
 * "the state at seq 17", so {@link rederive} folds the journal prefix up to a
 * frame through a caller-supplied {@link Projection}. It reads only durable
 * evidence — entries and sealed cache results — and has no dispatcher, so a
 * replay can never re-execute a model call or a child flow. Anything not
 * committed simply is not in the answer.
 *
 * Entries are filtered by lineage, so a run whose journal interleaves several
 * lineages replays exactly the one the frame names.
 *
 * The fold STREAMS. `Journal.entries` hands pages back in sequence order, so
 * each page is folded as it arrives and the read stops at the first record
 * past the frame; nothing below the frame is retained once it has been folded.
 * The prefix used to be collected whole and sorted before the first reduce, so
 * a frame near the head of a long run still paid for the run's whole history.
 *
 * @since 0.1.0
 */

import * as EngineEvent from "@smthrs/journal/EngineEvent"
import * as Journal from "@smthrs/journal/Journal"
import type { Entry } from "@smthrs/journal/JournalEvent"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { Frame } from "../Frame.ts"
import { error, type TimeTravelError } from "../TimeTravelError.ts"
import * as HistoryLimit from "./HistoryLimit.ts"
import * as JournalPages from "./JournalPages.ts"
import { LineageMetadata } from "./LineageMetadata.ts"

/**
 * A pure fold over durable journal evidence.
 *
 * @since 0.1.0
 * @category models
 */
export interface Projection<S> {
  readonly initial: S
  readonly reduce: (state: S, entry: Entry, sealed: unknown | undefined) => S
}
/**
 * Which run to replay, and how large a journal page to read at a time.
 *
 * `pageSize` is a throughput knob only — it never changes the derived state,
 * because the fold sees the same entries in the same order whatever the page
 * boundaries are. It defaults to 100.
 *
 * @since 0.1.0
 * @category models
 */
export interface ReplayOptions {
  readonly runId: string
  /** Required when replay encounters v2 engine events; supplied by the history owner. */
  readonly engineEvents?: EngineEvent.Consumer | undefined
  readonly pageSize?: number
  /**
   * The most entries the fold may read at or below the frame before it stops
   * with `limit_exceeded`. Defaults to `HistoryLimit.defaultMaxHistoryEntries`.
   */
  readonly maxEntries?: number
}
/** @private */
const CacheMetadata = Schema.Struct({ cacheKey: Schema.NonEmptyString })
/**
 * Re-derives a projection from committed evidence only. This deliberately has
 * no dispatcher dependency: model and child results can only be cache reads.
 * @since 0.1.0
 * @category constructors
 */
export const rederive = <S>(
  frame: Frame,
  projection: Projection<S>,
  options: ReplayOptions
): Effect.Effect<S, TimeTravelError, Journal.Journal | CacheStore.CacheStore> =>
  Effect.fn("Replay.rederive")(() =>
    Effect.gen(function*() {
      yield* Effect.annotateCurrentSpan({
        runId: options.runId,
        lineageId: frame.lineageId,
        seq: frame.seq
      })
      const journal = yield* Journal.Journal
      const cache = yield* CacheStore.CacheStore
      const maxEntries = options.maxEntries ?? HistoryLimit.defaultMaxHistoryEntries
      const fold = (entry: Entry, state: S): Effect.Effect<S, TimeTravelError> =>
        Effect.gen(function*() {
          const cacheKey = Option.getOrUndefined(
            Schema.decodeUnknownOption(CacheMetadata)(entry.meta)
          )?.cacheKey
          // The provenance fence keeps the projection durable: the version this
          // exact record landed answers first, and only an entry recorded
          // elsewhere falls back to the shared content-addressed head.
          const sealed = cacheKey === undefined
            ? undefined
            : yield* cache.get(cacheKey, { recordedBy: { runId: options.runId, eventSeq: entry.seq } }).pipe(
              Effect.mapError((cause) => error("unknown", "could not read sealed result", cause)),
              Effect.map((cached) => cached._tag === "Some" ? cached.value.result : undefined)
            )
          return projection.reduce(state, entry, sealed)
        })
      let state = projection.initial
      let foundLineage = false
      let folded = 0
      /**
       * Each page is normalized before it is folded: one record per
       * coordinate, ordered by seq. A page may repeat a record or list two out
       * of order, and the durable projection is a function of the run's
       * records, never of how a reader happened to page them. ACROSS pages the
       * journal contract is sequence order, so a coordinate the fold has passed
       * is a duplicate when it was folded and corrupt evidence when it was not;
       * the old whole-prefix sort would have silently slotted it in.
       */
      const seen = new Set<number>()
      let lastSeq = -1
      yield* JournalPages.forEachPage(
        journal,
        {
          runId: options.runId,
          pageSize: options.pageSize ?? 100,
          label: "journal replay",
          readFailure: "could not read journal"
        },
        (entries) =>
          Effect.gen(function*() {
            const ordered = [...entries].sort((left, right) => left.seq - right.seq)
            for (const entry of ordered) {
              if (seen.has(entry.seq)) continue
              if (entry.seq < lastSeq) {
                return yield* Effect.fail(
                  error("invalid", `journal replay returned seq ${entry.seq} after seq ${lastSeq} for ${options.runId}`)
                )
              }
              if (entry.seq > frame.seq) return JournalPages.Stop
              seen.add(entry.seq)
              lastSeq = entry.seq
              folded += 1
              if (folded > maxEntries) {
                return yield* Effect.fail(HistoryLimit.exceeded("replay", options.runId, maxEntries))
              }
              let lineageId: string | undefined
              if (/^flows\.engine\.v[0-9]+(?:\.|$)/.test(entry.eventType)) {
                const consumer = options.engineEvents
                if (
                  consumer === undefined || consumer.runId !== options.runId || consumer.lineageId !== frame.lineageId
                ) {
                  return yield* Effect.fail(
                    error("invalid", "versioned engine replay requires the matching lineage and source contract", {
                      runId: entry.runId,
                      seq: entry.seq,
                      eventId: entry.eventId,
                      eventType: entry.eventType,
                      expected: { runId: options.runId, lineageId: frame.lineageId }
                    })
                  )
                }
                yield* EngineEvent.decodeEntry(entry, consumer).pipe(
                  Effect.mapError((cause) => error("invalid", "invalid versioned engine history", cause))
                )
                lineageId = consumer.lineageId
              } else {
                lineageId = Option.getOrUndefined(Schema.decodeUnknownOption(LineageMetadata)(entry.meta))?.lineageId
              }
              if (lineageId !== undefined && lineageId !== frame.lineageId) continue
              if (lineageId === frame.lineageId) foundLineage = true
              state = yield* fold(entry, state)
            }
          })
      )
      if (!foundLineage) {
        return yield* Effect.fail(error("not_found", `lineage ${frame.lineageId} is not present in ${options.runId}`))
      }
      return state
    })
  )()
