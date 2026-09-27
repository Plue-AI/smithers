/**
 * Optional host boundary for freezing an opening memory snapshot beyond the
 * process that fetched it.
 *
 * The port deliberately knows nothing about engines or journals. A host that
 * can persist a value implements {@link Service.record}; a memory-only
 * composition supplies no service and {@link module:Source} retains its local
 * memo behavior.
 *
 * @since 0.1.0
 */

import { Context, Layer, Schema } from "effect"
import type { Effect } from "effect"

/**
 * One row of an opening memory snapshot, unrendered: a note primed from
 * `bank`, or a row recall answered from it. `key` identifies the row to a
 * relevance reading: the note id for a primer, else the digest of its text,
 * and the recall key for a recalled row.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Row = Schema.Struct({
  origin: Schema.Literals(["primer", "recall"]),
  bank: Schema.String,
  key: Schema.String,
  text: Schema.String
})

/**
 * The decoded form of {@link Row}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Row = typeof Row.Type

/**
 * The value one opening memory snapshot holds: its rows, in render order.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Snapshot = Schema.Struct({ rows: Schema.Array(Row) })

/**
 * The decoded form of {@link Snapshot}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Snapshot = typeof Snapshot.Type

/**
 * The stable identity of one opening memory snapshot.
 *
 * @category models
 * @since 0.1.0
 */
export interface Identity {
  readonly lineageId: string
  readonly iteration: number
}

/**
 * A recorder that either returns the value held for `identity` or evaluates
 * and records `effect` before returning it.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
  readonly record: <R>(
    identity: Identity,
    effect: Effect.Effect<Snapshot, never, R>
  ) => Effect.Effect<Snapshot, never, R>
}

/**
 * The optional opening-memory recorder tag.
 *
 * @category services
 * @since 0.1.0
 */
export class SnapshotRecorder extends Context.Service<SnapshotRecorder, Service>()(
  "flows/memory/SnapshotRecorder"
) {}

/**
 * Provides a snapshot recorder.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (implementation: Service): Layer.Layer<SnapshotRecorder> =>
  Layer.succeed(SnapshotRecorder)(SnapshotRecorder.of(implementation))
