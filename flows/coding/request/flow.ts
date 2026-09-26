/** The repository's prompt entry composes existing planning and correction flows. */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { CorrectPlan } from "../correction.ts"
import { PrepareRequest } from "../preparation.ts"
import { CodingError, Plan, PlanningInput, RequestInput, RequestResult } from "../schema.ts"
import { AdmitSource } from "../source-admission.ts"
import { admitStackBase } from "../stack.ts"
import { FeedbackReceipt, ReceiveFeedback } from "../steering.ts"

export const maximumPlanningPasses = 8
/** Private durable cursor. Notification bodies and provenance stay in the
 * existing action receipts; the planner receives their bounded rendered text. */
export const Cursor = Schema.Struct({
  ...PlanningInput.fields,
  preparedPlan: Schema.optionalKey(Plan),
  maxRounds: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(8)),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(maximumPlanningPasses))
})
export const MergeFeedback = Action.make("coding/merge-request-feedback", {
  payload: { cursor: Cursor, receipt: FeedbackReceipt, advance: Schema.Boolean },
  success: Cursor,
  error: CodingError
})

type CoordinateFlow = Flow.Flow<
  "coding/CoordinateRequest",
  typeof Cursor,
  typeof RequestResult,
  typeof PrepareRequest.errorSchema,
  Action.Requirement<(typeof MergeFeedback | typeof ReceiveFeedback | typeof AdmitSource)["name"]>
>

/** Each trampoline pass gathers current source evidence before planning. A
 * message during mutation waits for correction to settle; it never mutates
 * a running plan or preempts a writer. Prototypes are a separate opt-in flow. */
export const Coordinate: CoordinateFlow = Flow.make("coding/CoordinateRequest", {
  payload: Cursor,
  success: RequestResult,
  error: PrepareRequest.errorSchema,
  maxRounds: maximumPlanningPasses,
  body: (cursor) =>
    (cursor.preparedPlan === undefined
      ? PrepareRequest.child({
        prompt: cursor.prompt,
        feedback: cursor.feedback,
        ...(cursor.wiki === undefined ? {} : { wiki: cursor.wiki })
      })
      : Node.succeed(cursor.preparedPlan)).pipe(
        // bindPlanned exposes a reference and permits independent descendants.
        // Explicit sequencing makes each entire feedback subtree wait for the
        // referenced producer, even though the drain payload is only a boundary.
        Node.bindPlanned((plan) =>
          Node.succeed(plan).pipe(
            Node.andThen(
              ReceiveFeedback.call({ boundary: "before-implementation", revision: cursor.revision }).pipe(
                Node.branch({
                  if: (receipt) => receipt.messages.length > 0,
                  then: (receipt) =>
                    MergeFeedback.call({ cursor, receipt, advance: true }).pipe(
                      Node.bindPlanned((next) => Coordinate.to(next))
                    ),
                  else: () =>
                    AdmitSource.call({ plan }).pipe(
                      Node.bindPlanned((plan) =>
                        CorrectPlan.child({ plan, maxRounds: cursor.maxRounds }).pipe(
                          Node.bindPlanned((outcome) =>
                            Node.succeed(outcome).pipe(
                              Node.andThen(
                                ReceiveFeedback.call({ boundary: "after-correction", revision: cursor.revision }).pipe(
                                  Node.branch({
                                    if: (receipt) => receipt.messages.length > 0,
                                    then: (receipt) =>
                                      MergeFeedback.call({ cursor, receipt, advance: true }).pipe(
                                        Node.bindPlanned((next) => Coordinate.to(next))
                                      ),
                                    else: () => Flow.done({ plan, outcome })
                                  })
                                )
                              )
                            )
                          )
                        )
                      )
                    )
                })
              )
            )
          )
        )
      )
})

/**
 * The original prepared child remains a durable, source-qualified receipt for
 * finalization, independently of whether the user ever requests a POC.
 */
export default Flow.make("coding/Request", {
  description:
    "Plan from current repository source and native history, then implement Changes with required checks and bounded owner correction.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: RequestInput,
  success: RequestResult,
  error: PrepareRequest.errorSchema,
  body: (input) => {
    const wiki = input.wiki === undefined ? {} : { wiki: input.wiki }
    const prepare = PrepareRequest.child({ prompt: input.prompt, feedback: input.feedback ?? "", ...wiki })
    // A stack request first stands on a fresh working change on the tip.
    return (input.base === undefined ? prepare : admitStackBase(input.base).pipe(Node.andThen(prepare))).pipe(
      Node.bindPlanned((plan) => AdmitSource.call({ plan })),
      Node.bindPlanned((preparedPlan) =>
        Coordinate.child({
          prompt: input.prompt,
          feedback: input.feedback ?? "",
          ...wiki,
          maxRounds: input.maxRounds ?? 3,
          revision: 0,
          preparedPlan
        })
      )
    )
  }
})
