const PER_FILE_DIFF_FLOOR = 3_500;
const PER_FILE_DIFF_CAP = 30_000;

/**
 * Per-file diff excerpt budget for the narrator prompt: an even share of the
 * total excerpt limit, floored at 3.5k so small change sets never starve a
 * file below the old flat limit and capped at 30k so one giant diff cannot
 * eat the whole prompt.
 */
export function perFileExcerptLimit(fileCount: number, totalLimit: number): number {
  if (fileCount <= 0) return PER_FILE_DIFF_CAP;
  const share = Math.floor(totalLimit / fileCount);
  return Math.min(PER_FILE_DIFF_CAP, Math.max(PER_FILE_DIFF_FLOOR, share));
}
