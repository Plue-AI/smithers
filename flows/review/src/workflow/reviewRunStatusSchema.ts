import * as Schema from "effect/Schema";

/**
 * How a review ended. `failed` means no file review produced an answer, which
 * is why it must never post as a clean pass.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ReviewRunStatus = Schema.Literals([
  "success",
  "skipped",
  "completed_with_warnings",
  "completed_with_errors",
  "failed",
]);

/**
 * A decoded run status.
 *
 * @since 1.0.0
 * @category models
 */
export type ReviewRunStatus = typeof ReviewRunStatus.Type;
