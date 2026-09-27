/**
 * The polling source contract every long-poll integration shares.
 *
 * A source polls from a stored cursor, hands the events it found to the
 * caller, and proposes the cursor that acknowledges them. `runWithCursor` is
 * the loop around that: it reads the cursor, polls, runs the handler, and
 * commits the proposed cursor only after the handler succeeds. A process that
 * dies mid-batch therefore re-polls the batch instead of skipping it, and the
 * redelivered events are dropped downstream on their dedupe keys.
 *
 * A poll that finds nothing proposes no cursor, which leaves the stored one
 * alone.
 *
 * @since 1.0.0
 */

import { Effect, Schedule } from "effect"
import { CursorStore } from "./CursorStore.ts"
import type { ExternalEvent } from "./ExternalEvent.ts"
import type { IntegrationError } from "./IntegrationError.ts"

/**
 * One poll turn's result.
 *
 * `cursor` is the position to commit once `events` are handled. It is absent
 * when the poll returned nothing, which leaves the stored cursor alone.
 *
 * @category models
 * @since 1.0.0
 */
export interface Batch {
  readonly events: ReadonlyArray<ExternalEvent>
  readonly cursor?: string | undefined
}

/**
 * How `run` repeats its turns.
 *
 * @category models
 * @since 1.0.0
 */
export interface RunOptions {
  /**
   * The schedule between turns. Defaults to polling forever with 250
   * milliseconds between turns; a finite schedule ends the loop normally.
   */
  readonly schedule?: Schedule.Schedule<unknown> | undefined
}

/**
 * A polling source bound to one cursor.
 *
 * @category services
 * @since 1.0.0
 */
export interface Source {
  /** The source id, which is also the cursor key and the dedupe scope. */
  readonly sourceId: string
  /** One poll turn against `cursor`. Commits nothing. */
  readonly poll: (cursor: string | null) => Effect.Effect<Batch, IntegrationError>
  /**
   * Reads the cursor, polls, hands the batch to `onBatch`, and commits the
   * proposed cursor only after `onBatch` succeeds, turn after turn.
   */
  readonly run: <E, R>(
    onBatch: (events: ReadonlyArray<ExternalEvent>) => Effect.Effect<void, E, R>,
    options?: RunOptions | undefined
  ) => Effect.Effect<void, IntegrationError | E, R | CursorStore>
}

/**
 * The default spacing between turns.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_SCHEDULE: Schedule.Schedule<unknown> = Schedule.spaced("250 millis")

/**
 * The commit-after-handle loop.
 *
 * Each turn reads `sourceId`'s cursor from the `CursorStore`, runs `poll`
 * (which owns its own retry policy), runs `onBatch` with the events, and only
 * then stores the proposed cursor. A failure in `poll` or `onBatch` ends the
 * loop with the cursor where it was.
 *
 * @category constructors
 * @since 1.0.0
 */
export const runWithCursor = <EP, RP, E, R>(
  sourceId: string,
  poll: (cursor: string | null) => Effect.Effect<Batch, EP, RP>,
  onBatch: (events: ReadonlyArray<ExternalEvent>) => Effect.Effect<void, E, R>,
  options?: RunOptions | undefined
): Effect.Effect<void, EP | E | IntegrationError, RP | R | CursorStore> =>
  Effect.gen(function*() {
    const cursors = yield* CursorStore
    const turn = Effect.gen(function*() {
      const cursor = yield* cursors.get(sourceId)
      const batch = yield* poll(cursor)
      yield* onBatch(batch.events)
      if (batch.cursor !== undefined) yield* cursors.set(sourceId, batch.cursor)
    })
    return yield* Effect.asVoid(Effect.repeat(turn, options?.schedule ?? DEFAULT_SCHEDULE))
  })
