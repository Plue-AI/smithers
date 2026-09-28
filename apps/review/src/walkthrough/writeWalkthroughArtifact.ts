import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { walkthroughArtifactsDir } from "./walkthroughArtifactsDir.ts";

function atomicWrite(path: string, html: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, html, { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Throws when a directory between `repoDir` and `dir` is a symbolic link. The
 * reviewed checkout is untrusted: a committed `.smithers-review` symlink would
 * otherwise redirect the default output anywhere on the machine. Directories
 * outside the repository come from the operator's `--out` and are not checked.
 */
function refuseSymlinkedDirs(repoDir: string, dir: string): void {
  const rel = relative(repoDir, dir);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
  let current = repoDir;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`refusing to write through symbolic link ${current} in the reviewed repository`);
    }
  }
}

/**
 * Retains a unique artifact for this render and atomically replaces the public
 * output. A durable replay returns the recorded artifact path; another render
 * gets a new one, so publication never reads another run's public output.
 * Refuses to follow a symbolic link inside `repoDir` toward either file.
 */
export function writeWalkthroughArtifact(repoDir: string, outPath: string, html: string): string {
  const artifacts = walkthroughArtifactsDir(outPath);
  refuseSymlinkedDirs(repoDir, artifacts);
  mkdirSync(artifacts, { recursive: true });
  const artifactPath = join(artifacts, `${randomUUID()}.html`);
  atomicWrite(artifactPath, html);
  atomicWrite(outPath, html);
  return artifactPath;
}
