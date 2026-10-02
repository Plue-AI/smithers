import * as Schema from "effect/Schema";
import { PreviewEntry } from "./previewEntrySchema.ts";

/**
 * The whole change set before any seat is asked: every file, with the totals
 * the walkthrough header and the run summary both read.
 *
 * @since 1.0.0
 * @category schemas
 */
export const PreviewOutput = Schema.Struct({
  entries: Schema.mutable(Schema.Array(PreviewEntry)),
  totalInsertions: Schema.Number,
  totalDeletions: Schema.Number,
  totalFiles: Schema.Number,
  reviewableCount: Schema.Number,
  excludedCount: Schema.Number,
});

/**
 * A decoded preview.
 *
 * @since 1.0.0
 * @category models
 */
export type PreviewOutput = typeof PreviewOutput.Type;
