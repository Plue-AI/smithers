import * as Schema from "effect/Schema";
import { ReviewMode } from "./reviewModeSchema.ts";

/**
 * The resolved change set: which repository, read which way, at which ref.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ReviewTarget = Schema.Struct({
  repoDir: Schema.String,
  mode: ReviewMode,
  ref: Schema.String,
});

/**
 * A decoded review target.
 *
 * @since 1.0.0
 * @category models
 */
export type ReviewTarget = typeof ReviewTarget.Type;
