/** Enumerate concrete cross-package inputs: globs cannot cross PACKAGE.ts boundaries. */
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { repoRoot, workspacePackages } from "../../../scripts/workspace-packages.mjs"
export const walk = (dir) =>
  !existsSync(dir)
    ? []
    : readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) =>
      entry.name === "__pycache__" ? [] : entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]
    )
/**
 * The tracked files under `dir`, absolute and sorted. Declared input rows take
 * their membership from the repository's file index, never a directory walk,
 * so an untracked stray in a dirty checkout cannot enter a row.
 */
export const tracked = (dir) =>
  !existsSync(dir)
    ? []
    : execFileSync("git", ["ls-files", "-z", "--", dir], { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 28 })
      .split("\0")
      .filter((file) => file !== "" && !file.split("/").includes("__pycache__"))
      .map((file) => join(repoRoot, file))
      .filter((file) => existsSync(file))
      .sort((a, b) => a.localeCompare(b))
export function runtimeInputs() {
  const packages = new Map(workspacePackages().map((pkg) => [pkg.name, pkg])), seen = new Set(), files = []
  const visit = (name) => {
    if (seen.has(name)) return
    const pkg = packages.get(name)
    if (!pkg) return
    seen.add(name)
    files.push(join(repoRoot, pkg.dir, "package.json"), ...tracked(join(repoRoot, pkg.dir, "src")))
    if (name === "@smthrs/cli") files.push(...tracked(join(repoRoot, pkg.dir, "vendor/opentui-native")))
    for (const dependency of Object.keys(pkg.manifest.dependencies ?? {})) visit(dependency)
  }
  visit("smithers-tui")
  visit("@smithers/tui-docs")
  return [...new Set(files)].map((file) => file.slice(repoRoot.length + 1)).sort()
}
