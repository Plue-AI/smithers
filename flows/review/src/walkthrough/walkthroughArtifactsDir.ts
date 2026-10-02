import { dirname, join } from "node:path";

/** The directory that keeps one retained artifact per render, beside the walkthrough. */
export function walkthroughArtifactsDir(outPath: string): string {
  return join(dirname(outPath), ".smithers-review-artifacts");
}
