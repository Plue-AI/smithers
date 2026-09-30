import { diffStatus } from "../git/diffStatus.ts";
import { effectivePath } from "../git/effectivePath.ts";
import type { DiffRecord } from "../git/diffRecord.ts";
import type { PreviewOutput } from "../workflow/previewOutputSchema.ts";
import type { Changes } from "./changesSchema.ts";

/**
 * Turns one already-read set of diff records into the walkthrough's file list.
 *
 * Pure over the records it is handed, so the walkthrough describes exactly the
 * change set the preview and the review prompts were built from.
 */
export function changesFromDiffs(diffs: Array<DiffRecord>, preview: PreviewOutput): Changes {
  const previewByPath = new Map(preview.entries.map((entry) => [entry.path, entry]));
  const files = diffs.map((diff) => {
    const path = effectivePath(diff);
    const entry = previewByPath.get(path);
    return {
      path,
      status: diffStatus(diff),
      insertions: diff.insertions,
      deletions: diff.deletions,
      diff: diff.isBinary ? "" : diff.diff,
      reviewed: entry?.willReview ?? false,
      excludeReason: entry?.excludeReason ?? "",
    };
  });
  return {
    files,
    totalFiles: files.length,
    totalInsertions: files.reduce((sum, file) => sum + file.insertions, 0),
    totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}
