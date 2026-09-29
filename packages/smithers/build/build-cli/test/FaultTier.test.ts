/**
 * Fault tier selection from real package declarations and process scheduling.
 *
 * @since 0.1.0
 */
import { execFile } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"
import * as Executor from "../src/Executor.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { serve } from "./helpers/ServeCli.ts"

const executeFile = promisify(execFile)
let root: string
let index: PackageIndex

beforeAll(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-fault-tier-")))
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
    JSON.stringify({ name: "fault-tier-fixture", private: true, packageManager: "pnpm@11.25.0" })
  )
  await Fs.writeFile(Path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
  for (const name of ["a", "b"]) {
    const cwd = `packages/${name}`
    await Fs.mkdir(Path.join(root, cwd), { recursive: true })
    await Fs.writeFile(
      Path.join(root, cwd, "PACKAGE.ts"),
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  unit: S.Shell.Test({ shell: "node --version" }),
  faults: S.FaultSuite({ cwd: "${cwd}", config: null }),
  chaos: S.FaultSuite({ cwd: "${cwd}", config: null })
} })
`
    )
  }
  index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)))
})

afterAll(async () => {
  if (root !== undefined) await Fs.rm(root, { recursive: true, force: true })
})

const plan = (pattern: string): Promise<PackageExec.PackagePlan> =>
  PackageExec.plan({ index, cacheDirectory: ".flows", verb: "test", patterns: [pattern], plan: true })

const cliPlan = async (verb: string, pattern: string, ...flags: ReadonlyArray<string>) => {
  let output = ""
  let exitCode = 0
  await makeCli().serve([verb, pattern, "--plan", "--format", "json", "--workspace", root, ...flags], {
    stdout: (text) => {
      output += text
    },
    exit: (code) => {
      exitCode = code
    }
  })
  expect(exitCode, output).toBe(0)
  return JSON.parse(output) as { readonly roots: ReadonlyArray<string> }
}

describe("fault tier", () => {
  it.each(["ci", "test"])("%s excludes exclusive targets from both wildcard forms", async (verb) => {
    for (const pattern of ["//...", "//packages/..."]) {
      expect((await cliPlan(verb, pattern)).roots).toEqual(["//packages/a:unit", "//packages/b:unit"])
    }
  })

  it.each(["ci", "test"])("%s includes an explicit fault matrix and exact fault label", async (verb) => {
    expect((await cliPlan(verb, "//packages/...:faults")).roots).toEqual([
      "//packages/a:faults",
      "//packages/b:faults"
    ])
    expect((await cliPlan(verb, "//packages/a:chaos")).roots).toEqual(["//packages/a:chaos"])
  })

  it.each(["ci", "test"])("%s can opt wildcard selections into exclusive targets", async (verb) => {
    const selected = await cliPlan(verb, "//packages/...", "--include-exclusive")
    expect(selected.roots).toHaveLength(6)
    expect(selected.roots).toContain("//packages/a:chaos")
    expect(selected.roots).toContain("//packages/b:faults")
  })

  it.each(["ci", "test"])("%s watch preserves wildcard exclusive opt-in in its real child", async (verb) => {
    const direct = await cliPlan(verb, "//...", "--include-exclusive")
    expect(direct.roots).toContain("//packages/a:faults")

    const watched = async (pattern: string, ...flags: ReadonlyArray<string>) => {
      const result = await serve(root, ["watch", verb, pattern, "--once", "--plan", "--audience", "human", ...flags])
      expect(result.exitCode, result.logs).toBe(0)
      expect(result.logs).toContain("Watch cycle 1 complete")
      return result.logs
    }

    expect(await watched("//packages/a:faults")).toContain("//packages/a:faults")
    const wildcard = await watched("//...", "--include-exclusive")
    for (const label of direct.roots) expect(wildcard).toContain(label)
  })

  it("merges explicit faults with wildcard work and runs their real processes alone after ordinary work", async () => {
    const plans = await Promise.all([plan("//packages/...:faults"), plan("//packages/...")])
    const merged = Executor.mergePlans(plans.map((selected) => ({
      verb: "test" as const,
      pattern: "//packages/...",
      roots: selected.roots,
      targets: selected.workList,
      edges: [],
      warnings: []
    })))
    const running = new Set<string>()
    const started: Array<string> = []
    const overlaps: Array<string> = []
    await Executor.schedule(merged.targets, 4, async (label) => {
      if (label.endsWith(":faults") ? running.size > 0 : [...running].some((entry) => entry.endsWith(":faults"))) {
        overlaps.push(label)
      }
      running.add(label)
      started.push(label)
      try {
        await executeFile(process.execPath, [
          "-e",
          `
const fs = require("node:fs")
fs.writeFileSync(process.argv[1], String(process.pid))
`,
          Path.join(root, label.replaceAll(/[/:]/g, "_"))
        ])
      } finally {
        running.delete(label)
      }
    })
    expect(overlaps).toEqual([])
    expect(started).toEqual([
      "//packages/a:unit",
      "//packages/b:unit",
      "//packages/a:faults",
      "//packages/b:faults"
    ])
    for (const label of started) {
      expect(await Fs.readFile(Path.join(root, label.replaceAll(/[/:]/g, "_")), "utf8")).toMatch(/^\d+$/)
    }
  })

  it("refuses a wildcard dependency that would silently reintroduce an exclusive target", async () => {
    const directory = Path.join(root, "packages/implicit")
    await Fs.mkdir(directory)
    await Fs.writeFile(
      Path.join(directory, "PACKAGE.ts"),
      `import { Smithers as S } from "@smthrs/targets"
const faults = S.FaultSuite({ cwd: "packages/implicit", config: null })
export const Package = S.Package({ targets: { all: S.Suite({ tests: [faults] }) } })
`
    )
    try {
      const withDependency = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)))
      const options = {
        index: withDependency,
        cacheDirectory: ".flows",
        verb: "test" as const,
        patterns: ["//packages/..."],
        plan: true
      }
      await expect(PackageExec.plan(options)).rejects.toThrow(/exclusive.*--include-exclusive/)
      const optedIn = await PackageExec.plan({ ...options, includeExclusive: true })
      expect(optedIn.roots).toContain("//packages/implicit:all")
    } finally {
      await Fs.rm(directory, { recursive: true, force: true })
    }
  })
})
