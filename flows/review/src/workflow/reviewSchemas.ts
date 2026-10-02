/**
 * The schemas the review flow's rounds hand to one another.
 *
 * A round's payload is real data (`Flow.to` ends the round and starts the next
 * one with its payload decoded), which is what lets a body fan out over a file
 * list a previous round discovered. Everything a later round reads therefore
 * has to be declared here and carried, not recomputed: re-running `git diff` in
 * the last round would read a working tree that may have moved under the run.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
import { arrayOf, withDefault } from "../schema/withDefault.ts";
import { Changes } from "../walkthrough/changesSchema.ts";
import { Story } from "../walkthrough/storySchema.ts";
import { NativeReviewAgentOutput } from "./nativeReviewAgentOutputSchema.ts";
import { NativeReviewPrompt } from "./nativeReviewPromptSchema.ts";
import { PreviewOutput } from "./previewOutputSchema.ts";
import { ReviewRunOutput } from "./reviewRunOutputSchema.ts";
import { ReviewTarget } from "./reviewTargetSchema.ts";
import { ReviewInput } from "./reviewInputSchema.ts";

/**
 * Everything the local git work produces in one durable step.
 *
 * @since 1.0.0
 * @category schemas
 */
export const PreparedReview = Schema.Struct({
  target: ReviewTarget,
  preview: PreviewOutput,
  changes: Changes,
  prompt: NativeReviewPrompt,
});

/**
 * A decoded preparation result.
 *
 * @since 1.0.0
 * @category models
 */
export type PreparedReview = typeof PreparedReview.Type;

/**
 * What one file's review seat produced, or `null` when its step failed.
 *
 * A failed file review is data, not a run failure: 0.x spelled that
 * `continueOnFail`, and `finalizeNativeReview` turns a null into a
 * `subtask_error` warning.
 *
 * @since 1.0.0
 * @category schemas
 */
export const FileOutcome = Schema.Struct({
  fileId: Schema.String,
  output: Schema.NullOr(NativeReviewAgentOutput),
});

/**
 * A decoded per-file outcome.
 *
 * @since 1.0.0
 * @category models
 */
export type FileOutcome = typeof FileOutcome.Type;

/**
 * One concurrency batch's answers, keyed by the file's step id.
 *
 * @since 1.0.0
 * @category schemas
 */
export const FileBatch = Schema.Record(Schema.String, Schema.NullOr(NativeReviewAgentOutput));

/**
 * A decoded batch.
 *
 * @since 1.0.0
 * @category models
 */
export type FileBatch = typeof FileBatch.Type;

/**
 * The accumulator threaded through the concurrency batches.
 *
 * @since 1.0.0
 * @category schemas
 */
export const FileOutcomes = withDefault(Schema.Array(FileOutcome), []);

/**
 * A decoded outcome list.
 *
 * @since 1.0.0
 * @category models
 */
export type FileOutcomes = typeof FileOutcomes.Type;

/**
 * The payload the file-review round runs under.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ReviewFilesPayload = Schema.Struct({
  input: ReviewInput,
  prepared: PreparedReview,
  offset: withDefault(Schema.Number, 0),
  outcomes: FileOutcomes,
});

/**
 * The payload the verification round runs under.
 *
 * @since 1.0.0
 * @category schemas
 */
export const VerifyReviewPayload = Schema.Struct({
  input: ReviewInput,
  target: ReviewTarget,
  changes: Changes,
  review: ReviewRunOutput,
});

/**
 * The payload the narration round runs under. Its `review` is post-verification.
 *
 * @since 1.0.0
 * @category schemas
 */
export const NarrateReviewPayload = VerifyReviewPayload;

/**
 * The walkthrough file the last round writes, plus the counts the CLI's run
 * summary prints.
 *
 * The story is decoded once on ReviewResult.
 *
 * @since 1.0.0
 * @category schemas
 */
export const WalkthroughOutput = Schema.Struct({
  path: Schema.String,
  artifactPath: withDefault(Schema.String, ""),
  bytes: Schema.Number,
  chapters: Schema.Number,
  files: Schema.Number,
  findings: Schema.Number,
  message: withDefault(Schema.String, ""),
});

/**
 * A decoded walkthrough result.
 *
 * @since 1.0.0
 * @category models
 */
export type WalkthroughOutput = typeof WalkthroughOutput.Type;

/**
 * What a whole review run answers with.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ReviewResult = Schema.Struct({
  target: ReviewTarget,
  review: ReviewRunOutput,
  walkthrough: WalkthroughOutput,
  story: Story,
  ui: Schema.Struct({ kind: Schema.Literal("html"), title: Schema.String, html: Schema.String }),
});

/**
 * A decoded review result.
 *
 * @since 1.0.0
 * @category models
 */
export type ReviewResult = typeof ReviewResult.Type;
