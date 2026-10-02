import { whyExcluded } from "./whyExcluded.ts";
import { effectivePath } from "../git/effectivePath.ts";
import { diffStatus } from "../git/diffStatus.ts";
import type { ReviewSnapshot } from "./reviewSnapshot.ts";
import type { PreviewOutput } from "../workflow/previewOutputSchema.ts";

/**
 * Reports what a review would read without asking any seat: every changed
 * file, its size, and whether the filters keep it.
 *
 * @since 1.0.0
 * @category constructors
 */
export function previewFromSnapshot(snapshot: ReviewSnapshot): PreviewOutput {
  const diffs = snapshot.diffs;
  const entries = diffs.map((diff) => {
    let excludeReason = whyExcluded(diff, snapshot.filter);
    // Deleting code can break callers, so deletions with real removed content stay
    // reviewable; only content-free deletions (empty files) are skipped.
    if (excludeReason === "" && diff.isDeleted && diff.deletions === 0) excludeReason = "deleted";
    return {
      path: effectivePath(diff),
      status: diffStatus(diff),
      insertions: diff.insertions,
      deletions: diff.deletions,
      willReview: excludeReason === "",
      excludeReason,
    };
  });
  return {
    entries,
    totalInsertions: diffs.reduce((sum, diff) => sum + diff.insertions, 0),
    totalDeletions: diffs.reduce((sum, diff) => sum + diff.deletions, 0),
    totalFiles: diffs.length,
    reviewableCount: entries.filter((entry) => entry.willReview).length,
    excludedCount: entries.filter((entry) => !entry.willReview).length,
  };
}
