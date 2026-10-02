import { io, runIo } from "../io.ts";
import { join } from "node:path";
import { runCommand } from "../git/runCommand.ts";
import { resolve } from "node:path";
import { normalizeOpenCodeReviewInput } from "../workflow/normalizeOpenCodeReviewInput.ts";
import { validateReviewInput } from "./validateReviewInput.ts";
import { reviewMode } from "./reviewMode.ts";
import { runGit } from "../git/runGit.ts";
import type { OpenCodeReviewInput } from "../workflow/openCodeReviewInputSchema.ts";
import type { ReviewTarget } from "../workflow/reviewTargetSchema.ts";

/**
 * Resolves a request against a real repository: validates the mode, confirms
 * the directory is a git repository, and pins the ref the review will read.
 *
 * @since 1.0.0
 * @category constructors
 */
export async function resolveReviewTarget(input: OpenCodeReviewInput): Promise<ReviewTarget> {
  input = normalizeOpenCodeReviewInput(input);
  validateReviewInput(input);
  const repoDir = resolve(input.repo || ".");
  if (await runIo(io().fs.exists(join(repoDir, ".jj"))) && reviewMode(input) === "workspace") {
    const result = await runCommand("jj", ["workspace", "root"], repoDir, 30_000);
    if (result.exitCode !== 0) throw new Error(result.stderr || "Cannot read jj workspace");
  } else await runGit(repoDir, ["rev-parse", "--git-dir"], 30_000);
  const mode = reviewMode(input);
  const ref =
    mode === "commit"
      ? input.commit.trim()
      : mode === "range"
        ? `${input.from.trim()}..${input.to.trim()}`
        : "workspace";
  return { repoDir, mode, ref };
}
