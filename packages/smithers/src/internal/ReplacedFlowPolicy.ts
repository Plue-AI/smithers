/**
 * Product entry points replaced by the pinned TODO composition (E-19).
 * Verify and review remain ordinary engine launches. Existing journals and
 * recovery codecs remain readable; this fence applies only to registration.
 *
 * @since 1.0.0
 */

import { FlowRuntime } from "@smthrs/flow"
import { Effect, Layer } from "effect"
import { Refused } from "../CliError.ts"

/**
 * Wraps `FlowRuntime` so registering `coding/Request` or `coding/Vibe` dies with
 * an `entry_point_replaced` refusal (`replaced: <tag> ...`); every other flow
 * registers unchanged.
 *
 * @since 1.0.0
 * @private
 */
export const layer = Layer.effect(FlowRuntime.FlowRuntime)(Effect.map(FlowRuntime.FlowRuntime, (runtime) => ({
  ...runtime,
  register: ((flow, handler, options) =>
    Effect.suspend(() =>
      flow._tag === "coding/Request" || flow._tag === "coding/Vibe"
        ? Effect.die(
          new Refused({
            fault: "policy",
            code: "entry_point_replaced",
            message: `replaced: ${flow._tag} no longer starts work; start a TODO instead`
          })
        )
        : runtime.register(flow, handler, options)
    )) as typeof runtime.register
})))
