/** Review implementations only. The normal flow host supplies every runtime service. */
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { Interpreter } from "@smthrs/flow"
import { Effect, Layer } from "effect"
import {
  applyVerdictsLayer,
  finalizeReviewLayer,
  mergeFileBatchLayer,
  prepareReviewLayer,
  renderWalkthroughLayer
} from "./reviewActions.ts"
import { NarrateChanges, ReviewFile, VerifyFindings } from "./reviewAgentActions.ts"
import { NarrateReview, ReviewFiles, VerifyReview } from "./reviewFlow.ts"
/** Child rounds register in the caller's engine; no engine, seats or policy is constructed here. */
const declarations = Layer.mergeAll(
  prepareReviewLayer,
  mergeFileBatchLayer,
  finalizeReviewLayer,
  applyVerdictsLayer,
  renderWalkthroughLayer,
  Interpreter.layer(ReviewFiles),
  Interpreter.layer(VerifyReview),
  Interpreter.layer(NarrateReview),
  ReviewFile.layer,
  VerifyFindings.layer,
  NarrateChanges.layer
)

/** Refuse at module load when the normal host does not supply agent and budget services. */
export const layer = Layer.unwrap(Effect.gen(function*() {
  yield* AgentAction.Host
  yield* Agent.Agent
  yield* SeatResolver.SeatResolver
  yield* Budget.Budget
  return declarations
}))
