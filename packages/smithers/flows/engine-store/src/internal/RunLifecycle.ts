/**
 * Logical-run resolution shared by cancellation and child lifetime decisions.
 * Round membership comes from RunStore; child ownership comes from the durable
 * DAG. A parent_run_id alone is not membership (forks also use that column).
 * Call these reads inside the same write transaction as the lifecycle change.
 *
 * @since 1.0.0
 */

import type { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import type * as DurableEngineState from "../DurableEngineState.ts"

/**
 * Binds logical-run reads to the same stores as the owning engine.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (store: RunStore.Service, state: DurableEngineState.Service) => {
  const rounds = (runId: string) => store.lineage(runId)

  /** All other rounds and linked descendants, including earlier-round children. */
  const descendants = (runId: string): Effect.Effect<ReadonlyArray<string>, RunStore.RunStoreError> =>
    Effect.gen(function*() {
      const seen = new Set<string>([runId])
      const resolved = new Set<string>()
      const ordered: Array<string> = []
      const frontier = [runId]
      for (let index = 0; index < frontier.length; index++) {
        const parentId = frontier[index]!
        const admit = (id: string) => {
          if (seen.has(id)) return
          seen.add(id)
          ordered.push(id)
          frontier.push(id)
        }
        if (!resolved.has(parentId)) {
          resolved.add(parentId)
          for (const round of yield* rounds(parentId)) {
            resolved.add(round.runId)
            admit(round.runId)
          }
        }
        // Even a missing row can retain edges during external archival. Walk
        // those edges rather than interpreting a missing parent as no children.
        for (const edge of yield* state.runChildren(parentId)) admit(edge.childId)
      }
      return ordered
    })

  return { rounds, descendants }
}
