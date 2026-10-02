import { runGit } from "./runGit.ts";

/**
 * The commit a range review diffs against: the merge-base of `from` and `to`.
 */
export async function mergeBase(repoDir: string, from: string, to: string) {
  const base = (await runGit(repoDir, ["merge-base", "--end-of-options", from.trim(), to.trim()])).trim();
  if (!base) throw new Error(`Cannot find merge-base between ${from} and ${to}.`);
  return base;
}
