// Deep reviewed and polished by a human on 2026-08-10.

/**
 * The per-execution state contract flow authoring APIs read and update.
 *
 * @since 0.1.0
 */

import type * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import type * as Latch from "effect/Latch"
import type * as Scope from "effect/Scope"
import type * as Flow from "../Flow/index.ts"
import type { WaitingAnnotation } from "./WaitingAnnotation.ts"

/**
 * Service that contains flow runtime state for one execution.
 *
 * **When to use**
 *
 * Use to read or update flow execution, suspension, interruption,
 * lifetime, failure, and action coordination state inside flow authoring
 * combinators and runtime implementations.
 *
 * **Details**
 *
 * The service stores the execution ID, flow definition, long-lived scope,
 * suspension and interruption flags, the stored failure cause, and action
 * coordination state for a single flow run. `@smthrs/flow` declares the
 * contract; a runtime — `@smthrs/engine` — constructs the value.
 *
 * @category services
 * @since 0.1.0
 */
export class FlowInstance extends Context.Service<
  FlowInstance,
  {
    /**
     * The flow execution ID.
     */
    readonly executionId: string

    /**
     * The journal lineage this execution's records address themselves to.
     *
     * `docs/concepts/the-runtime-port.md` makes a frame the journal position
     * `(lineageId, seq)`, and `docs/guides/run-a-child-flow.md` defines the
     * lineage id as the run id followed by the node-id path from the run root.
     * A runtime mints it; every durable record this execution writes carries it
     * as `meta.lineageId`, which is what lets `TimeTravel.inspect` fold an
     * ordinary engine journal at all.
     */
    readonly lineageId: string

    /**
     * The flow definition.
     */
    readonly flow: Flow.Any

    /**
     * A scope that represents the lifetime of the flow.
     *
     * It is only closed when the flow is completed.
     */
    readonly scope: Scope.Closeable

    /**
     * Whether the flow has requested to be suspended.
     */
    suspended: boolean

    /**
     * Whether the flow has requested to be interrupted.
     */
    interrupted: boolean

    /**
     * The waiting classification the flow declared for its next suspension
     * via `annotateWaiting`. Durable drivers read it when parking the
     * run so approval and quota waits (and their wake token) are
     * representable; when absent the driver derives `timer`/`event` from
     * durable state.
     */
    waiting: WaitingAnnotation | undefined

    /**
     * The next-round invocation this round settled with, when its body's root
     * value was a `to` rather than a `done`.
     *
     * A handoff is a settlement, not a failure and not a suspension, so it
     * cannot travel out through the effect's exit; `Flow.intoResult` reads the
     * slot and answers `Flow.Handoff` instead of `Flow.Complete`. The engine
     * then opens the next round under the same lineage
     * (`docs/concepts/trampoline-rounds.md`).
     */
    handoff: Flow.Handoff | undefined

    /**
     * When SuspendOnFailure is triggered, the cause of the failure is stored
     * here.
     */
    cause: Cause.Cause<never> | undefined

    readonly actionState: {
      count: number
      readonly latch: Latch.Latch
      readonly nextOrdinal: (scope: string) => number
      readonly snapshots: Map<string, unknown>
      /**
       * Allocation scopes with a keyless dispatch currently in flight
       * (issue #111). Indistinguishable invocations of one declaration are
       * allocation-ordered, so two in flight at once would take their
       * ordinals from the fiber schedule and a replay could swap their
       * recorded outcomes undetected; the engine refuses the second dispatch
       * instead. Distinct interpreter graph sites refine the scope and do not
       * contend here.
       */
      readonly keylessInFlight: Set<string>
    }
  }
>()("@smthrs/flow/FlowRuntime/FlowInstance") {}
