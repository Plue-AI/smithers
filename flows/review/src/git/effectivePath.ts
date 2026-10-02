import type { DiffRecord } from "./diffRecord.ts";

/**
 * The path a finding on this diff should name: the new one, except for a
 * deletion, which has none.
 *
 * @since 1.0.0
 * @category constructors
 */
export function effectivePath(diff: DiffRecord) {
  return diff.newPath === "/dev/null" ? diff.oldPath : diff.newPath;
}
