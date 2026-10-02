import { parsePatchCommentableLines } from "./parsePatchCommentableLines.ts";
import type { PullRequestTarget } from "./resolvePullRequest.ts";
import { runGh as defaultRunGh, runGhJsonLines } from "./runGh.ts";

export type PullRequestFile = {
  filename: string;
  additions: number;
  deletions: number;
  /** New-side lines a review comment can anchor to; empty for binary/huge diffs (no patch). */
  commentableLines: Set<number>;
};

/**
 * Changed files in the PR, keyed by path, with per-file stats and the
 * new-side line numbers present in each file's diff. Findings only anchor
 * inline when their line is actually commentable in the PR's diff; the PR
 * head can differ from the locally reviewed ref, so this boundary check stays
 * even though the review lib validates against its own hunks upstream.
 */
export async function listPullRequestFiles(
  repoDir: string,
  pr: PullRequestTarget,
  runGh: typeof defaultRunGh = defaultRunGh,
): Promise<Map<string, PullRequestFile>> {
  const records = await runGhJsonLines(
    repoDir,
    [
      "api",
      "--paginate",
      `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/files`,
      "--jq",
      ".[] | {filename, additions, deletions, patch} | @json",
    ],
    runGh,
  );
  const files = new Map<string, PullRequestFile>();
  for (const parsed of records) {
    const record = parsed as { filename?: unknown; additions?: unknown; deletions?: unknown; patch?: unknown };
    if (typeof record.filename !== "string" || !record.filename) continue;
    files.set(record.filename, {
      filename: record.filename,
      additions: typeof record.additions === "number" ? record.additions : 0,
      deletions: typeof record.deletions === "number" ? record.deletions : 0,
      commentableLines: parsePatchCommentableLines(typeof record.patch === "string" ? record.patch : ""),
    });
  }
  return files;
}
