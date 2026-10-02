import { ChangeSetUnreadable, WalkthroughUnwritable, reasonOf } from "./reviewFailureSchema.ts";
import { withDefault } from "../schema/withDefault.ts";
/**
 * The review flow's non-model steps.
 *
 * Every one of these is local git work or pure computation, declared with
 * `Action.make` so the run records it once and a resume replays the record
 * instead of re-shelling out. The implementations are the 0.x functions
 * unchanged; only the declaration around them is new.
 *
 * @since 1.0.0
 */
import { withIo } from "../io.ts";
import { FileSystem, Layer } from "effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { Action } from "@smthrs/flow";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { pluralize } from "../text/pluralize.ts";
import { changesFromDiffs } from "../walkthrough/changesFromDiffs.ts";
import { Changes } from "../walkthrough/changesSchema.ts";
import { normalizeStory } from "../walkthrough/normalizeStory.ts";
import { renderWalkthroughHtml } from "../walkthrough/renderWalkthroughHtml.ts";
import { walkthroughPath } from "../walkthrough/walkthroughPath.ts";
import { writeWalkthroughArtifact } from "../walkthrough/writeWalkthroughArtifact.ts";
import { Story } from "../walkthrough/storySchema.ts";
import { applyFindingVerdicts } from "./applyFindingVerdicts.ts";
import { finalizeNativeReview } from "../review/finalizeNativeReview.ts";
import { loadReviewSnapshot } from "../review/loadReviewSnapshot.ts";
import { nativeReviewPromptFromSnapshot } from "../review/nativeReviewPromptFromSnapshot.ts";
import { previewFromSnapshot } from "../review/previewFromSnapshot.ts";
import { ReviewRunOutput } from "./reviewRunOutputSchema.ts";
import { ReviewTarget } from "./reviewTargetSchema.ts";
import { ReviewInput } from "./reviewInputSchema.ts";
import {
  FileBatch,
  FileOutcome,
  FileOutcomes,
  PreparedReview,
  WalkthroughOutput,
} from "./reviewSchemas.ts";
import { SEAT } from "./reviewSeats.ts";
import { VerifyVerdicts } from "./verifyVerdictsSchema.ts";

/**
 * Verification is only worth an agent round trip for a plausible finding count.
 * A review with hundreds of comments is noise the verifier cannot honestly
 * adjudicate in one pass.
 *
 * @since 1.0.0
 * @category constants
 */
export const MAX_VERIFIABLE_FINDINGS = 40;

/**
 * Reads the change set once, then derives the preview, the walkthrough's
 * changes and the per-file review prompts from that one snapshot.
 *
 * Awaiting three readers inside one step would not make them atomic: a working
 * tree edited, or a branch moved, between them leaves a review whose prompts
 * and walkthrough disagree about what changed. Only a single read does.
 *
 * @since 1.0.0
 * @category actions
 */
export const PrepareReview = Action.make("smithers-review/PrepareReview", {
  payload: { input: ReviewInput },
  success: PreparedReview,
  error: ChangeSetUnreadable,
});

/**
 * The implementation layer for {@link PrepareReview}.
 *
 * @since 1.0.0
 * @category layers
 */
export const prepareReviewLayer = Layer.unwrap(Effect.gen(function*() {
 const fs = yield* FileSystem.FileSystem;
 const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
 return PrepareReview.toLayer(({ input }) =>
  Effect.gen(function*() {
    // Without review seats the per-file steps never run, so the finalizer must
    // see `runReview: false` and report "skipped" rather than "failed".
    const snapshot = yield* Effect.tryPromise({
      try: (signal) => withIo({ fs, spawner, signal }, () => loadReviewSnapshot(input, { out: input.out, db: "" })),
      catch: (cause) => new ChangeSetUnreadable({ repo: input.repo, message: reasonOf(cause) }),
    });
    const preview = previewFromSnapshot(snapshot);
    const changes = changesFromDiffs(snapshot.diffs, preview);
    const prompt = nativeReviewPromptFromSnapshot(snapshot, preview);
    return { target: snapshot.target, preview, changes, prompt };
  }));
}));

