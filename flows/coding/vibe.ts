/** Internal vibe steps for TODO composition and retained native histories.
 * No filesystem command entrypoint is published for this executor. */
import { Layer } from "effect"
import { vibeAdmissionLayers } from "./vibe-admission.ts"
import { cleanupLayers } from "./vibe-cleanup.ts"
import Vibe from "./vibe-flow.ts"
import { landerLayer } from "./vibe-lander.ts"
import { landingLayers } from "./vibe-landing.ts"

export { Vibe }
export { VibeError } from "./vibe-flow.ts"

/** Landing is supplied by the deployment; models by the host's evidence-only policy. */
export const vibeRegistration = Layer.mergeAll(
  vibeAdmissionLayers,
  cleanupLayers,
  landerLayer,
  landingLayers
)
