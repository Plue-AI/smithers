import type { NativeReviewFile } from "../workflow/nativeReviewFileSchema.ts";
import type { NativeReviewAgentOutput } from "../workflow/nativeReviewAgentOutputSchema.ts";

/**
 * One reviewable file paired with what its seat answered, or `null` when that
 * file's review failed.
 *
 * @since 1.0.0
 * @category models
 */
export type NativeReviewFileResult = {
  file: NativeReviewFile;
  output?: NativeReviewAgentOutput | null;
};
