/** Enumerate concrete cross-package inputs: globs cannot cross PACKAGE.ts boundaries. */
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { repoRoot, workspacePackages } from "../../../scripts/workspace-packages.mjs"
export const walk = (dir) =>
  !existsSync(dir)
    ? []
    : readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) =>
      entry.name === "__pycache__" ? [] : entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]
    )
export function runtimeInputs() {
  const packages = new Map(workspacePackages().map((pkg) => [pkg.name, pkg])), seen = new Set(), files = []
  const visit = (name) => {
    if (seen.has(name)) return
    const pkg = packages.get(name)
    if (!pkg) return
    seen.add(name)
    files.push(join(repoRoot, pkg.dir, "package.json"), ...walk(join(repoRoot, pkg.dir, "src")))
    if (name === "@smthrs/cli") files.push(...walk(join(repoRoot, pkg.dir, "vendor/opentui-native")))
    for (const dependency of Object.keys(pkg.manifest.dependencies ?? {})) visit(dependency)
  }
  visit("smithers-tui")
  visit("@smithers/tui-docs")
  return [...new Set(files)].map((file) => file.slice(repoRoot.length + 1)).sort()
}
