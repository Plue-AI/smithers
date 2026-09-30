import { rankSeverity } from "./rankSeverity.ts";
import type { ReviewComment } from "../workflow/reviewCommentSchema.ts";

/**
 * The letters and digits of a finding in any script, case-folded, as code
 * points: punctuation and spacing never make two findings distinct.
 */
function normalizedContentKey(value: string) {
  return Array.from(value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, ""));
}

function nearIdenticalContent(a: string, b: string) {
  const keyA = normalizedContentKey(a);
  const keyB = normalizedContentKey(b);
  // Nothing but punctuation or symbols: only the same text is a duplicate.
  if (keyA.length === 0 || keyB.length === 0) return a.trim() === b.trim();
  if (keyA.join("") === keyB.join("")) return true;
  const longer = Math.max(keyA.length, keyB.length);
  const shorter = Math.min(keyA.length, keyB.length);
  if (shorter / longer < 0.9) return false;

  const previous = Array.from({ length: keyB.length + 1 }, (_, index) => index);
  for (let aIndex = 1; aIndex <= keyA.length; aIndex += 1) {
    let diagonal = previous[0];
    previous[0] = aIndex;
    for (let bIndex = 1; bIndex <= keyB.length; bIndex += 1) {
      const above = previous[bIndex];
      const substitutionCost = keyA[aIndex - 1] === keyB[bIndex - 1] ? 0 : 1;
      previous[bIndex] = Math.min(previous[bIndex] + 1, previous[bIndex - 1] + 1, diagonal + substitutionCost);
      diagonal = above;
    }
  }
  return 1 - previous[keyB.length] / longer >= 0.9;
}

function commentLinesOverlap(a: { startLine: number; endLine: number }, b: { startLine: number; endLine: number }) {
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}
/**
 * Drops near-identical findings on overlapping lines of the same file, keeping
 * the most severe copy, and counts what it dropped.
 */
export function dedupeFindings(comments: Array<ReviewComment>) {
  const kept: Array<ReviewComment> = [];
  let dropped = 0;
  for (const comment of comments) {
    const duplicateIndex = kept.findIndex(
      (existing) =>
        existing.path === comment.path &&
        commentLinesOverlap(existing, comment) &&
        nearIdenticalContent(existing.content, comment.content),
    );
    if (duplicateIndex < 0) {
      kept.push(comment);
      continue;
    }
    dropped += 1;
    if (rankSeverity(comment.severity) < rankSeverity(kept[duplicateIndex].severity)) {
      kept[duplicateIndex] = comment;
    }
  }
  return { comments: kept, dropped };
}
