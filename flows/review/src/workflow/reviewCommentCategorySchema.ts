import * as Schema from "effect/Schema";

/**
 * What kind of problem a finding reports.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ReviewCommentCategory = Schema.Literals([
  "correctness",
  "security",
  "performance",
  "data-loss",
  "tests",
  "docs",
  "style",
  "other",
]);

/**
 * A decoded category.
 *
 * @since 1.0.0
 * @category models
 */
export type ReviewCommentCategory = typeof ReviewCommentCategory.Type;
