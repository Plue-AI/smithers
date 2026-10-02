import { runCommand } from "./runCommand.ts";

/**
 * Runs one `git` command in `repoDir` with unquoted paths, returning stdout and
 * throwing on a non-zero exit.
 */
export async function runGit(repoDir: string, args: string[], timeoutMs = 120_000) {
  const result = await runCommand("git", ["-c", "core.quotepath=false", ...args], repoDir, timeoutMs);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}
