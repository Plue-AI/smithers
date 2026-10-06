import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { libraryPackages, repoRoot } from "./workspace-packages.mjs"

let count = 0
for (const { dir, manifest } of libraryPackages()) {
  if (manifest.private) continue
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--workspaces=false", "--offline"], { cwd: join(repoRoot, dir), encoding: "utf8" })
  assert.equal(result.status, 0, `${dir}: ${result.stderr}`)
  const files = JSON.parse(result.stdout)[0].files.map(({ path }) => path)
  assert.ok(files.includes("README.md"), `${dir}: README.md missing from tarball`)
  if (existsSync(join(repoRoot, dir, "docs"))) assert.ok(files.some((path) => path.startsWith("docs/")), `${dir}: docs/ missing from tarball`)
  console.log(`PASS ${dir}`)
  count++
}
console.log(`${count} published package tarballs passed`)
