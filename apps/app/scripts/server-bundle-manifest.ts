import { createHash } from "node:crypto"
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"

// Flow-host manifests cover hosts only; the install needs every shipped byte.
export interface BundleManifest {
  version: 1
  platform: "darwin-arm64"
  revision: string
  files: Array<{ path: string; sha256: string; stage: string; mode: number; symlink?: string }>
}
const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex")
type Inventory = Record<string, Omit<BundleManifest["files"][number], "path">>
const inventory = (root: string): Inventory => {
  const files: Inventory = {}
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const key = relative(root, path).split(sep).join("/")
      if (key === "manifest.json") continue
      const stat = lstatSync(path)
      if (stat.isDirectory()) { visit(path); continue }
      const stage = key.startsWith("postgres/") ? "postgresql18"
        : key.startsWith("views/mainview/") ? "web"
        : key.startsWith("share/microsandbox/") || key === "bin/msb" || key.startsWith("lib/") ? "microsandbox"
        : key.includes("git") ? "git" : key.includes("jj") ? "jj"
        : key.includes("smithers_ffi") ? "native-ffi"
        : key.includes("smithers-coding-host") ? "coding-host"
        : key.includes("smithers-model-host") ? "model-host"
        : key === "bin/node" || key === "licenses/node-LICENSE" ? "node-runtime"
        : key === "README.md" ? "instructions"
        : key === "bin/smithers-server" || key === "bin/smthrs" ? "launcher"
        : key === "bin/smithers-backend" ? "backend" : "host"
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path)
        const resolved = realpathSync(path)
        if (!resolved.startsWith(realpathSync(root) + sep) || target.startsWith("/")) throw new Error(`Bundle symlink escapes: ${key}`)
        files[key] = { sha256: digest(readFileSync(path)), stage, mode: stat.mode & 0o777, symlink: target }
      } else if (stat.isFile()) {
        files[key] = { sha256: digest(readFileSync(path)), stage, mode: stat.mode & 0o777 }
      } else throw new Error(`Unsupported bundle file: ${key}`)
    }
  }
  visit(root)
  return files
}
export const writeBundleManifest = (root: string, revision: string): void => {
  const manifest: BundleManifest = { version: 1, platform: "darwin-arm64", revision, files: Object.entries(inventory(root)).map(([path, entry]) => ({ path, ...entry })) }
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
}
export const verifyBundleManifest = (root: string): void => {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as BundleManifest
  if (manifest.version !== 1 || manifest.platform !== "darwin-arm64" || !/^[0-9a-f]{40,64}$/.test(manifest.revision)) throw new Error("Invalid bundle manifest")
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("Invalid bundle manifest files")
  const expectedFiles = Object.fromEntries(manifest.files.map(({ path, ...entry }) => [path, entry]))
  if (Object.keys(expectedFiles).length !== manifest.files.length) throw new Error("Duplicate bundle manifest path")
  const actual = inventory(root)
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(expectedFiles).sort())) throw new Error("Bundle manifest file inventory mismatch")
  for (const [path, entry] of Object.entries(actual)) {
    const expected = expectedFiles[path]
    if (entry.sha256 !== expected.sha256 || entry.mode !== expected.mode || entry.symlink !== expected.symlink || entry.stage !== expected.stage) throw new Error(`Bundle manifest mismatch: ${path}`)
  }
}
if (import.meta.main) verifyBundleManifest(resolve(process.argv[2] ?? "."))
