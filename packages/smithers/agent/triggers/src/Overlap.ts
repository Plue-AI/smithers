/**
 * Pure overlap policy decisions.
 *
 * @since 0.1.0
 */

import type { Overlap as Policy } from "./Schedule.ts"

/**
 * What the overlap decision is made from: whether a run is in flight, the
 * buffered occurrence if any, and the occurrence now due.
 *
 * @category models
 * @since 0.1.0
 */
export interface State {
  readonly running: boolean
  readonly pending?: number | undefined
  readonly due: number
}
/**
 * What to do with an occurrence that arrived while a run was in flight.
 *
 * @category models
 * @since 0.1.0
 */
export type Action = "fire" | "skip" | "buffer" | "supersede"

/**
 * Applies the overlap policy to the current state.
 *
 * @category decision
 * @since 0.1.0
 */
export const decide = (policy: Policy, state: State): Action => {
  if (!state.running) return "fire"
  switch (policy) {
    case "skip":
      return "skip"
    case "buffer-one":
      return "buffer"
    case "supersede":
      return "supersede"
  }
}

/**
 * The occurrence left buffered after this decision.
 *
 * @category decision
 * @since 0.1.0
 */
export const pendingAfter = (state: State): number => Math.max(state.pending ?? Number.NEGATIVE_INFINITY, state.due)
