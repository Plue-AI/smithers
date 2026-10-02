import { isAbsolute, relative, resolve, sep } from "node:path";
import { walkthroughArtifactsDir } from "../walkthrough/walkthroughArtifactsDir.ts";
import { walkthroughPath } from "../walkthrough/walkthroughPath.ts";

/**
 * The repo-relative paths a run writes inside the repository it reviews: the
 * walkthrough, its artifact directory, and the database with its SQLite
 * sidecars. Paths outside the repository are left out.
 *
 * `loadDiffs` drops these so a working-tree review never sends the tool's own
 * output to a review seat.
 */
export function reviewOwnPaths(repoDir: string, outputs: { out: string; db: string }): Array<string> {
  const out = walkthroughPath(repoDir, outputs.out);
  const written = [out, walkthroughArtifactsDir(out)];
  const db = outputs.db.trim();
  if (db) {
    const dbPath = resolve(repoDir, db);
    written.push(dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`);
  }
  return written.flatMap((path) => {
    const rel = relative(repoDir, path);
    const outside = rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    return outside ? [] : [rel.split(sep).join("/")];
  });
}
