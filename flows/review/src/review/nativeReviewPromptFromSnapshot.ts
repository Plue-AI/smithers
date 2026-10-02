import * as Schema from "effect/Schema";
import { NativeReviewPrompt } from "../workflow/nativeReviewPromptSchema.ts";
import { whyExcluded } from "./whyExcluded.ts";
import { effectivePath } from "../git/effectivePath.ts";
import { diffStatus } from "../git/diffStatus.ts";
import { reviewFileTaskId } from "./reviewFileTaskId.ts";
import { buildFileReviewPrompt } from "./buildFileReviewPrompt.ts";
import type { DiffRecord } from "../git/diffRecord.ts";
import type { FileFilter } from "./fileFilter.ts";
import type { ReviewSnapshot } from "./reviewSnapshot.ts";
import type { PreviewOutput } from "../workflow/previewOutputSchema.ts";

const decodePrompt = Schema.decodeUnknownSync(NativeReviewPrompt);

function reviewableDiffs(diffs: DiffRecord[], filter: FileFilter | null) {
  // Matches previewFromSnapshot: deletions with removed content are reviewable.
  return diffs.filter((diff) => whyExcluded(diff, filter) === "" && !(diff.isDeleted && diff.deletions === 0));
}
/**
 * Builds the whole fan-out plan: which files to review, and the exact prompt
 * each one's seat is given.
 *
 * The diffs come from the snapshot rather than a fresh read, so the reviewing
 * round never depends on a working tree that may have moved under the run.
 *
 * @since 1.0.0
 * @category constructors
 */
export function nativeReviewPromptFromSnapshot(
  snapshot: ReviewSnapshot,
  preview: PreviewOutput,
): NativeReviewPrompt {
  const { input, target } = snapshot;
  if (!input.runReview) {
    return decodePrompt({
      shouldReview: false,
      repoDir: target.repoDir,
      mode: target.mode,
      ref: target.ref,
      warnings: snapshot.warnings,
      reviewableFiles: preview.reviewableCount,
      excludedFiles: preview.excludedCount,
      files: [],
      message: "Review execution disabled by input.runReview.",
    });
  }
  if (preview.reviewableCount === 0) {
    return decodePrompt({
      shouldReview: false,
      repoDir: target.repoDir,
      mode: target.mode,
      ref: target.ref,
      warnings: snapshot.warnings,
      reviewableFiles: 0,
      excludedFiles: preview.excludedCount,
      files: [],
      message: "No supported files changed.",
    });
  }

  const allDiffs = snapshot.diffs;
  const diffs = reviewableDiffs(allDiffs, snapshot.filter);
  if (diffs.length === 0) {
    return decodePrompt({
      shouldReview: false,
      repoDir: target.repoDir,
      mode: target.mode,
      ref: target.ref,
      warnings: snapshot.warnings,
      reviewableFiles: 0,
      excludedFiles: preview.excludedCount,
      files: [],
      message: "No supported files changed.",
    });
  }

  const files = diffs.map((diff, index) => {
    const path = effectivePath(diff);
    return {
      id: reviewFileTaskId(path, index),
      path,
      status: diffStatus(diff),
      insertions: diff.insertions,
      deletions: diff.deletions,
      diff: diff.diff,
      prompt: buildFileReviewPrompt(target, input, diff, allDiffs),
    };
  });

  return decodePrompt({
    shouldReview: true,
    repoDir: target.repoDir,
    mode: target.mode,
    ref: target.ref,
    warnings: snapshot.warnings,
    reviewableFiles: diffs.length,
    excludedFiles: preview.excludedCount,
    files,
    message: `Prepared native review for ${diffs.length} file(s).`,
  });
}
