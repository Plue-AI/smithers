/** Cheap landing checks, selected from committed and working-tree changes. */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { isMain, repoRoot } from "./workspace-packages.mjs"

export const changedPaths = (root, base) => [...new Set([
  ...execFileSync("git", ["diff", "--name-only", "-z", base], { cwd: root }).toString().split("\0"),
  ...execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root }).toString().split("\0")
].filter(Boolean))]

export const formatGroups = (root, paths) => {
  const groups = new Map()
  for (const path of paths) {
    if (!existsSync(join(root, path))) continue
    let directory = dirname(join(root, path))
    while (!existsSync(join(directory, "dprint.json")) && directory !== root) directory = dirname(directory)
    if (!existsSync(join(directory, "dprint.json"))) continue
    const files = groups.get(directory) ?? []
    files.push(resolve(root, path))
    groups.set(directory, files)
  }
  return groups
}

export const docsLabels = (root, paths) => {
  const index = join(root, ".smithers/target-index.json")
  if (!existsSync(index)) return []
  return JSON.parse(readFileSync(index, "utf8")).filter(row => row.rule === "Docs.Check" &&
    (paths === undefined || row.inputs.some(input => input.kind === "glob" || input.kind === "file" && paths.includes(input.path))))
    .map(row => row.label)
}

export const main = (args, root = repoRoot) => {
  const [mode, base = "origin/main"] = args
  if (mode === "format") {
    for (const [cwd, files] of formatGroups(root, changedPaths(root, base))) {
      execFileSync("pnpm", ["exec", "dprint", "check", "--config", join(cwd, "dprint.json"), ...files], { cwd, stdio: "inherit" })
    }
  } else if (mode === "docs" || mode === "docs-all") {
    for (const label of docsLabels(root, mode === "docs-all" ? undefined : changedPaths(root, base))) {
      try {
        execFileSync("pnpm", ["exec", "smthrs", "docs", label], { cwd: root, stdio: "inherit" })
      } catch (error) {
        console.error(`Review the page, then restamp: pnpm exec smthrs docs '${label}' --write`)
        throw error
      }
    }
  } else throw new Error("usage: node scripts/lane-checks.mjs format|docs|docs-all [base]")
}
if (isMain(import.meta)) main(process.argv.slice(2))
