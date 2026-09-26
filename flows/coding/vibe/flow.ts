/** The third pass over a validated request: admit, clean, retain, then append or open a GitHub pull request. */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { AdmitVibe } from "../vibe-admission.ts"
import { CleanVibeHistory } from "../vibe-cleanup.ts"
import { LandVibe, LandVibeError } from "../vibe-landing.ts"
import { VibeDelivered, VibeInput } from "../vibe-schema.ts"

export const VibeError = Schema.Union([...CleanVibeHistory.errorSchema.members, ...LandVibeError.members])

/** Each child leaves its own source-qualified receipt for the existing cards. */
export default Flow.make("coding/Vibe", {
  description:
    "Retain the original source, clean and revalidate the validated native history, retain the cleaned source, and append one commit to main through the existing landing policy, or open a GitHub pull request when the repository sends changes upstream.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: VibeInput,
  success: VibeDelivered,
  error: VibeError,
  body: (input) =>
    AdmitVibe.child(input).pipe(
      Node.bindPlanned((admission) => CleanVibeHistory.child(admission)),
      Node.bindPlanned((cleanup) => LandVibe.child(cleanup))
    )
})
