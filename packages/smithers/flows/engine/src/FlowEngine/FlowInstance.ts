/**
 * Construction of the per-execution state an engine hands to a flow run.
 *
 * @since 0.1.0
 */

import type { Flow, FlowRuntime } from "@smthrs/flow"
import * as Latch from "effect/Latch"
import * as Scope from "effect/Scope"
import * as Lineage from "./Lineage.ts"

/**
 * Creates the initial `FlowInstance` state for one flow execution.
 *
 * **When to use**
 *
 * Use when a runtime starts — or restarts, on resume — a flow run and needs
 * the mutable state its suspension, interruption, and action coordination
 * are tracked in.
 *
 * The returned `lineageId` keeps its {@link module:Lineage.JournalLineageId}
 * brand, so it cannot pass for a trampoline root execution id.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeInstance = (
  flow: Flow.Any,
  executionId: string,
  lineageDeadline?: Flow.LineageDeadline | undefined
): FlowRuntime.FlowInstance["Service"] & { readonly lineageId: Lineage.JournalLineageId } => {
  // Ordinals are counted per allocation scope, not per run: the engine
  // scopes action dispatches by declaration identity and an optional
  // structural interpreter site so a permuted fiber interleaving cannot
  // renumber distinguishable dispatches across a replay (issue #73).
  const ordinals = new Map<string, number>()
  // `satisfies` rather than `FlowInstance.of`, which would widen `lineageId`
  // to the port's `string` and drop the journal brand.
  return {
    executionId,
    // The run's own root lineage: a subflow is a separate run with a separate
    // journal, so nesting is a lineage EDGE rather than a longer id here.
    lineageId: Lineage.root(executionId),
    flow,
    ...(lineageDeadline === undefined ? {} : { lineageDeadline }),
    scope: Scope.makeUnsafe(),
    suspended: false,
    interrupted: false,
    waiting: undefined,
    handoff: undefined,
    cause: undefined,
    actionState: {
      count: 0,
      latch: Latch.makeUnsafe(),
      nextOrdinal: (scope: string) => {
        const next = (ordinals.get(scope) ?? 0) + 1
        ordinals.set(scope, next)
        return next
      },
      // Earliest pre-attempt handle; durable drivers recover it via actionSnapshot.
      snapshots: new Map(),
      keylessInFlight: new Set()
    }
  } satisfies FlowRuntime.FlowInstance["Service"]
}
