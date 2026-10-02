// Values produced by whyExcluded in
// ../review/whyExcluded.ts, plus "deleted" from ../review/previewFromSnapshot.ts.
const reasonLabels: Record<string, string> = {
  binary: "binary file",
  user_exclude: "excluded by review rules",
  unsupported_ext: "file type not reviewed",
  default_path: "outside the default review set",
  provider_dir: "vendor or tool directory",
  deleted: "deleted with no reviewable content",
};

/** Human label for a review exclude reason; unknown enums degrade to readable text. */
export function humanizeExcludeReason(reason: string): string {
  return reasonLabels[reason] ?? reason.replace(/_/g, " ");
}
