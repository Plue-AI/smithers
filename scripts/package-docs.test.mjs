import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { libraryPackages, repoRoot } from "./workspace-packages.mjs"

const pack = promisify(execFile)
const packages = libraryPackages().filter(({ manifest }) => !manifest.private)
let count = 0
const check = async ({ dir }) => {
  const { stdout } = await pack("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--workspaces=false", "--offline"], { cwd: join(repoRoot, dir), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  const files = JSON.parse(stdout)[0].files.map(({ path }) => path)
  assert.ok(files.includes("README.md"), `${dir}: README.md missing from tarball`)
  if (existsSync(join(repoRoot, dir, "docs"))) assert.ok(files.some((path) => path.startsWith("docs/")), `${dir}: docs/ missing from tarball`)
  console.log(`PASS ${dir}`)
  count++
}
// Bound concurrent pack processes; every tarball still receives the same checks.
for (let offset = 0; offset < packages.length; offset += 4) {
  const results = await Promise.allSettled(packages.slice(offset, offset + 4).map(check))
  for (const result of results) if (result.status === "rejected") throw result.reason
}
console.log(`${count} published package tarballs passed`)
