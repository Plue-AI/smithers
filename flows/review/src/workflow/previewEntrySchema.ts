import * as Schema from "effect/Schema";
import { withDefault } from "../schema/withDefault.ts";

/**
 * One changed file as the preview reports it, including whether the review
 * filters kept it and, when they did not, why.
 *
 * @since 1.0.0
 * @category schemas
 */
export const PreviewEntry = Schema.Struct({
  path: Schema.String,
  status: Schema.String,
  insertions: Schema.Number,
  deletions: Schema.Number,
  willReview: Schema.Boolean,
  excludeReason: withDefault(Schema.String, ""),
});

/**
 * A decoded preview entry.
 *
 * @since 1.0.0
 * @category models
 */
export type PreviewEntry = typeof PreviewEntry.Type;
