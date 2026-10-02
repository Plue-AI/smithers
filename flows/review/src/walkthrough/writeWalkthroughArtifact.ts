import { randomUUID } from "node:crypto";
import { walkthroughArtifactsDir } from "./walkthroughArtifactsDir.ts";
import { io, runIo } from "../io.ts";
import { join, relative, resolve } from "node:path";

/** Reject symlink parents even when a permissive host is used. Host guards remain authoritative. */
async function assertPlainParents(repo: string, path: string): Promise<void> {
  const fs = io().fs;
  const root = resolve(repo);
  const suffix = relative(root, resolve(path));
  if (suffix.startsWith("..")) return; // Explicit external outputs are bounded by the host.
  let current = root;
  for (const part of suffix.split("/")) {
    current = join(current, part);
    let link: string | undefined;
    try { link = await runIo(fs.readLink(current)); } catch { /* Ordinary files and missing parents are not links. */ }
    if (link !== undefined) throw new Error(`Refusing symbolic link: ${current}`);
  }
}
/** Retain each run's artifact and atomically replace output through host filesystem guards. */
export async function writeWalkthroughArtifact(_repoDir: string, outPath: string, html: string): Promise<string> {
  const fs = io().fs;
  const artifacts = walkthroughArtifactsDir(outPath);
  await assertPlainParents(_repoDir, artifacts);
  await assertPlainParents(_repoDir, outPath);
  await runIo(fs.makeDirectory(artifacts, { recursive: true }));
  const artifactPath = join(artifacts, `${randomUUID()}.html`);
  const artifactTemporary = `${artifactPath}.tmp`;
  const temporary = `${outPath}.${randomUUID()}.tmp`;
  try {
    await runIo(fs.writeFileString(artifactTemporary, html, { flag: "wx" }));
    await runIo(fs.rename(artifactTemporary, artifactPath));
    await runIo(fs.writeFileString(temporary, html, { flag: "wx" }));
    await runIo(fs.rename(temporary, outPath));
  } finally {
    await runIo(fs.remove(artifactTemporary, { force: true }));
    await runIo(fs.remove(temporary, { force: true }));
  }
  return artifactPath;
}
