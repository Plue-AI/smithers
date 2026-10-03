/**
 * update_plan flow declaration and portable handler.
 *
 * A Codex CLI clone of the `update_plan` tool: an optional explanation and a
 * list of plan items, acknowledged with "Plan updated". Pure — no host
 * access; the harness observes plan updates through the journal.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { envelope } from "./internal/Declaration.ts"
import * as StdError from "./StdError.ts"

/**
 * Registry name for the update_plan flow. Matches the Codex CLI tool name.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const name = "update_plan"

/**
 * Model-facing description of the update_plan flow. Matches the Codex CLI
 * description.
 *
 * @category descriptions
 * @since 1.0.0
 */
export const description = "Updates the task plan.\n" +
  "Provide an optional explanation and a list of plan items, each with a step and status.\n" +
  "At most one step can be in_progress at a time.\n"

/**
 * Status of one plan step, matching Codex.
 *
 * @category schemas
 * @since 1.0.0
 */
export const StepStatus = Schema.Literals(["pending", "in_progress", "completed"])

const Step = Schema.Struct({
  step: Schema.String.annotate({ description: "Task step text." }),
  status: StepStatus.annotate({ description: "Step status." })
})

/** How many steps of a plan claim to be running right now. */
const inProgressCount = (plan: ReadonlyArray<typeof Step.Type>): number =>
  plan.reduce((total, item) => item.status === "in_progress" ? total + 1 : total, 0)

/**
 * The plan itself: steps, at most one of them `in_progress`.
 *
 * The single-in-progress rule is the last line of the Codex description a
 * model reads every frame, so it is enforced here rather than left as prose a
 * decode ignores. A plan naming two running steps is a decode failure at the
 * `plan` path, not a silent acknowledgement.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Plan = Schema.Array(Step).pipe(
  Schema.check(
    Schema.makeFilter(
      (plan) =>
        inProgressCount(plan) <= 1
          ? undefined
          : "invalid_input: at most one plan step can be in_progress at a time",
      { identifier: "invalid_input" }
    )
  )
).annotate({ description: "The list of steps" })

/**
 * Input schema for the update_plan flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Input = Schema.Struct({
  explanation: Schema.optional(Schema.String.annotate({ description: "Optional explanation for this plan update." })),
  plan: Plan
})

/**
 * Decoded input accepted by the `update_plan` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type

/**
 * Output schema for the update_plan flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Output = Schema.Struct({
  output: Schema.String.annotate({ description: "Acknowledgement text, always 'Plan updated'" })
})

/**
 * Decoded output returned by the `update_plan` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type

/**
 * Static effect envelope for the update_plan flow: no reads, no writes.
 *
 * @category effects
 * @since 1.0.0
 */
export const effects = envelope({ tier: "sealed", mode: "hermetic", reads: [], writes: [] })

/**
 * Narrows the effect envelope for a decoded invocation.
 *
 * The flow touches nothing, so every invocation declares what the static
 * envelope declares.
 *
 * @category effects
 * @since 1.0.0
 */
export const effectsFor = (_input: typeof Input.Type) => effects

/**
 * Capabilities required by the update_plan flow: none.
 *
 * @category capabilities
 * @since 1.0.0
 */
export const capabilities: ReadonlyArray<string> = []

/**
 * Declaration-only update_plan flow.
 *
 * @category flows
 * @since 1.0.0
 */
export const flow = { name, description, input: Input, output: Output, capabilities, effects } as const

/**
 * Acknowledges a plan update with Codex's exact response text.
 *
 * The single-in-progress rule is checked again here. `Plan` refuses it at
 * decode time, but a host that calls this handler directly never decodes, and
 * an invariant enforced in only one of the two entrances is enforced in
 * neither.
 *
 * @category handlers
 * @since 1.0.0
 */
export const run = Effect.fn("UpdatePlan.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError> {
  const running = inProgressCount(input.plan)
  if (running > 1) {
    return yield* Effect.fail(
      new StdError.StdError({
        code: "invalid_input",
        message: `At most one step can be in_progress at a time; the plan named ${running}`
      })
    )
  }
  return { output: "Plan updated" }
})
