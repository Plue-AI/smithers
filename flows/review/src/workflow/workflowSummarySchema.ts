import * as Schema from "effect/Schema";
import { ReviewRunStatus } from "./reviewRunStatusSchema.ts";

/**
 * The flat summary a caller records for one run.
 *
 * @since 1.0.0
 * @category schemas
 */
export const WorkflowSummary = Schema.Struct({
  status: ReviewRunStatus,
  repoDir: Schema.String,
  mode: Schema.String,
  reviewableFiles: Schema.Number,
  excludedFiles: Schema.Number,
  comments: Schema.Number,
  warnings: Schema.Number,
  totalTokens: Schema.Number,
  message: Schema.String,
});

/**
 * A decoded workflow summary.
 *
 * @since 1.0.0
 * @category models
 */
export type WorkflowSummary = typeof WorkflowSummary.Type;
