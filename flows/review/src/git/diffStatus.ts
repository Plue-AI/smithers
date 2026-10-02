import type { DiffRecord } from "./diffRecord.ts";

/**
 * How this file changed, as the preview and the walkthrough label it.
 *
 * @since 1.0.0
 * @category constructors
 */
export function diffStatus(diff: DiffRecord) {
  if (diff.isBinary) return "binary";
  if (diff.isNew) return "added";
  if (diff.isDeleted) return "deleted";
  if (diff.oldPath !== diff.newPath && diff.oldPath && diff.oldPath !== "/dev/null") return "renamed";
  return "modified";
}
