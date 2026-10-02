import * as Schema from "effect/Schema";
import { arrayOf, withDefault } from "../schema/withDefault.ts";
import { ReviewRunStatus } from "./reviewRunStatusSchema.ts";
import { ReviewSummary } from "./reviewSummarySchema.ts";
import { ReviewComment } from "./reviewCommentSchema.ts";
import { ReviewWarning } from "./reviewWarningSchema.ts";

/**
 * The finished review: its status, its findings, and what it could not do.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ReviewRunOutput = Schema.Struct({
  status: ReviewRunStatus,
  ok: Schema.Boolean,
  reviewer: withDefault(Schema.String, "smithers-native"),
  message: withDefault(Schema.String, ""),
  summary: withDefault(Schema.NullOr(ReviewSummary), null),
  comments: arrayOf(ReviewComment),
  warnings: arrayOf(ReviewWarning),
  error: withDefault(Schema.String, ""),
});

/**
 * A decoded review result.
 *
 * @since 1.0.0
 * @category models
 */
export type ReviewRunOutput = typeof ReviewRunOutput.Type;
