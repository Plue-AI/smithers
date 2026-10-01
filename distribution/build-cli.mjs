/** Install the npm CLI's release packages for the distribution and offline boxes. */
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { buildRelease } from "../scripts/build-release.mjs"
import { readWorkspaceManifests, stagePackage, workspaceDependencies } from "../scripts/pack-release.mjs"
import { repoRoot } from "../scripts/workspace-packages.mjs"
import { installCLI } from "./install-cli.mjs"

const destination = resolve(process.argv[2] ?? "/out/cli")
const manifests = readWorkspaceManifests()
const graph = workspaceDependencies(manifests)
const selected = new Map()
const visit = (directory) => {
  if (selected.has(directory)) return
  selected.set(directory, manifests.get(directory))
  for (const dependency of graph.get(directory)) visit(dependency)
}
visit("packages/smithers")
const order = buildRelease(repoRoot, selected)
const staging = await mkdtemp(join(tmpdir(), "smithers-cli-"))
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`)
}
try {
  const packages = []
  for (const [index, directory] of order.entries()) {
    const manifest = selected.get(directory)
    const staged = join(staging, String(index))
    await stagePackage(join(repoRoot, directory), staged, manifest)
    run("npm", ["pack", "--ignore-scripts", "--pack-destination", staging], staged)
    packages.push({ name: manifest.name, archive: join(staging, manifest.name.replace(/^@/, "").replaceAll("/", "-") + "-" + manifest.version + ".tgz") })
  }
  await installCLI(packages, staging, destination)
  run(process.execPath, [join(destination, "node_modules/@smthrs/cli/bin/smithers.mjs"), "issue", "list", "--help"], destination)
} finally {
  await rm(staging, { recursive: true, force: true })
}
