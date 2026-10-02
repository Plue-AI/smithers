import { ReviewFailure } from "./reviewFailureSchema.ts";
/**
 * The review workflow, as four durable stages.
 *
 * `Node.all` fixes its width at plan time, and the file list a review fans out
 * over is something the first step discovers. That is what the rounds are for:
 * `Flow.to` ends a round and starts the next one with its payload as REAL
 * data, so the second round's body can read `prepared.prompt.files` and build
 * one node per file. Verification gets a round of its own for the same reason —
 * whether to narrate is decided from the POST-verification findings,
 * which do not exist until the verifying round has settled.
 *
 * Stage 1 `Review`          prepare, then hand off
 * Stage 2 `ReviewFiles`     one bounded batch per round, then finalize
 * Stage 3 `VerifyReview`    adjudicate the findings
 * Stage 4 `NarrateReview`   narrate, render the walkthrough
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow";
import { Node } from "@smthrs/plan";
import * as Schema from "effect/Schema";
import { NarrateChanges, ReviewFile, VerifyFindings } from "./reviewAgentActions.ts";
import {
  ApplyVerdicts,
  FinalizeReview,
  MAX_VERIFIABLE_FINDINGS,
  MergeFileBatch,
  RenderWalkthrough,
} from "./reviewActions.ts";
import { NativeReviewAgentOutput } from "./nativeReviewAgentOutputSchema.ts";
import {
  NarrateReviewPayload,
  ReviewFilesPayload,
  ReviewResult,
  VerifyReviewPayload,
} from "./reviewSchemas.ts";

/**
 * What the file-review rounds need from the composition.
 */
type FileReviewRequirement =
  | Action.Requirement<"smithers-review/ReviewFile">
  | Action.Requirement<"smithers-review/MergeFileBatch">
  | Action.Requirement<"smithers-review/FinalizeReview">;

/**
 * The narrating round: story and the rendered walkthrough.
 *
 * Every model step here is caught, because a review whose narrator timed out is
 * still a review. `normalizeStory` falls back to the deterministic story which is exactly what a caught failure hands the renderer.
 *
 * @since 1.0.0
 * @category flows
 */
export const NarrateReview = Flow.make("smithers-review/NarrateReview", {
  payload: NarrateReviewPayload,
  success: ReviewResult,
  error: ReviewFailure,
  body: ({ changes, input, review, target }) => {
    const narrating = input.narrate && changes.files.length > 0;
    const story = narrating
      ? NarrateChanges.call({
        timeout: input.timeout,
        files: changes.files,
        comments: review.comments,
        background: input.background,
        mode: target.mode,
        ref: target.ref,
      }).pipe(
        Node.map((value) => ({ value, failure: "" })),
        Node.catch({ onFailure: (error) => Node.succeed(error).pipe(
          Node.map((failure) => ({ value: null, failure: failure.message })),
        ) }),
      )
      : Node.succeed({ value: null, failure: "" });
    return story.pipe(
      Node.bindPlanned((narrated) =>
        RenderWalkthrough.call({
          input,
          target,
          changes,
          review,
          story: narrated.value,
          narrateFailure: narrated.failure,
        })
      ),
      Node.map((rendered) => ({
        target,
        review: rendered.review,
        walkthrough: rendered.walkthrough,
        story: rendered.story,
        ui: rendered.ui,
      })),
    );
  },
});

/**
 * The verifying round.
 *
 * A verifier that fails is caught and reported as unverified rather than
 * failing the review: the findings are still the findings.
 *
 * @since 1.0.0
 * @category flows
 */
