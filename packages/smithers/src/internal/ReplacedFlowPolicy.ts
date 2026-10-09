/** Product entry points replaced by the pinned TODO composition (E-19).
 * Verify and review remain ordinary engine launches. Existing journals and
 * recovery codecs remain readable; this fence applies only to registration.
 */
import { FlowRuntime } from "@smthrs/flow"
import { Effect, Layer } from "effect"

export const layer = Layer.effect(FlowRuntime.FlowRuntime)(Effect.map(FlowRuntime.FlowRuntime, (runtime) => ({
  ...runtime,
  register: ((flow, handler, options) => Effect.suspend(() =>
    flow._tag === "coding/Request" || flow._tag === "coding/Vibe"
      ? Effect.die(new Error(`replaced: ${flow._tag}`))
      : runtime.register(flow, handler, options)
  )) as typeof runtime.register
})))
