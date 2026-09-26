import { spawn } from "node:child_process";
import { join } from "node:path";

/**
 * Spawns the `smithers-review` bin against a workspace checkout with the
 * inference environment `resolveInferenceEnv` chose and the matching publish
 * config, so the walkthrough is uploaded through the same session.
 *
 * Stdio is inherited so the user sees the CLI's progress in their job log. The
 * promise resolves with the exit code; the caller decides whether to fail the
 * action.
 *
 * @since 1.0.0
 */
export interface RunReviewInput {
  smithersRoot: string;
  workspace: string;
  prNumber: number;
  /** Credential overrides chosen by `resolveInferenceEnv`. */
  inferenceEnv: Record<string, string>;
  publishUrl: string;
  publishToken: string;
  ghToken?: string;
  /** Reviewer comprehension quiz mode; omitted = the CLI's default. */
  quiz?: "off" | "auto" | "on";
  /** Maximum simultaneous file reviews; omitted = the CLI's default. */
  concurrency?: number;
  /** The Node binary to run the bin with. Defaults to `node` on PATH. */
  nodePath?: string;
  /** When set, the CLI writes a machine-readable outcome JSON here. */
  summaryPath?: string;
}

export async function runReview(input: RunReviewInput): Promise<number> {
  const cliPath = join(input.smithersRoot, "apps", "review", "bin", "smithers-review.mjs");
  const args = [cliPath, input.workspace, "--pr", String(input.prNumber), "--publish"];
  if (input.quiz) args.push("--quiz", input.quiz);
  if (input.concurrency !== undefined) args.push("--concurrency", String(input.concurrency));

  return new Promise<number>((resolve, reject) => {
    // cwd must be the smithers checkout, never the workspace: the bin resolves
    // its workspace dependencies relative to cwd, and the caller's checkout has
    // none of them installed. The workspace is passed as the CLI's positional
    // repo argument instead.
    const child = spawn(input.nodePath ?? "node", args, {
      cwd: input.smithersRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        ...input.inferenceEnv,
        SMITHERS_REVIEW_PUBLISH_URL: input.publishUrl,
        SMITHERS_REVIEW_PUBLISH_TOKEN: input.publishToken,
        GH_TOKEN: input.ghToken ?? process.env.GH_TOKEN ?? "",
        ...(input.summaryPath ? { SMITHERS_REVIEW_SUMMARY_PATH: input.summaryPath } : {}),
      },
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
