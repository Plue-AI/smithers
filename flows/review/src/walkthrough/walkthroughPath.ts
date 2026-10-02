import { isAbsolute, join, resolve } from "node:path";

/**
 * Where a run writes its walkthrough: `--out` resolved against the
 * repository, or `<repo>/.smithers-review/walkthrough.html` when none is given.
 */
export function walkthroughPath(repoDir: string, out: string): string {
  const requested = out.trim();
  if (!requested) return join(repoDir, ".smithers-review", "walkthrough.html");
  return isAbsolute(requested) ? requested : resolve(repoDir, requested);
}
