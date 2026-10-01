import { spawnSync } from "node:child_process"
import { cp, mkdir, rm, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"

/** Install the packed release closure with relocatable installation receipts. */
export async function installCLI(packages, staging, destination) {
  // Both directories share a unique temporary parent. Their relative paths
  // remain identical across builds without sharing a mutable staging area.
  const installation = join(staging, "installed")
  const dependencies = {}, overrides = {}
  for (const { name, archive } of packages) {
    dependencies[name] = `file:${relative(installation, archive)}`
    overrides[name] = `$${name}`
  }
  await mkdir(installation, { recursive: true })
  await writeFile(join(installation, "package.json"), JSON.stringify({ private: true, dependencies, overrides }))
  const result = spawnSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: installation, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`npm install failed (${result.status ?? result.signal})`)
  // Publish only after installation succeeds; never retain stale packages or
  // executable files from an earlier output tree.
  await rm(destination, { recursive: true, force: true })
  await cp(installation, destination, { recursive: true, verbatimSymlinks: true })
}
