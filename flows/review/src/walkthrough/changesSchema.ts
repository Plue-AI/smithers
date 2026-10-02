/**
 * The whole change set a review reads.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
import { arrayOf, withDefault } from "../schema/withDefault.ts";
import { ChangedFile } from "./changedFileSchema.ts";

/**
 * Every changed file plus the totals the walkthrough header prints.
 *
 * @since 1.0.0
 * @category schemas
 */
export const Changes = Schema.Struct({
  files: arrayOf(ChangedFile),
  totalFiles: withDefault(Schema.Number, 0),
  totalInsertions: withDefault(Schema.Number, 0),
  totalDeletions: withDefault(Schema.Number, 0),
});

/**
 * A decoded change set.
 *
 * @since 1.0.0
 * @category models
 */
export type Changes = typeof Changes.Type;
