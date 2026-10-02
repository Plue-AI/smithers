/** Review through the ordinary flow registry and host; result includes the custom walkthrough. */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { ReviewFailure } from "./src/workflow/reviewFailureSchema.ts"
import { PrepareReview } from "./src/workflow/reviewActions.ts"
import { ReviewFiles } from "./src/workflow/reviewFlow.ts"
import { ReviewInput } from "./src/workflow/reviewInputSchema.ts"
import { ReviewResult } from "./src/workflow/reviewSchemas.ts"
export { layer } from "./src/workflow/reviewLayer.ts"

export default Flow.make("review", {
  description: "Review a working-copy change or pinned revisions, independently verify findings, and render the change as a walkthrough.",
  capabilities: ["fs:read:**", "fs:write:**", "proc:spawn:*", "model:call:*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "sealed" },
  payload: ReviewInput,
  success: ReviewResult,
  error: ReviewFailure,
  body: (input) =>
    PrepareReview.call({ input }).pipe(
      Node.bindPlanned((prepared) => ReviewFiles.to({ input, prepared })),
    ),
});

