/**
 * The repair step: one failing verification round, handed back with the
 * contract still in context.
 *
 * A separate action rather than a retry of {@link module:Transform} because the
 * two are asked different questions. Transform is given a unit and the mapping;
 * repair is given a unit, the mapping, and the exact output of the command that
 * refused the rewrite. Keeping them apart also keeps the journal readable: a
 * reader can see how many rounds a unit cost and what each one was told.
 *
 * The brief a repair round receives is re-captured, so the sources it reads are
 * the ones on disk after the previous round edited them, not the ones the unit
 * started with.
 *
 * @since 1.0.0-rc.0
 */

import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Schema from "effect/Schema"
import * as Report from "../Report.ts"
import * as Contract from "./Contract.ts"
import * as Transform from "./Transform.ts"

/**
 * The repair step: the unit, the round, and what failed.
 *
 * @category actions
 * @since 1.0.0-rc.0
 */
export const action = AgentAction.make("smithers/migrate-v1/Repair", {
  payload: {
    unit: Contract.UnitBrief,
    round: Schema.Int,
    failures: Report.VerificationResult
  },
  output: Transform.UnitResult,
  seat: Transform.seat,
  system: [Contract.text],
  prompt: ({ failures, round, unit }) => Contract.unitPrompt(unit, { round, verification: failures }),
  corrections: 1,
  maxFrames: Transform.maxFrames
})

/**
 * The repair step's implementation. It is the same agent loop, the same seat,
 * and the same host as the transform step.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = action.layer
