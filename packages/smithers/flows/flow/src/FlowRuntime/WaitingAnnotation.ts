// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Declares how a flow is about to wait before it suspends.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { FlowInstance } from "./FlowInstance.ts"

/**
 * The waiting classification a flow can declare before suspending.
 *
 * Mirrors the durable store's waiting payload: `reason` is the supervisor
 * vocabulary (`approval`, `event`, `timer`, `quota`, or a plugin-defined
 * reason), `wakeAt` an absolute deadline, and `token` compare-and-swap
 * material a wake handler matches against.
 *
 * `request` is what the wait declares ABOUT itself, as JSON text, for a reader
 * rather than for a matcher: the question a `HumanTask` is parked on, its
 * kind, and its attempt budget. Nothing routes on it. It exists because `reason` and `token`
 * say only that a person owes the run an answer and which wait point holds it,
 * so an approvals inbox reading a parked run could name the gate and never
 * state the question — which is what left run-3's `coding-clarification`
 * unanswerable.
 *
 * @category models
 * @since 0.1.0
 */
export interface WaitingAnnotation {
  readonly reason: string
  readonly wakeAt?: number | undefined
  readonly token?: string | undefined
  readonly request?: string | undefined
}

/**
 * Schema for {@link WaitingAnnotation}, the one encodable spelling of the
 * waiting vocabulary. `Flow.Park` carries it so a parking request and the
 * annotation that precedes a suspension cannot describe different waits.
 *
 * @category schemas
 * @since 0.1.0
 */
export const WaitingAnnotation = Schema.Struct({
  reason: Schema.String,
  wakeAt: Schema.optional(Schema.Number),
  token: Schema.optional(Schema.String),
  // JSON TEXT, not a decoded value. `Flow.Park` carries this struct, and a
  // recursive `Json` schema here pushed `Flow.Outcome`'s inference past
  // TypeScript's instantiation depth; a string also keeps one spelling of the
  // question from the declaring flow all the way to the durable column, which
  // stores exactly this text under a `json_valid` check.
  request: Schema.optional(Schema.String)
})

/**
 * Declares how the flow is about to wait, so a durable driver parks the run
 * with that reason and token instead of the derived `timer`/`event` default.
 *
 * The annotation is scoped to the wait it precedes: once the awaited
 * deferred passes through with a persisted result — including replays after
 * the wait resolved — the declared classification is consumed, so a later
 * suspension parks under its own reason (and keeps its timer `wakeAt`)
 * instead of the stale one (issue #42).
 *
 * Call it immediately before awaiting the deferred that models the wait:
 *
 * ```ts
 * yield* FlowRuntime.annotateWaiting({ reason: "approval", token: requestId })
 * const decision = yield* DurableDeferred.await(approvalGate)
 * ```
 *
 * @category combinators
 * @since 0.1.0
 */
export const annotateWaiting = (
  waiting: WaitingAnnotation | undefined
): Effect.Effect<void, never, FlowInstance> =>
  Effect.gen(function*() {
    const instance = yield* FlowInstance
    instance.waiting = waiting
  })
