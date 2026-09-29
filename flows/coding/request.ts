/**
 * The request flow's host wiring.
 *
 * The flow itself is `request/flow.ts`, the file discovery reads: it
 * default-exports the `@smthrs/flow` flow, so there is no second declaration
 * and no delegate name joining the two.
 */
import { Interpreter } from "@smthrs/flow"
import { Effect, Layer } from "effect"
import Request, { Coordinate, maximumPlanningPasses, MergeFeedback, RefusePlan } from "./request/flow.ts"
import { CodingError } from "./schema.ts"
export { RequestInput } from "./schema.ts"
import { appendFeedback } from "./steering.ts"

export { Coordinate, MergeFeedback, Request }

export const requestRegistration = Layer.mergeAll(
  Interpreter.layer(Request),
  Interpreter.layer(Coordinate),
  RefusePlan.toLayer(({ message }) => Effect.fail(new CodingError({ code: "declined", message }))),
  MergeFeedback.toLayer(({ cursor, receipt, advance }) =>
    Effect.gen(function*() {
      // ReceiveFeedback completed before this action was materialized, so even
      // a bounded refusal retains the exact message IDs, text and provenance.
      const feedback = yield* appendFeedback(cursor.feedback, receipt)
      const revision = cursor.revision + (advance ? 1 : 0)
      if (revision >= maximumPlanningPasses) {
        return yield* Effect.fail(
          new CodingError({
            code: "invalid_plan",
            message:
              `Request reached ${maximumPlanningPasses} planning passes at ${receipt.boundary}; retained message IDs: ${
                receipt.messages.map((message) => JSON.stringify(message.id)).join(", ")
              }`
          })
        )
      }
      const { preparedPlan: _, ...next } = cursor
      return { ...next, feedback, revision }
    })
  )
)
