/** The repository's prompt entry composes existing planning and correction flows. */
import { Action, Flow, HumanTask } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import { Schema } from "effect"
import { isDependencyPage } from "../../memory/deps.ts"
import { CorrectPlan } from "../correction.ts"
import { PrepareRequest } from "../preparation.ts"
import { CodingError, Plan, PlanningInput, RequestInput, RequestResult } from "../schema.ts"
import { AdmitSource } from "../source-admission.ts"
import { admitStackBase } from "../stack.ts"
import { FeedbackReceipt, ReceiveFeedback } from "../steering.ts"
import { RouteRequest, StampRoute } from "../todo-route.ts"
import { InstallDependencyPages } from "../wiki-refresh.ts"

export const maximumPlanningPasses = 8
/** Private durable cursor. Notification bodies and provenance stay in the
 * existing action receipts; the planner receives their bounded rendered text. */
export const Cursor = Schema.Struct({
  ...PlanningInput.fields,
  planApproval: RequestInput.fields.planApproval,
  preparedPlan: Schema.optionalKey(Plan),
  maxRounds: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(8)),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(maximumPlanningPasses))
})
export const MergeFeedback = Action.make("coding/merge-request-feedback", {
  payload: { cursor: Cursor, receipt: FeedbackReceipt, advance: Schema.Boolean },
  success: Cursor,
  error: CodingError
})
export const RefusePlan = Action.make("coding/refuse-plan-approval", {
  payload: { message: Schema.String },
  success: Schema.Never,
  error: CodingError
})

const approve = (plan: Plan | Planned.Planned<Plan>, policy: typeof RequestInput.Type.planApproval) => {
  if (policy === undefined || policy === "never") return Node.succeed(true)
  const prompt = (value: Plan) =>
    [
      "Approve this predicted Change plan before coding?",
      ...value.changes.map((change) =>
        [
          `Change: ${change.title} (${change.id})`,
          `Rationale: ${change.intent}`,
          ...change.atoms.map((atom) =>
            `  ${atom.intent}\n  Reads: ${atom.reads.join(", ") || "(none)"}\n  Writes: ${
              atom.writes.join(", ") || "(none)"
            }`
          )
        ].join("\n")
      )
    ].join("\n\n")
  const timeoutMs = policy === "always" ? undefined : Number(policy.slice("timeout:".length, -1)) * 1000
  return Node.succeed(plan).pipe(
    Node.map(prompt),
    Node.bindPlanned((prompt) =>
      HumanTask.action.call({
        name: "coding-plan-approval",
        kind: "confirm",
        prompt,
        maxAttempts: 1,
        ...(timeoutMs === undefined ? {} : { timeoutMs })
      })
    ),
    Node.catch({
      error: HumanTask.HumanTaskFailed,
      onFailure: (error) =>
        Node.branch(Node.succeed(error), {
          if: (failure) => failure.code === "timeout" && timeoutMs !== undefined,
          then: () => Node.succeed(true),
          else: (failure) =>
            Node.succeed(failure).pipe(
              Node.map((value) => `Plan approval failed: ${value.message}`),
              Node.bindPlanned((message) => RefusePlan.call({ message }))
            )
        })
    })
  )
}

type CoordinateFlow = Flow.Flow<
  "coding/CoordinateRequest",
  typeof Cursor,
  typeof RequestResult,
  typeof PrepareRequest.errorSchema,
  Action.Requirement<(typeof MergeFeedback | typeof ReceiveFeedback | typeof AdmitSource | typeof RefusePlan)["name"]>
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
        ...(cursor.wiki === undefined ? {} : { wiki: cursor.wiki }),
        ...(cursor.answers === undefined ? {} : { answers: cursor.answers })
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
                    Node.branch(approve(plan, cursor.planApproval), {
                      if: (approved) => approved === true,
                      then: () => AdmitSource.call({ plan }),
                      else: () => RefusePlan.call({ message: "The predicted Change plan was denied." })
                    }).pipe(
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
    // Every answer a person gave an earlier attempt reaches each planning pass.
    const answers = input.answers === undefined ? {} : { answers: input.answers }
    const implement = (feedback: string | Planned.Planned<string>) =>
      PrepareRequest.child({ prompt: input.prompt, feedback, ...wiki, ...answers }).pipe(
        Node.bindPlanned((plan) => AdmitSource.call({ plan })),
        Node.bindPlanned((preparedPlan) =>
          Coordinate.child({
            prompt: input.prompt,
            feedback,
            ...wiki,
            ...answers,
            ...(input.planApproval === undefined ? {} : { planApproval: input.planApproval }),
            maxRounds: input.maxRounds ?? 3,
            revision: 0,
            preparedPlan
          })
        )
      )
    // A stack request is a TODO: it stands on a fresh working change on the
    // tip, and factory/Todo routes it before it is planned. Its result and
    // its failure both carry the route, which the stack keeps.
    // The dependency pages the stack published reach this checkout first.
    const dependencyPages = (input.wiki?.pages ?? []).filter(isDependencyPage)
    return input.base === undefined ? implement(input.feedback ?? "") : admitStackBase(input.base).pipe(
      Node.andThen(InstallDependencyPages.call({ pages: dependencyPages })),
      Node.andThen(RouteRequest.child({ prompt: input.prompt, feedback: input.feedback ?? "" })),
      Node.bindPlanned((routed) =>
        Node.all({ routed: Node.succeed(routed), result: implement(routed.feedback) }).pipe(
          Node.map(({ result, routed }) => ({ ...result, route: routed.route })),
          Node.catch({ error: CodingError, onFailure: (error) => StampRoute.call({ error, route: routed.route }) })
        )
      )
    )
  }
})
