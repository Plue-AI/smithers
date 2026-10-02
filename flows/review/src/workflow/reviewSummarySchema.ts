import * as Schema from "effect/Schema";
import { withDefault } from "../schema/withDefault.ts";

/**
 * The counts one review run accumulated.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ReviewSummary = Schema.Struct({
  filesReviewed: withDefault(Schema.Number, 0),
  comments: withDefault(Schema.Number, 0),
  totalTokens: withDefault(Schema.NullOr(Schema.Number), null),
  inputTokens: withDefault(Schema.NullOr(Schema.Number), null),
  outputTokens: withDefault(Schema.NullOr(Schema.Number), null),
  elapsed: withDefault(Schema.String, ""),
});

/**
 * A decoded run summary.
 *
 * @since 1.0.0
 * @category models
 */
export type ReviewSummary = typeof ReviewSummary.Type;
