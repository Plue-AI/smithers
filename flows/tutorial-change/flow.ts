import { Flow as Declaration } from "@smthrs/core"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
// The flow below is this module's own default export. Discovery reads the
// literal `export default Flow.make(` without importing the file, so the flow
// cannot also be a named const; the registration beside it reads the value
// back through this self-import, which resolves after this module evaluates.
import ImplementPlan from "../coding/flow.ts"
import { CodingError, Plan, Result } from "../coding/schema.ts"
import Execute from "./flow.ts"

export const Preflight = Action.make("tutorial-change/preflight", {
  payload: { plan: Plan },
  success: Plan,
  error: CodingError,
  nondeterministic: true
})
export const Verify = Action.make("tutorial-change/verify", {
  payload: { plan: Plan, result: Result },
  success: Result,
  error: CodingError,
  nondeterministic: true
})

/** The coding runtime persists the plan and journals recursive implementation/check calls. */
export default Flow.make("tutorial-change/Execute", {
  description:
    "Execute the reviewed tutorial plan through the coding flow. Re-read HEAD before any writes; refuse if it differs from plan.base.commitId. Require exactly one change and one atom. Do not push. Return the exact coding result; never invent revision evidence.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "sealed" },
  payload: { plan: Plan },
  success: Result,
  error: CodingError,
  body: ({ plan }) =>
    Preflight.call({ plan }).pipe(
      Node.bindPlanned((checked) =>
        ImplementPlan.call({ plan: checked }).pipe(Node.bindPlanned((result) => Verify.call({ plan: checked, result })))
      )
    )
})

export const suggestion = Declaration.make({
  name: "tutorial-change/suggestion",
  description:
    "Inspect the supplied repository files and executable catalog. Suggest one small useful feature justified by actual code. Produce exactly one Change with one atomic commit, the captured HEAD, real native revision identifiers, real implementation/check flow digests, and required fast and slow checks. Use coding Plan. This is planning only: execute no implementation scripts and write no files. If the repository or executable catalog cannot support a real plan, fail honestly.",
  input: Schema.Struct({
    repo: Schema.NonEmptyString,
    head: Schema.NonEmptyString,
    files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
    feature: Schema.optional(Schema.String)
  }),
  output: Plan,
  capabilities: ["fs:read:**"],
  effects: { reads: ["**"], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
})

/** The deployment supplies its scoped repository host; no browser-supplied paths. */
export const executionLayers = (host: {
  preflight(plan: typeof Plan.Type): Promise<void>
  verify(plan: typeof Plan.Type, result: typeof Result.Type): Promise<void>
}) =>
  Layer.mergeAll(
    Preflight.toLayer(({ plan }) =>
      Effect.tryPromise({
        try: async () => {
          await host.preflight(plan)
          return plan
        },
        catch: (cause) => new CodingError({ code: "stale_revision", message: String(cause) })
      })
    ),
    Verify.toLayer(({ plan, result }) =>
      Effect.tryPromise({
        try: async () => {
          await host.verify(plan, result)
          return result
        },
        catch: (cause) => new CodingError({ code: "invalid_receipt", message: String(cause) })
      })
    ),
    Interpreter.layer(Execute)
  )
