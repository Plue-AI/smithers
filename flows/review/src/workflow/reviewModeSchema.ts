import * as Schema from "effect/Schema";

/**
 * Which set of changes a review reads: the working tree, a commit range, or
 * one commit.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ReviewMode = Schema.Literals(["workspace", "range", "commit"]);

/**
 * A decoded review mode.
 *
 * @since 1.0.0
 * @category models
 */
export type ReviewMode = typeof ReviewMode.Type;
