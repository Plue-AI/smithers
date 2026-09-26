/**
 * Execution verbs take several target patterns and run their union once.
 *
 * @since 0.1.0
 */
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

let root: string

beforeAll(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-multi-pattern-")))
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`
  )
  for (const name of ["a", "b", "c"]) {
    await write(
      root,
      `packages/${name}/PACKAGE.ts`,
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  unit: S.Shell.Test({ shell: "true" }),
  fmt: S.Shell.Diff({ shell: "true", changes: ["out.txt"] })
} })
`
    )
    await write(root, `packages/${name}/out.txt`, "a")
  }
  await write(
    root,
    "packages/x/PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  named: S.Suite({ tests: [S.FaultSuite({ cwd: "packages/x", config: null })] })
} })
`
  )
  const git = (...args: ReadonlyArray<string>) => NodeChildProcess.execFileSync("git", ["-C", root, ...args])
  git("init", "-q")
  git("add", "-A")
  git("-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
})

afterAll(async () => {
  if (root !== undefined) await Fs.rm(root, { recursive: true, force: true })
})

interface Summary {
  readonly ok: boolean
  readonly pattern: string
  readonly results: ReadonlyArray<{ readonly label: string; readonly status: string }>
}

const execute = async (args: ReadonlyArray<string>): Promise<Summary> => {
  const { exitCode, output, logs } = await serve(root, [...args, "--format", "json"])
  expect(exitCode, `${output}\n${logs}`).toBe(0)
  return JSON.parse(output) as Summary
}

describe("multiple patterns", () => {
  it.each([
    ["lint", "fmt"],
    ["test", "unit"]
  ])("%s runs the union of every pattern", async (verb, target) => {
    const summary = await execute([verb, "//packages/a/...", "//packages/b/..."])
    expect(summary.ok).toBe(true)
    expect(summary.pattern).toBe("//packages/a/... //packages/b/...")
    expect(summary.results.map((result) => result.label).sort()).toEqual([
      `//packages/a:${target}`,
      `//packages/b:${target}`
    ])
  })

  it("plans ci over the union of every pattern", async () => {
    const { exitCode, output } = await serve(root, [
      "ci",
      "//packages/a/...",
      "//packages/c/...",
      "--plan",
      "--format",
      "json"
    ])
    expect(exitCode, output).toBe(0)
    expect([...(JSON.parse(output) as { readonly roots: ReadonlyArray<string> }).roots].sort()).toEqual([
      "//packages/a:fmt",
      "//packages/a:unit",
      "//packages/c:fmt",
      "//packages/c:unit"
    ])
  })

  it("runs a target two patterns select once", async () => {
    const summary = await execute(["test", "//packages/a/...", "//packages/a:unit", "//packages/c:unit"])
    expect(summary.results.map((result) => result.label).sort()).toEqual([
      "//packages/a:unit",
      "//packages/c:unit"
    ])
  })

  it("keeps a named root's exclusive dependency beside an unrelated wildcard", async () => {
    const plan = await serve(root, ["test", "//packages/x:named", "//packages/a/...", "--plan", "--format", "json"])
    expect(plan.exitCode, `${plan.output}\n${plan.logs}`).toBe(0)
    expect([...(JSON.parse(plan.output) as { readonly roots: ReadonlyArray<string> }).roots].sort()).toEqual([
      "//packages/a:unit",
      "//packages/x:named"
    ])
  })

  it("refuses a wildcard that reaches an exclusive dependency", async () => {
    const { exitCode, output, logs } = await serve(root, ["test", "//packages/x/...", "//packages/a/...", "--plan"])
    expect(exitCode).toBe(1)
    expect(`${output}${logs}`).toContain("wildcard selection reaches exclusive dependency")
  })

  it("refuses the whole invocation when any named pattern does not take the verb", async () => {
    const { exitCode, output, logs } = await serve(root, ["lint", "//packages/a/...", "//packages/b:unit"])
    expect(exitCode).toBe(1)
    expect(`${output}${logs}`).toContain("//packages/b:unit")
  })
})
