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
    "Clean and revalidate the validated native history, then deliver one commit: through the backend's landing policy (appended to main, or a GitHub pull request when the repository sends changes upstream), or, on a host without the backend, by fast-forwarding main to the verified candidate or opening its GitHub pull request.",
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