/**
 * Appends one concurrency batch's answers to the outcomes collected so far.
 *
 * The batch arrives keyed by step id because `Node.all` is keyed, and the file
 * order the finalizer needs is recovered from the prepared prompt rather than
 * from completion order.
 *
 * @since 1.0.0
 * @category actions
 */
export const MergeFileBatch = Action.make("smithers-review/MergeFileBatch", {
  payload: { previous: FileOutcomes, batch: FileBatch },
  success: FileOutcomes,
});

/**
 * The implementation layer for {@link MergeFileBatch}.
 *
 * @since 1.0.0
 * @category layers
 */
export const mergeFileBatchLayer = MergeFileBatch.toLayer(({ batch, previous }) =>
  Effect.sync(() => {
    const merged: Array<FileOutcome> = [...previous];
    for (const fileId of Object.keys(batch).sort()) {
      merged.push({ fileId, output: batch[fileId] ?? null });
    }
    return merged;
  })
);

/**
 * Turns the per-file answers into one review: scope, anchor, de-duplicate,
 * sort, and count.
 *
 * @since 1.0.0
 * @category actions
 */
export const FinalizeReview = Action.make("smithers-review/FinalizeReview", {
  payload: { input: ReviewInput, prepared: PreparedReview, outcomes: FileOutcomes },
  success: ReviewRunOutput,
});

/**
 * The implementation layer for {@link FinalizeReview}.
 *
 * @since 1.0.0
 * @category layers
 */
export const finalizeReviewLayer = FinalizeReview.toLayer(({ input, outcomes, prepared }) =>
  Effect.sync(() => {
    const byFileId = new Map(outcomes.map((outcome) => [outcome.fileId, outcome.output]));
    const results = prepared.prompt.files.map((file) => ({
      file,
      output: byFileId.get(file.id) ?? null,
    }));
    const finalized = finalizeNativeReview(input, prepared.prompt, prepared.preview, results);
    const verifyRequested = input.verify;
    if (verifyRequested && finalized.comments.length > MAX_VERIFIABLE_FINDINGS) {
      // Silently skipping verification would read as "verified"; surface the
      // cap so downstream consumers show it.
      return {
        ...finalized,
        warnings: [
          ...finalized.warnings,
          {
            file: "",
            type: "verifier_skipped",
            message:
              `${finalized.comments.length} findings exceeds the ${MAX_VERIFIABLE_FINDINGS}-finding verification cap; findings are unverified.`,
          },
        ],
      };
    }
    return finalized;
  })
);

/**
 * Applies the verifier's verdicts to the review.
 *
 * A `null` verdict set means the verifier step failed and was caught: the
 * review is kept as it stands and a `verifier_error` warning records that
 * nothing was verified.
 *
 * @since 1.0.0
 * @category actions
 */
export const ApplyVerdicts = Action.make("smithers-review/ApplyVerdicts", {
  payload: {
    review: ReviewRunOutput,
    verdicts: Schema.NullOr(VerifyVerdicts),
    failure: Schema.optional(Schema.String),
  },
  success: ReviewRunOutput,
});

/**
 * The implementation layer for {@link ApplyVerdicts}.
 *
 * @since 1.0.0
 * @category layers
 */
export const applyVerdictsLayer = ApplyVerdicts.toLayer(({ review, verdicts, failure }) =>
  Effect.sync(() => {
    if (verdicts === null) {
      return {
        ...review,
        status: review.status === "success" ? "completed_with_warnings" as const : review.status,
        warnings: [
          ...review.warnings,
          {
            file: "",
            type: "verifier_error",
            message: `${SEAT.verify}: ${failure || "Finding verification produced no output"}; findings are unverified.`,
          },
        ],
      };
    }
    const applied = applyFindingVerdicts(review.comments, verdicts.verdicts);
    return {
      ...review,
      comments: applied.findings,
      warnings: [...review.warnings, ...applied.warnings],
      summary: review.summary ? { ...review.summary, comments: applied.findings.length } : null,
      message: applied.dropped > 0
        ? `${review.message} Verification dropped ${pluralize(applied.dropped, "finding")}.`
        : review.message,
    };
  })
);

