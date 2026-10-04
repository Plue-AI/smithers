import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { verifyBundleManifest } from "./server-bundle-manifest"

// Replace directory-only distribution; Python's streaming tar writer avoids loading the guest image into memory.
export const archiveBundle = (bundle: string, output: string): string => {
  verifyBundleManifest(bundle)
  mkdirSync(output, { recursive: true })
  const archive = join(output, "smithers-server.tar.gz")
  deterministicTar(bundle, archive, "directory")
  const sha256 = (path: string) => {
    const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024), fd = openSync(path, "r")
    try {
      for (let count; (count = readSync(fd, buffer)) > 0;) hash.update(buffer.subarray(0, count))
      return hash.digest("hex")
    } finally { closeSync(fd) }
  }
  // An archive cannot contain its own digest: the distribution manifest is beside it.
  writeFileSync(join(output, "manifest.json"), JSON.stringify({
    version: 1, files: [
      { path: "smithers-server.tar.gz", sha256: sha256(archive), stage: "archive" },
      { path: "README.md", sha256: sha256(join(bundle, "README.md")), stage: "instructions" }
    ]
  }, null, 2) + "\n")
  writeFileSync(join(output, "README.md"), readFileSync(join(bundle, "README.md")))
  return archive
}

const deterministicTar = (source: string, destination: string, kind: "tar" | "directory") => {
  const result = spawnSync("python3", [join(import.meta.dir, "deterministic-tar.py"), source, destination, kind], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`Bundle archive failed: ${result.stderr || result.error?.message}`)
}

// OCI blobs are pinned, but skopeo's outer tar headers carry wall-clock times.
export const normalizeImageArchive = (path: string): void => {
  deterministicTar(path, path + ".normalized", "tar")
  renameSync(path + ".normalized", path)
}
