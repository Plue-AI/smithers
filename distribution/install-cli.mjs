import { spawnSync } from "node:child_process"
import { cp, mkdir, rm, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"

/** Install the packed release closure with relocatable installation receipts. */
export async function installCLI(packages, staging, destination, platform) {
  // Both directories share a unique temporary parent. Their relative paths
  // remain identical across builds without sharing a mutable staging area.
  const installation = join(staging, "installed")
  const dependencies = {}, overrides = {}
  for (const { name, archive } of packages) {
    dependencies[name] = `file:${relative(installation, archive)}`
    overrides[name] = `$${name}`
  }
  // Optional peers of a transitive runtime must not float past the exact
  // versions the release packages certify (for example OTel's trace SDKs).
  const selected = new Set(packages.map(pkg => pkg.name))
  for (const { peers = {} } of packages) {
    for (const [name, version] of Object.entries(peers)) {
      if (selected.has(name) || name.startsWith("@smthrs/") || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)) continue
      if (dependencies[name] !== undefined && dependencies[name] !== version) {
        throw new Error(`Conflicting release peer ${name}: ${dependencies[name]} and ${version}`)
      }
      dependencies[name] = version
    }
  }
  await mkdir(installation, { recursive: true })
  await writeFile(join(installation, "package.json"), JSON.stringify({ private: true, dependencies, overrides }))
  const result = spawnSync("npm", ["install", ...(platform ? [`--os=${platform.os}`, `--cpu=${platform.cpu}`, `--libc=${platform.libc}`] : []), "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: installation, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`npm install failed (${result.status ?? result.signal})`)
  // Publish only after installation succeeds; never retain stale packages or
  // executable files from an earlier output tree.
  await rm(destination, { recursive: true, force: true })
  await cp(installation, destination, { recursive: true, verbatimSymlinks: true })
}
