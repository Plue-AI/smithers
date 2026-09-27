/**
 * Targets that declare `hosts` from real package declarations: the
 * declaration is the same on every host, and the planner decides per host.
 *
 * @since 1.0.0
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import * as TargetIndex from "../src/TargetIndex.ts"

let root: string
let index: PackageIndex

beforeAll(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-platform-selection-")))
  await Fs.writeFile(
    Path.join(root, "WORKSPACE.ts"),
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Pnpm({ manifest: packageJson, lockfile: S.file("//pnpm-lock.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson })
})
`
  )
  await Fs.writeFile(
    Path.join(root, "package.json"),
    JSON.stringify({ name: "platform-selection-fixture", private: true, packageManager: "pnpm@11.25.0" })
  )
  await Fs.writeFile(Path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
  await Fs.mkdir(Path.join(root, "packages/a"), { recursive: true })
  await Fs.writeFile(
    Path.join(root, "packages/a/PACKAGE.ts"),
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  unit: S.Shell.Test({ shell: "true" }),
  linuxOnly: S.Shell.Test({ shell: "true", hosts: ["linux"] })
} })
`
  )
  index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)))
})

afterAll(async () => {
  if (root !== undefined) await Fs.rm(root, { recursive: true, force: true })
})

const plan = (pattern: string, platform: NodeJS.Platform): Promise<PackageExec.PackagePlan> =>
  PackageExec.plan({ index, cacheDirectory: ".flows", verb: "test", patterns: [pattern], plan: true, platform })

describe("declared platforms", () => {
  it("records the constraint in the index, not the host's answer", async () => {
    const listing = await TargetIndex.build(index, "//...", {})
    expect(listing.targets.find((row) => row.label === "//packages/a:linuxOnly")?.hosts).toEqual(["linux"])
    expect(listing.targets.find((row) => row.label === "//packages/a:unit")).not.toHaveProperty("hosts")
  })

  it("keeps the target in a wildcard selection on a declared platform", async () => {
    expect((await plan("//packages/a:unit", "linux")).roots).toEqual(["//packages/a:unit"])
    expect((await plan("//packages/...", "linux")).roots).toContain("//packages/a:linuxOnly")
  })

  it("omits the target from a wildcard selection on any other platform", async () => {
    const roots = (await plan("//packages/...", "darwin")).roots
    expect(roots).toEqual(["//packages/a:unit"])
  })

  it("refuses the target by name on any other platform", async () => {
    await expect(plan("//packages/a:linuxOnly", "darwin")).rejects.toThrow(
      "//packages/a:linuxOnly runs only on linux; this host is darwin"
    )
  })
})
