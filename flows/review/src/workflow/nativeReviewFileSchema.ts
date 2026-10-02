import * as Schema from "effect/Schema";

/**
 * One file the fan-out will review, carrying the diff and the built prompt so
 * a later round never re-reads a working tree that may have moved.
 *
 * @since 1.0.0
 * @category schemas
 */
export const NativeReviewFile = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  status: Schema.String,
  insertions: Schema.Number,
  deletions: Schema.Number,
  diff: Schema.String,
  prompt: Schema.String,
});

/**
 * A decoded reviewable file.
 *
 * @since 1.0.0
 * @category models
 */
export type NativeReviewFile = typeof NativeReviewFile.Type;
