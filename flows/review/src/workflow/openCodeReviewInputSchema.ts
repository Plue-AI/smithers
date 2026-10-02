import * as Schema from "effect/Schema";
import { withDefault } from "../schema/withDefault.ts";

/**
 * Everything one review run is asked for.
 *
 * Every field carries a default, so a caller may name only what it wants to
 * change and a persisted input from an older shape still decodes.
 *
 * @since 1.0.0
 * @category schemas
 */
export const OpenCodeReviewInput = Schema.Struct({
  repo: withDefault(Schema.String, "."),
  from: withDefault(Schema.String, ""),
  to: withDefault(Schema.String, ""),
  commit: withDefault(Schema.String, ""),
  background: withDefault(Schema.String, ""),
  rule: withDefault(Schema.String, ""),
  concurrency: withDefault(Schema.Number, 8),
  timeout: withDefault(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1)), 10),
  runReview: withDefault(Schema.Boolean, true),
});

/**
 * A decoded review request.
 *
 * @since 1.0.0
 * @category models
 */
export type OpenCodeReviewInput = typeof OpenCodeReviewInput.Type;
