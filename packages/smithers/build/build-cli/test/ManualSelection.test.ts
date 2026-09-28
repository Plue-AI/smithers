/**
 * Manual targets: a bare wildcard skips them, a label or a named subtree
 * pattern selects them. `S.SecurityReview`'s full audit is the real case.
 *
 * @since 1.0.0
 */
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"

let root: string
let index: PackageIndex

beforeAll(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-manual-selection-")))
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
    JSON.stringify({ name: "manual-selection-fixture", private: true, packageManager: "pnpm@11.25.0" })
  )
  await Fs.writeFile(Path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
  await Fs.mkdir(Path.join(root, "packages/a/src"), { recursive: true })
  await Fs.writeFile(Path.join(root, "packages/a/src/index.ts"), "export const a = 1\n")
  await Fs.writeFile(
    Path.join(root, "packages/a/PACKAGE.ts"),
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  ...S.SecurityReview({ cwd: "packages/a", base: "HEAD", checks: [] })
} })
`
  )
  const git = (...args: ReadonlyArray<string>) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
      {
        cwd: root
      }
    )
  git("init", "--initial-branch=main")
  git("add", ".")
  git("commit", "-m", "base")
  index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)))
})

afterAll(async () => {
  if (root !== undefined) await Fs.rm(root, { recursive: true, force: true })
})

const roots = async (pattern: string): Promise<ReadonlyArray<string>> =>
  (await PackageExec.plan({ index, cacheDirectory: ".flows", verb: "review", patterns: [pattern], plan: true })).roots

describe("manual targets", () => {
  it("are skipped by a bare wildcard", async () => {
    expect(await roots("//...")).toEqual(["//packages/a:security"])
    expect(await roots("//packages/...")).toEqual(["//packages/a:security"])
  })

  it("are selected by a named subtree pattern", async () => {
    expect(await roots("//packages/...:securityAudit")).toEqual(["//packages/a:securityAudit"])
  })

  it("are selected by label", async () => {
    expect(await roots("//packages/a:securityAudit")).toEqual(["//packages/a:securityAudit"])
  })
})
