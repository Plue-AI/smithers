/**
 * One file in the change set the walkthrough describes.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
import { withDefault } from "../schema/withDefault.ts";

/**
 * A changed file, with its diff and whether the review looked at it.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ChangedFile = Schema.Struct({
  path: Schema.String,
  status: withDefault(Schema.String, "modified"),
  insertions: withDefault(Schema.Number, 0),
  deletions: withDefault(Schema.Number, 0),
  diff: withDefault(Schema.String, ""),
  reviewed: withDefault(Schema.Boolean, false),
  excludeReason: withDefault(Schema.String, ""),
});

/**
 * A decoded changed file.
 *
 * @since 1.0.0
 * @category models
 */
export type ChangedFile = typeof ChangedFile.Type;
