/**
 * The vibe flow's host wiring.
 *
 * The flow itself is `vibe/flow.ts`, the file discovery reads: it
 * default-exports the `@smthrs/flow` flow, so there is no second declaration
 * and no delegate name joining the two.
 */
import { Interpreter } from "@smthrs/flow"
import { Layer } from "effect"
import { vibeAdmissionLayers } from "./vibe-admission.ts"
import { cleanupLayers } from "./vibe-cleanup.ts"
import { landerLayer } from "./vibe-lander.ts"
import { landingLayers } from "./vibe-landing.ts"
import Vibe from "./vibe/flow.ts"

export { Vibe }
export { VibeError } from "./vibe/flow.ts"

/** Landing is supplied by the deployment; models by the host's evidence-only policy. */
export const vibeRegistration = Layer.mergeAll(
  Interpreter.layer(Vibe),
  vibeAdmissionLayers,
  cleanupLayers,
  landerLayer,
  landingLayers
)
