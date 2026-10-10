/** Internal request steps for TODO composition and retained native histories.
 * No filesystem command entrypoint is published for this executor. */
import { Interpreter } from "@smthrs/flow"
import { Effect, Layer } from "effect"
import Request, {
  Coordinate,
  maximumPlanningPasses,
  MergeFeedback,
  RefusePlan,
  RequestFeedback
} from "./request-flow.ts"
import { CodingError } from "./schema.ts"
export { RequestInput } from "./schema.ts"
import { appendFeedback } from "./steering.ts"

export { Coordinate, MergeFeedback, Request, RequestFeedback }

export const requestRegistration = Layer.mergeAll(
  Interpreter.layer(Coordinate),
  Interpreter.layer(RequestFeedback),
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
