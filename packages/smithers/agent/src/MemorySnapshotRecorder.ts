/**
 * The durable implementation of `@smthrs/memory/SnapshotRecorder`.
 *
 * Memory declares the port and remains below the harness. This adapter lives
 * in `@smthrs/agent`, which already depends on both packages, and translates a
 * snapshot identity into an `EngineLike.record` boundary that holds the
 * snapshot's rows.
 *
 * @since 0.1.0
 */

import * as EngineLike from "@smthrs/harness/EngineLike"
import * as SnapshotRecorder from "@smthrs/memory/SnapshotRecorder"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const record = <R>(
  engine: EngineLike.EngineLike,
  identity: SnapshotRecorder.Identity,
  effect: Effect.Effect<SnapshotRecorder.Snapshot, never, R>
): Effect.Effect<SnapshotRecorder.Snapshot, never, R> =>
  Effect.gen(function*() {
    const services = yield* Effect.context<R>()
    return yield* engine.record({
      name: "memory-snapshot",
      identity: {
        session: identity.lineageId,
        frame: identity.iteration,
        boundary: "opening-context"
      },
      success: SnapshotRecorder.Snapshot,
      execute: Effect.provideContext(effect, services)
    }).pipe(
      // Continuing with a live value after the recorder fails would recreate
      // the replay divergence this adapter exists to prevent.
      Effect.orDie
    )
  })

/**
 * Builds the memory recorder backed by a harness engine.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (engine: EngineLike.EngineLike): SnapshotRecorder.Service => {
  const service: SnapshotRecorder.Service = {
    record: (identity, effect) => record(engine, identity, effect)
  }
  return SnapshotRecorder.SnapshotRecorder.of(service)
}

/**
 * Provides durable opening-memory snapshots through the current harness
 * engine.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<SnapshotRecorder.SnapshotRecorder, never, EngineLike.EngineLike> = Layer.effect(
  SnapshotRecorder.SnapshotRecorder
)(Effect.map(EngineLike.EngineLike, make))
