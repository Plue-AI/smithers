/**
 * The external-peer root as `flow start` approves it: start the external
 * worker, then park on its completion. Discovery projects this body
 * statically, so the plan carries the declared capabilities rather than `*`.
 * Copy it to `flows/external-peer/flow.ts` beside `external-peer-flow.ts`.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { Start, Wait } from "./external-peer-flow.ts"

export { layer } from "./external-peer-flow.ts"

export default Flow.make("external-peer", {
  description: "Park on an external worker that a live host runs.",
  capabilities: ["proc:spawn:**", "fs:read:**", "fs:write:**"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: { root: Schema.String },
  success: Schema.Number,
  error: Schema.Unknown,
  body: Node.capture(
    { start: Start.name, wait: Wait.name, implementationVersion: "external-peer/v1" },
    ({ root }) => Node.andThen(Start.call({ root }), Wait.call({}))
  )
})
