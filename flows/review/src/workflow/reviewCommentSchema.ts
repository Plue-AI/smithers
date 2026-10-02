import * as Schema from "effect/Schema";
import { withDefault } from "../schema/withDefault.ts";
import { ReviewCommentSeverity } from "./reviewCommentSeveritySchema.ts";
import { ReviewCommentCategory } from "./reviewCommentCategorySchema.ts";

/**
 * One finding, anchored to a line range in one file.
 *
 * Every field defaults, because a seat that omits one should lose that field
 * rather than the whole finding; `finalizeNativeReview` drops what cannot be
 * anchored.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ReviewComment = Schema.Struct({
  path: withDefault(Schema.String, ""),
  content: withDefault(Schema.String, ""),
  suggestionCode: withDefault(Schema.String, ""),
  existingCode: withDefault(Schema.String, ""),
  startLine: withDefault(Schema.Number, 0),
  endLine: withDefault(Schema.Number, 0),
  thinking: withDefault(Schema.String, ""),
  severity: withDefault(ReviewCommentSeverity, "minor" as const),
  category: withDefault(ReviewCommentCategory, "other" as const),
  confidence: withDefault(Schema.Literals(["confirmed", "plausible"]), "plausible" as const),
});

/**
 * A decoded finding.
 *
 * @since 1.0.0
 * @category models
 */
export type ReviewComment = typeof ReviewComment.Type;
