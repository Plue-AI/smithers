/** Linear implementation with a parallel slow-validation branch at every Change. */
import { type Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { CodingError, Plan, Result, type ValidatedChange } from "./schema.ts"
import { Assess, FastGate, Implement, recalled, RunCheck, ValidatePlan } from "./workflow.ts"

type Requirements = Action.Requirement<
  (typeof ValidatePlan | typeof Implement | typeof RunCheck | typeof FastGate | typeof Assess)["name"]
>
type Stages = Node.Node<ReadonlyArray<ValidatedChange>, CodingError, Requirements>

/** Width is known from the plan. Slow checks never become a dependency of the next implementation. */
const stages = (plan: Plan, index: number, parent: Parameters<typeof Implement.call>[0]["parent"]): Stages => {
  const change = plan.changes[index]
  if (change === undefined) return Node.succeed([])
  return Node.bindPlanned(Implement.call({ change, parent, ...recalled(plan) }), (implementation) => {
    const fast = Object.fromEntries(
      change.checks.filter((check) => check.tier === "fast")
        .map((check) => [check.id, RunCheck.call({ implementation, check })])
    )
    return Node.bindPlanned(
      Node.all(fast),
      (receipts) =>
        Node.bindPlanned(FastGate.call({ change, parent, implementation, receipts }), (gated) => {
          const slow = Object.fromEntries(
            change.checks.filter((check) => check.tier === "slow")
              .map((check) => [check.id, RunCheck.call({ implementation, check })])
          )
          return Node.all({
            current: Node.succeed(gated),
            review: Node.all(slow),
            next: stages(plan, index + 1, gated.implementation.head)
          }).pipe(Node.map(({ current, review, next }) => [
            { implementation: current.implementation, receipts: [...current.receipts, ...Object.values(review)] },
            ...next
          ]))
        })
    )
  })
}

export default Flow.make("coding/ImplementPlan", {
  description:
    "Implement a predicted linear Change plan with fast gates and asynchronous slow validation through the repository's registered flows.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: { plan: Plan },
  success: Result,
  error: CodingError,
  body: ({ plan }) =>
    ValidatePlan.call({ plan }).pipe(Node.andThen(
      stages(plan, 0, plan.base).pipe(Node.bindPlanned((changes) => Assess.call({ plan, changes })))
    ))
})
