// Cap a single file's diff before embedding it in an agent prompt, so one huge
// file cannot crowd out the rest of the review context. Every prompt truncates
// through here, so they share one marker. The default serves the verifier and
// narration prompts; the per-file reviewer and the narrator pass their own limit.
const perFileDiffLimit = 20_000;

export function trimDiff(diff: string, limit: number = perFileDiffLimit): string {
  if (diff.length <= limit) return diff;
  return `${diff.slice(0, limit)}\n[diff truncated for prompt size]`;
}
