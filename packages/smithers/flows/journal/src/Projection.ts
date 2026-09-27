/**
 * Reproducible journal projections.
 *
 * @since 0.1.0
 */

import type * as Effect from "effect/Effect"
import type { Entry } from "./JournalEvent.ts"

/**
 * An effectful fold over committed journal entries.
 *
 * Projections have no independent durable state. Replaying the same entries
 * through the same reducer must reproduce the same result.
 *
 * @category models
 * @since 0.1.0
 */
export interface Projection<S, E = never, R = never> {
  readonly name: string
  readonly initial: S
  readonly reduce: (state: S, entry: Entry) => Effect.Effect<S, E, R>
}

/**
 * Constructs a reproducible journal projection.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <S, E = never, R = never>(projection: Projection<S, E, R>): Projection<S, E, R> => projection
