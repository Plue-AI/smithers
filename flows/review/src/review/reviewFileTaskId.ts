/**
 * A stable, readable step id for one file's review.
 *
 * The index keeps it unique when two paths slug identically, so a resumed run
 * lands on the step it left.
 *
 * @since 1.0.0
 * @category constructors
 */
export function reviewFileTaskId(path: string, index: number) {
  const slug = path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return `review-file-${index + 1}-${slug || "file"}`;
}
