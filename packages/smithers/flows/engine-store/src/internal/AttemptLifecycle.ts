/**
 * Complete attempt-history projection. The attempt store remains authoritative;
 * only v2 histories contain enough evidence to rebuild this projection.
 *
 * @since 1.0.0
 */

import * as EngineEvent from "@smthrs/journal/EngineEvent"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import type * as Projection from "@smthrs/journal/Projection"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * An attempt state with completion data required only at completion.
 *
 * @category schemas
 * @since 1.0.0
 */
export const AttemptLifecycle = EngineEvent.AttemptLifecycle
/**
 * An attempt state with completion data required only at completion.
 *
 * @category models
 * @since 1.0.0
 */
export type AttemptLifecycle = EngineEvent.AttemptLifecycle
/**
 * Validate untrusted encoded state without dropping contradictory fields.
 *
 * @category decoders
 * @since 1.0.0
 */
export const decode = (input: unknown) =>
  Effect.suspend(() => Schema.decodeUnknownEffect(AttemptLifecycle, { onExcessProperty: "error" })(input)).pipe(
    Effect.catchCause((cause) =>
      Effect.fail(
        new EngineEvent.EventError({
          code: "malformed",
          message: "invalid attempt lifecycle",
          cause: Cause.squash(cause)
        })
      )
    )
  )

/**
 * The latest complete journal state for one attempt.
 *
 * @category models
 * @since 1.0.0
 */
export interface Row {
  readonly executionId: string
  readonly stepKeyDigest: string
  readonly attempt: number
  readonly seq: number
  readonly lifecycle: AttemptLifecycle
}

/**
 * Attempt projection rows, independent of executable engine storage.
 *
 * @category models
 * @since 1.0.0
 */
export type State = ReadonlyArray<Row>

/**
 * A versioned retained projection. Its sequence covers every included row.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Snapshot = Schema.Struct({
  version: Schema.Literal(2),
  lineage: EngineEvent.Lineage,
  seq: JournalEvent.Seq,
  rows: Schema.Array(Schema.Struct({
    executionId: JournalEvent.Identifier,
    stepKeyDigest: JournalEvent.Identifier,
    attempt: JournalEvent.NonNegativeQuantity,
    seq: JournalEvent.Seq,
    lifecycle: AttemptLifecycle
  }))
}).check(
  Schema.makeFilter((snapshot) =>
    snapshot.rows.every((row) => row.seq <= snapshot.seq && row.executionId === snapshot.lineage.runId) &&
    new Set(snapshot.rows.map((row) => JSON.stringify([row.executionId, row.stepKeyDigest, row.attempt]))).size ===
      snapshot.rows.length
  )
)

/**
 * Decode retained state and check all lineage coordinates before suffix replay.
 * Source admission still applies independently to every suffix event.
 *
 * @category decoders
 * @since 1.0.0
 */
export const restore = (input: unknown, consumer: EngineEvent.Consumer) =>
  Effect.suspend(() => Schema.decodeUnknownEffect(Snapshot, { onExcessProperty: "error" })(input)).pipe(
    Effect.flatMap((snapshot) => {
      const lineage = snapshot.lineage
      return lineage.runId !== consumer.runId || lineage.lineageId !== consumer.lineageId ||
          lineage.rootRunId !== consumer.rootRunId || lineage.round !== consumer.round ||
          lineage.parentRunId !== consumer.parentRunId
        ? Effect.fail(
          new EngineEvent.EventError({
            code: "foreign",
            message: "attempt snapshot is outside the consumer lineage",
            cause: lineage
          })
        )
        : Effect.succeed(snapshot)
    }),
    Effect.catchCause((failure) => {
      const cause = Cause.squash(failure)
      return Effect.fail(
        cause instanceof EngineEvent.EventError ?
          cause
          : new EngineEvent.EventError({ code: "malformed", message: "invalid attempt snapshot", cause })
      )
    })
  )

/**
 * Reduces full lifecycle records with monotonic sequence and legal state
 * transitions. A missing start is incomplete history, never terminal success.
 *
 * @category projections
 * @since 1.0.0
 */
export const projection = (consumer: EngineEvent.Consumer): Projection.Projection<State, EngineEvent.EventError> => ({
  name: "flows/engine/attempts/v2",
  initial: [],
  reduce: (state, entry) =>
    Effect.gen(function*() {
      const decoded = yield* EngineEvent.decodeEntry(entry, consumer)
      if (decoded._tag !== "Attempt") return state
      const { attempt, executionId, lifecycle, stepKeyDigest } = decoded.payload
      const previous = state.find((row) =>
        row.executionId === executionId && row.stepKeyDigest === stepKeyDigest && row.attempt === attempt
      )
      if (
        previous === undefined
          ? lifecycle.state !== "running"
          : entry.seq <= previous.seq || previous.lifecycle.state === "succeeded" ||
            previous.lifecycle.state === "failed" || lifecycle.startedAtMs !== previous.lifecycle.startedAtMs
      ) {
        return yield* Effect.fail(
          new EngineEvent.EventError({
            code: "transition",
            message: "attempt history has a missing start, reordered record or transition after completion",
            cause: { previous, entry }
          })
        )
      }
      const row: Row = { executionId, stepKeyDigest, attempt, seq: entry.seq, lifecycle }
      return [...state.filter((candidate) => candidate !== previous), row]
    })
})
