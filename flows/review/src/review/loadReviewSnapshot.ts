import { reasonOf } from "../workflow/reviewFailureSchema.ts";
import { normalizeOpenCodeReviewInput } from "../workflow/normalizeOpenCodeReviewInput.ts";
import { resolveReviewTarget } from "./resolveReviewTarget.ts";
import { runGit } from "../git/runGit.ts";
import { reviewMode } from "./reviewMode.ts";
import { buildFileFilter } from "./buildFileFilter.ts";
import { loadDiffs } from "../git/loadDiffs.ts";
import { reviewOwnPaths } from "./reviewOwnPaths.ts";
import type { OpenCodeReviewInput } from "../workflow/openCodeReviewInputSchema.ts";
import type { ReviewSnapshot } from "./reviewSnapshot.ts";

// A branch name read twice can name two commits. Pinning the endpoints once
// keeps merge-base, the diff itself and any later read on the same revisions.
async function pinRevisions(repoDir: string, input: OpenCodeReviewInput): Promise<OpenCodeReviewInput> {
  // `--verify` keeps rev-parse strict: without it, an option it does not
  // recognize is echoed into the output instead of rejected.
  const pin = async (rev: string) => {
    try {
      return (await runGit(repoDir, ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`], 30_000)).trim();
    } catch (cause) {
      throw new Error(`${rev} does not name a commit: ${reasonOf(cause)}`, { cause });
    }
  };
  const mode = reviewMode(input);
  if (mode === "commit") return { ...input, commit: await pin(input.commit.trim()) };
  if (mode === "range") return { ...input, from: await pin(input.from.trim()), to: await pin(input.to.trim()) };
  return input;
}

/**
 * Resolves the target, pins its revisions, and reads every diff once.
 *
 * `outputs` names the walkthrough and database paths the run writes, so the
 * snapshot leaves them out when they lie inside the repository.
 *
 * @since 1.0.0
 * @category constructors
 */
export async function loadReviewSnapshot(
  input: OpenCodeReviewInput,
  outputs: { out: string; db: string } = { out: "", db: "" },
): Promise<ReviewSnapshot> {
  const normalized = normalizeOpenCodeReviewInput(input);
  const target = await resolveReviewTarget(normalized);
  const pinned = await pinRevisions(target.repoDir, normalized);
  const { filter, warnings } = await buildFileFilter(target.repoDir, pinned);
  return {
    input: pinned,
    target,
    filter,
    warnings,
    diffs: await loadDiffs(target.repoDir, pinned, reviewOwnPaths(target.repoDir, outputs)),
  };
}
