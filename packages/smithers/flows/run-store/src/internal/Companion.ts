/**
 * The run store's companion journal stream.
 *
 * Facts the run store records about a run go to the run's `run-store`
 * companion stream (`JournalEvent.companionRunId`), never to the run's own
 * stream: engine, control, and time-travel consumers read that stream by
 * position, and a rewind or compaction of it must not truncate a store fact.
 *
 * @since 1.0.0
 * @private
 */

import { Journal, type JournalError } from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import { Effect, Option } from "effect"

/**
 * The companion stream name.
 *
 * @since 1.0.0
 * @private
 */
export const stream = "run-store"

/**
 * The producer every run-store fact is appended under.
 *
 * @since 1.0.0
 * @private
 */
export const sourceId = "flows.run-store"

/**
 * Appends one fact to the run's companion stream through the journal in the
 * caller's context.
 *
 * The journal is resolved at call time: the ordinary composition builds the
 * store beside the journal (`Layer.mergeAll(SqlJournal.layer(...),
 * RunStore.layer)`), so the journal reaches the store only through the
 * caller's context. A caller running without a journal records nothing. The
 * append is unfenced — the store arbitrated the change in the same serialized
 * transaction — and joins that transaction as a savepoint, so a rolled-back
 * change leaves no fact.
 *
 * @since 1.0.0
 * @private
 */
export const append = (
  runId: string,
  eventType: string,
  payload: Readonly<Record<string, unknown>>
): Effect.Effect<void, JournalError> =>
  Effect.flatMap(Effect.serviceOption(Journal), (journal) =>
    Option.isNone(journal)
      ? Effect.void
      : journal.value.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: JournalEvent.companionRunId(stream, runId),
          sourceId: sourceId as JournalEvent.SourceId,
          eventType,
          payload: { runId, ...payload },
          meta: { runId }
        })
      ).pipe(Effect.asVoid))
