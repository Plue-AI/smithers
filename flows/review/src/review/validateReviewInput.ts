import { normalizeOpenCodeReviewInput } from "../workflow/normalizeOpenCodeReviewInput.ts";
import type { OpenCodeReviewInput } from "../workflow/openCodeReviewInputSchema.ts";

/**
 * Refuses a request that names more than one mode, or half a range.
 *
 * Throws rather than returning a result: this runs at the CLI boundary, where
 * the message is the whole output.
 *
 * @since 1.0.0
 * @category validation
 */
export function validateReviewInput(input: OpenCodeReviewInput) {
  input = normalizeOpenCodeReviewInput(input);
  if ((input.from.trim() || input.to.trim()) && input.commit.trim()) {
    throw new Error("Only one review mode is allowed: workspace, --from/--to, or --commit.");
  }
  if (input.from.trim() && !input.to.trim()) {
    throw new Error("--to is required when --from is specified.");
  }
  if (!input.from.trim() && input.to.trim()) {
    throw new Error("--from is required when --to is specified.");
  }
}
