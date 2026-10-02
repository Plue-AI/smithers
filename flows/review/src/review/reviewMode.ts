import { normalizeOpenCodeReviewInput } from "../workflow/normalizeOpenCodeReviewInput.ts";
import type { OpenCodeReviewInput } from "../workflow/openCodeReviewInputSchema.ts";
import type { ReviewTarget } from "../workflow/reviewTargetSchema.ts";

/**
 * Reads which mode a request asks for: `--commit` wins, then `--from`/`--to`,
 * otherwise the working tree.
 *
 * @since 1.0.0
 * @category constructors
 */
export function reviewMode(input: OpenCodeReviewInput): ReviewTarget["mode"] {
  input = normalizeOpenCodeReviewInput(input);
  if (input.commit.trim()) return "commit";
  if (input.from.trim() || input.to.trim()) return "range";
  return "workspace";
}
