import * as Schema from "effect/Schema";
import { arrayOf, withDefault } from "../schema/withDefault.ts";
import { ReviewSummary } from "./reviewSummarySchema.ts";
import { ReviewComment } from "./reviewCommentSchema.ts";
import { ReviewWarning } from "./reviewWarningSchema.ts";

/**
 * The per-file answer a review seat must produce.
 *
 * Every field carries a default so a partial answer decodes instead of burning
 * a correction re-prompt; `finalizeNativeReview` is what enforces scope,
 * anchoring, and de-duplication.
 */
export const NativeReviewAgentOutput = Schema.Struct({
  status: withDefault(
    Schema.Literals(["success", "completed_with_warnings", "completed_with_errors", "failed"]),
    "success" as const,
  ),
  message: withDefault(Schema.String, ""),
  summary: withDefault(Schema.NullOr(ReviewSummary), null),
  comments: arrayOf(ReviewComment),
  warnings: arrayOf(ReviewWarning),
});

/**
 * A decoded per-file answer.
 *
 * @since 1.0.0
 * @category models
 */
export type NativeReviewAgentOutput = typeof NativeReviewAgentOutput.Type;