export const VerifyReview = Flow.make("smithers-review/VerifyReview", {
  payload: VerifyReviewPayload,
  success: ReviewResult,
  error: ReviewFailure,
  body: ({ changes, input, review, target }) => {
    const verifying = input.verify &&
      review.comments.length >= 1 &&
      review.comments.length <= MAX_VERIFIABLE_FINDINGS;
    if (!verifying) {
      return NarrateReview.to({ input, target, changes, review });
    }
    return VerifyFindings.call({ findings: review.comments, files: changes.files, timeout: input.timeout }).pipe(
      Node.map((verdicts) => ({ verdicts, failure: "" })),
      Node.catch({
        onFailure: (error) => Node.succeed(error).pipe(
          Node.map((failure) => ({ verdicts: null, failure: failure.message })),
        ),
      }),
      Node.bindPlanned(({ verdicts, failure }) => ApplyVerdicts.call({ review, verdicts, failure })),
      Node.bindPlanned((verified) => NarrateReview.to({ input, target, changes, review: verified })),
    );
  },
});

/**
 * The maximum simultaneous file reviews when the input names no valid bound.
 *
 * @since 1.0.0
 * @category constants
 */
export const DEFAULT_CONCURRENCY = 8;

/**
 * The file-review round.
 *
 * Each round reviews at most `input.concurrency` files and records their
 * merged outcomes before handing off to the next batch. Only that round's
 * batch enters the plan, so the interpreter's concurrent dependency traversal
 * cannot start later batches early. The handoff carries the next offset and
 * accumulated outcomes, preserving completed batches across a resume.
 *
 * @since 1.0.0
 * @category flows
 */
export const ReviewFiles: Flow.Flow<
  "smithers-review/ReviewFiles",
  typeof ReviewFilesPayload,
  typeof ReviewResult,
  typeof ReviewFailure,
  FileReviewRequirement
> = Flow.make("smithers-review/ReviewFiles", {
  payload: ReviewFilesPayload,
  success: ReviewResult,
  error: ReviewFailure,
  body: ({ input, prepared, offset, outcomes }) => {
    const files = prepared.prompt.shouldReview ? prepared.prompt.files : [];
    const width = Number.isSafeInteger(input.concurrency) && input.concurrency > 0
      ? input.concurrency
      : DEFAULT_CONCURRENCY;
    if (offset < files.length) {
      const members: Record<string, Node.Node<NativeReviewAgentOutput | null, never, FileReviewRequirement>> = {};
      for (const file of files.slice(offset, offset + width)) {
        // A file whose review fails is a warning, not a dead run: 0.x spelled
        // this `continueOnFail`, and `finalizeNativeReview` turns the null into
        // a `subtask_error` warning against that file.
        members[file.id] = ReviewFile.call({ path: file.path, prompt: file.prompt, timeout: input.timeout }).pipe(
          Node.catch({ onFailure: (error) => Node.succeed(error).pipe(
            Node.map((failure) => Schema.decodeUnknownSync(NativeReviewAgentOutput)({ status: "failed", message: failure.message })),
          ) }),
        );
      }
      return Node.all(members).pipe(
        Node.bindPlanned((batch) => MergeFileBatch.call({ previous: outcomes, batch })),
        Node.bindPlanned((collected) =>
          ReviewFiles.to({ input, prepared, offset: offset + width, outcomes: collected })
        ),
      );
    }
    return FinalizeReview.call({ input, prepared, outcomes }).pipe(
      Node.bindPlanned((review) =>
        VerifyReview.to({
          input,
          target: prepared.target,
          changes: prepared.changes,
          review,
        })
      ),
    );
  },
});

/**
 * The review workflow's entry point.
 *
 * @since 1.0.0
 * @category flows
 */
/**
 * Every flow the review workflow registers.
 *
 * @since 1.0.0
 * @category constants
 */
export const flows = [ReviewFiles, VerifyReview, NarrateReview] as const;

/**
 * The result schema, re-exported so a host can decode a run's success without
 * importing the round schemas.
 *
 * @since 1.0.0
 * @category schemas
 */
export const Result: typeof ReviewResult = ReviewResult;

/**
 * A decoded review result.
 *
 * @since 1.0.0
 * @category models
 */
export type Result = Schema.Schema.Type<typeof ReviewResult>;
