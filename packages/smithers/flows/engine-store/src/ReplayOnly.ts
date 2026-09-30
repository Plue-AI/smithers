/**
 * An engine that replays recorded work and executes none.
 *
 * `smthrs runs verify` asks what a resume under the current code would do
 * before anything runs: which recorded steps it would serve from their
 * durable records, and which step it would execute again because its key no
 * longer matches one. The engine is the only thing that can answer, because a
 * step key is derived at dispatch from the running flow's own declaration,
 * ordinal and scope. This service turns a durable engine into that question:
 * a dispatch served from a durable record reports `replayed`, and the first
 * dispatch that would run an action body reports `would-execute` and dies with
 * {@link WouldExecute} before any attempt row, snapshot, boundary or body.
 *
 * The death is a defect on purpose. A typed failure would enter the action's
 * retry policy, and the default policy never gives up; a defect is never
 * retried, so the run settles with the verdict instead of spinning on it.
 *
 * Run it against a copy of the store. A replay still converges the journal
 * rows a resume would write, and the run settles `failed` on the copy.
 *
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

/**
 * One dispatch a replay-only engine saw.
 *
 * `stepKeyDigest` is the identity `flows_attempts` rows are keyed on, so a
 * reader joins it to the recorded attempts directly. `action` is the declared
 * action name. `outcome` is `replayed` for a dispatch served from a durable
 * record (a recorded failure included) and `would-execute` for the dispatch
 * that would have run its body.
 *
 * @since 1.0.0
 * @category models
 */
export interface Dispatch {
  readonly runId: string
  readonly stepKeyDigest: string
  readonly attempt: number
  readonly action: string
  readonly tier: "sealed" | "compensable" | "irreversible"
  readonly outcome: "replayed" | "would-execute"
}

/**
 * Receives every dispatch a replay-only engine settles, in settlement order.
 *
 * @since 1.0.0
 * @category models
 */
export interface Service {
  readonly observe: (dispatch: Dispatch) => Effect.Effect<void>
}

/**
 * Service tag. An engine composed with it in context executes no action body.
 *
 * @since 1.0.0
 * @category services
 */
export class ReplayOnly extends Context.Service<ReplayOnly, Service>()("@smthrs/engine-store/ReplayOnly") {}

/**
 * The defect a replay-only dispatch dies with instead of executing.
 *
 * @since 1.0.0
 * @category errors
 */
export class WouldExecute extends Schema.TaggedError<WouldExecute>()("@smthrs/engine-store/WouldExecute", {
  runId: Schema.String,
  stepKeyDigest: Schema.String,
  attempt: Schema.Number,
  action: Schema.String
}) {
  override get message(): string {
    return `Action ${this.action} (step ${this.stepKeyDigest}, attempt ${this.attempt}) would execute`
  }
}

/**
 * Provides a replay-only engine context that reports to `observe`.
 *
 * @since 1.0.0
 * @category layers
 */
export const layer = (observe: Service["observe"]): Layer.Layer<ReplayOnly> =>
  Layer.succeed(ReplayOnly, ReplayOnly.of({ observe }))
