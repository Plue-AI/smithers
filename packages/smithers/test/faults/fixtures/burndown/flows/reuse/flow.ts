import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import { appendFileSync } from "node:fs"
import { Child, Land, layer as childLayer } from "../burndown/flow.ts"
const Dispatch = Action.make("reuse/Dispatch", {
  implementationVersion: "fault-3367/v1",
  payload: { root: Schema.String, seconds: Schema.Number, count: Schema.Number },
  success: Schema.String,
  error: Schema.Unknown,
  nondeterministic: true,
  tier: "irreversible"
})
export const layer = Layer.mergeAll(
  childLayer,
  Dispatch.toLayer(({ root, seconds, count }) =>
    Effect.gen(function*() {
      // Like issue-sweep, the attempt survives a new parent invocation.
      yield* Effect.all(
        Array.from({ length: count }, (_, n) =>
          Child.execute(
            { root, seconds, count, index: n + 1 },
            { executionId: `${root}/attempt-1/${n + 1}` }
          ).pipe(Effect.tapCause((cause) =>
            Effect.sync(() => {
              // Observe the real admission refusal before the parent codec abbreviates it.
              // The original cause propagates unchanged.
              for (const reason of cause.reasons) {
                const error = reason._tag === "Die" ? reason.defect : reason._tag === "Fail" ? reason.error : undefined
                if (
                  typeof error === "object" && error !== null && "_tag" in error && "field" in error &&
                  "status" in error
                ) {
                  appendFileSync(
                    `${root}/identity-refusals.jsonl`,
                    JSON.stringify({
                      reason: reason._tag,
                      tag: error._tag,
                      field: error.field,
                      status: error.status
                    }) + "\n"
                  )
                }
              }
            })
          ))),
        { concurrency: count }
      )
      return "joined"
    }), { implementationVersion: "fault-3367/v1" })
)
export default Flow.make("reuse", {
  description: "Reuse an admitted child attempt under a new parent.",
  capabilities: ["fs:read:**"],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: Dispatch.payloadSchema,
  success: Schema.String,
  error: Schema.Unknown,
  body: Node.capture({ action: Dispatch.name }, ({ root, seconds, count }) => {
    let plan = Dispatch.call({ root, seconds, count }).pipe(Node.andThen(Land.call({ root, count, index: 1 })))
    for (let index = 2; index <= count; index++) plan = plan.pipe(Node.andThen(Land.call({ root, count, index })))
    return plan
  })
})
