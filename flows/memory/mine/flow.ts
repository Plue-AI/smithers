/**
 * `memory/mine` as a file flow: one action over a finished run's journal. A
 * host supplies the implementation with {@link layer}, binding the workspace
 * root and the memory bank itself through {@link Binding}; neither is ever
 * part of the payload, and the flow is not model-invocable, so no agent can
 * point it at another bank or another tree. The layer also needs the memory
 * store, the Jev evaluator and a filesystem.
 */
import { Action, Flow } from "@smthrs/flow"
import { Context, Effect, Layer } from "effect"
import * as Mine from "../mine.ts"

export const Run = Action.make("memory/mine/run", {
  payload: Mine.Payload,
  success: Mine.Output,
  error: Mine.MineFailed,
  nondeterministic: true
})

export default Flow.make("memory/mine", {
  description:
    "Mine a finished run's journal: durable facts to memory, human decisions to the item's wiki page, factory issues back to the caller.",
  capabilities: ["fs:read:**", "fs:write:factory/wiki/decisions/**", "memory:write:**", "model:call:typesafe-ai/jev"],
  effects: {
    reads: ["**", "memory/**"],
    writes: ["factory/wiki/decisions/**", "memory/**"],
    mode: "expected",
    onConflict: "serialize",
    tier: "irreversible"
  },
  modelInvocable: false,
  payload: Mine.Payload,
  success: Mine.Output,
  error: Mine.MineFailed,
  body: (input) => Run.call(input)
})

/** The workspace root and memory bank a host binds this flow to. */
export class Binding extends Context.Service<Binding, Mine.Host>()("memory/mine/Binding") {}

/** The implementation of {@link Run}, writing under `host.root` and to `host.bank`. */
export const make = (host: Mine.Host) => Run.toLayer((payload) => Mine.mine({ ...payload, ...host }))

/** {@link make} over the host's {@link Binding}: the layer a host loads. */
export const layer = Layer.unwrap(Effect.gen(function*() {
  return make(yield* Binding)
}))