/**
 * Renders the story-form HTML walkthrough and writes it to disk.
 *
 * @since 1.0.0
 * @category actions
 */
export const RenderWalkthrough = Action.make("smithers-review/RenderWalkthrough", {
  error: WalkthroughUnwritable,
  payload: {
    input: ReviewInput,
    target: ReviewTarget,
    changes: Changes,
    review: ReviewRunOutput,
    narrateFailure: withDefault(Schema.String, ""),
    story: Schema.NullOr(Story),
  },
  success: Schema.Struct({
    review: ReviewRunOutput,
    walkthrough: WalkthroughOutput,
    story: Story,
    ui: Schema.Struct({ kind: Schema.Literal("html"), title: Schema.String, html: Schema.String }),
  }),
});

/**
 * The implementation layer for {@link RenderWalkthrough}.
 *
 * @since 1.0.0
 * @category layers
 */
export const renderWalkthroughLayer = Layer.unwrap(Effect.gen(function*() {
 const fs = yield* FileSystem.FileSystem;
 const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
 return RenderWalkthrough.toLayer(
  ({ changes, input, review: originalReview, story: rawStory, target, narrateFailure }) =>
    Effect.gen(function*() {
      const warnings = [
        ...(narrateFailure ? [{ file: "", type: "narrator_error", message: narrateFailure }] : []),
      ];
      const review = warnings.length === 0 ? originalReview : {
        ...originalReview,
        status: originalReview.status === "success" ? "completed_with_warnings" as const : originalReview.status,
        warnings: [...originalReview.warnings, ...warnings],
      };
      const story = normalizeStory(rawStory, changes.files);
      const html = yield* Effect.promise(() => renderWalkthroughHtml({
        title: input.title,
        story,
        files: changes.files,
        comments: review.comments,
        outcome: {
          status: review.status,
          warnings: review.warnings,
          files: changes.files.map((file) => {
            const errors = review.warnings.filter((warning) => warning.file === file.path && warning.type === "subtask_error");
            const reason = !file.reviewed ? file.excludeReason || "outside review scope"
              : review.status === "skipped" ? "review skipped"
              : errors.length > 0 ? errors.map((warning) => warning.message || "file review failed or incomplete").join("; ")
              : review.status === "failed" ? "review failed"
              : "";
            return { path: file.path, status: reason ? "not_reviewed" as const : "reviewed" as const, reason };
          }),
        },
        repoDir: target.repoDir,
        mode: target.mode,
        ref: target.ref,
        generatedAt: new Date().toISOString(),
        diffStyle: (input.split ? "split" : "unified") as "split" | "unified",
      }));
      const outPath = walkthroughPath(target.repoDir, input.out);
      const artifactPath = yield* Effect.tryPromise({
        try: (signal) => withIo({ fs, spawner, signal }, () => writeWalkthroughArtifact(target.repoDir, outPath, html)),
        catch: (cause) => new WalkthroughUnwritable({ path: outPath, message: reasonOf(cause) }),
      });
      return {
        review,
        walkthrough: {
          path: outPath,
          artifactPath,
          bytes: Buffer.byteLength(html),
          chapters: story.chapters.length,
          files: changes.files.length,
          findings: review.comments.length,
          message: `Walkthrough written to ${outPath} (${pluralize(story.chapters.length, "chapter")}, ${
            pluralize(review.comments.length, "finding")
          }).`,
        },
        story,
        ui: { kind: "html" as const, title: input.title || story.headline, html },
      };
    }));
}));
