/**
 * What one scheduler process knows about the run each trigger owns.
 *
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import type * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"

/**
 * What this process knows about the run one trigger currently owns: which
 * occurrence claimed it, the reservation or run id the store holds for it, and
 * the monitor fiber when this process is the one watching it.
 *
 * `runId` is always known. A claim that hands out work names the reservation it
 * wrote, and a recovered entry is read back from the store, so an entry with
 * nothing to release cannot be constructed.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export interface Active {
  readonly occurrence: number
  readonly runId: string
  readonly fiber?: Fiber.Fiber<void> | undefined
}

/**
 * The entries of one scheduler, keyed by trigger id.
 *
 * `take` is the only unfenced write: an occurrence that claimed the trigger,
 * or a run recovered from the store, replaces whatever entry was there. Every
 * later write is fenced on the occurrence that took the entry, so one guard
 * states the rule once: a launch that has been superseded, or whose run
 * already settled, no longer owns the entry and must not write to it. Spelling
 * the fence out at each site is how the three copies of it drifted apart.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export interface ActiveRuns {
  readonly get: (triggerId: string) => Effect.Effect<Active | undefined>
  readonly take: (triggerId: string, entry: Active) => Effect.Effect<void>
  readonly update: (
    triggerId: string,
    occurrence: number,
    change: (entry: Active) => Active
  ) => Effect.Effect<void>
  readonly remove: (triggerId: string, occurrence: number) => Effect.Effect<void>
}

/**
 * Allocates an empty set of entries.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const make: Effect.Effect<ActiveRuns> = Effect.map(
  Ref.make<ReadonlyMap<string, Active>>(new Map()),
  (entries) => {
    const fenced = (
      triggerId: string,
      occurrence: number,
      change: (entry: Active) => Active | undefined
    ): Effect.Effect<void> =>
      Ref.update(entries, (current) => {
        const entry = current.get(triggerId)
        if (entry?.occurrence !== occurrence) return current
        const next = new Map(current)
        const updated = change(entry)
        if (updated === undefined) next.delete(triggerId)
        else next.set(triggerId, updated)
        return next
      })
    return {
      get: (triggerId) => Effect.map(Ref.get(entries), (current) => current.get(triggerId)),
      take: (triggerId, entry) => Ref.update(entries, (current) => new Map(current).set(triggerId, entry)),
      update: fenced,
      remove: (triggerId, occurrence) => fenced(triggerId, occurrence, () => undefined)
    }
  }
)
