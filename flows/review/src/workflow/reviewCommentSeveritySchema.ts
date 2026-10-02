import * as Schema from "effect/Schema";

/**
 * How much a finding matters. Ordered most to least severe; every rank, order,
 * count, and prompt sentence reads `ReviewCommentSeverity.literals` rather than
 * a copy.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ReviewCommentSeverity = Schema.Literals(["critical", "major", "minor", "info"]);

/**
 * A decoded severity.
 *
 * @since 1.0.0
 * @category models
 */
export type ReviewCommentSeverity = typeof ReviewCommentSeverity.Type;
