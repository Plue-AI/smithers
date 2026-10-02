/**
 * One file's entry in a parsed `git diff`, before any review filter runs.
 *
 * A rename carries both paths, and a deletion spells the missing side
 * `/dev/null`, so `effectivePath` is what decides which name a finding uses.
 *
 * @since 1.0.0
 * @category models
 */
export type DiffRecord = {
  oldPath: string;
  newPath: string;
  diff: string;
  insertions: number;
  deletions: number;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
};
