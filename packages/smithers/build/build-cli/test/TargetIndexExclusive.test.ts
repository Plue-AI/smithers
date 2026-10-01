/**
 * The exclusive tier as index data: a `NodeTest`, `Shell.Test` or `Vitest`
 * declaration that sets `exclusive: true` is the target a wildcard `test` or
 * `ci` selection omits, and its index row says so, so a caller that picks
 * labels from `index --format json` applies the same tier the planner does.
 *
 * @since 1.0.0
 */
import * as TargetIndexRule from "@smthrs/targets/TargetIndex"
import * as Schema from "effect/Schema"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { wildcardOmits } from "../src/internal/PackagePlanner.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import * as TargetIndex from "../src/TargetIndex.ts"

let root: string
let index: PackageIndex
let listing: TargetIndex.Listing

beforeAll(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-index-exclusive-")))
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
    JSON.stringify({ name: "index-exclusive-fixture", private: true, packageManager: "pnpm@11.25.0" })
  )
  await Fs.writeFile(Path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
  await Fs.mkdir(Path.join(root, "app/e2e"), { recursive: true })
  await Fs.writeFile(Path.join(root, "app/run-e2e.mjs"), "")
  await Fs.writeFile(
    Path.join(root, "app/PACKAGE.ts"),
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  unit: S.NodeTest({ runner: S.testSuite(["src"]), srcs: [S.glob("src/**/*")], deps: [], cwd: "app" }),
  browser: S.NodeTest({
    runner: S.entrypoint(S.file("run-e2e.mjs")),
    srcs: [S.glob("e2e/**/*")],
    deps: [],
    exclusive: true,
    cwd: "app"
  }),
  declaredOrdinary: S.NodeTest({ runner: S.testSuite(["src"]), srcs: [], deps: [], exclusive: false, cwd: "app" }),
  shellE2e: S.Shell.Test({ shell: "true", exclusive: true }),
  shellUnit: S.Shell.Test({ shell: "true" })
} })
`
  )
  index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)))
  listing = await TargetIndex.build(index, "//...", {})
})

afterAll(async () => {
  if (root !== undefined) await Fs.rm(root, { recursive: true, force: true })
})

const row = (label: string): TargetIndex.Row => {
  const found = listing.targets.find((entry) => entry.label === label)
  if (found === undefined) throw new Error(`no row ${label}`)
  return found
}

const target = (label: string) => {
  const found = index.resolve(label)[0]
  if (found === undefined) throw new Error(`no target ${label}`)
  return found.target
}

describe("exclusive tier in the index", () => {
  it("marks a NodeTest or Shell.Test declared exclusive", () => {
    expect(row("//app:browser").exclusive).toBe(true)
    expect(row("//app:shellE2e").exclusive).toBe(true)
  })

  it("leaves the field absent on ordinary targets, including an explicit false", () => {
    for (const label of ["//app:unit", "//app:declaredOrdinary", "//app:shellUnit"]) {
      expect(row(label)).not.toHaveProperty("exclusive")
    }
  })

  it("keeps the declared inputs beside the flag", () => {
    expect(row("//app:browser").inputs).toContainEqual({ kind: "glob", pattern: "app/e2e/**/*", exclude: [] })
  })

  it("is the tier wildcard test and ci selections omit unless opted in", () => {
    for (const label of ["//app:browser", "//app:shellE2e"]) {
      expect(wildcardOmits(target(label), { verb: "test", platform: process.platform })).toBe(true)
      expect(wildcardOmits(target(label), { verb: "ci", unattended: true, platform: process.platform })).toBe(true)
      expect(wildcardOmits(target(label), { verb: "test", includeExclusive: true, platform: process.platform }))
        .toBe(false)
    }
    for (const label of ["//app:unit", "//app:declaredOrdinary", "//app:shellUnit"]) {
      expect(wildcardOmits(target(label), { verb: "test", platform: process.platform })).toBe(false)
    }
  })

  it("writes rows the checked-in index schema accepts", () => {
    const decode = Schema.decodeUnknownSync(Schema.Array(TargetIndexRule.Row))
    const decoded = decode(JSON.parse(TargetIndexRule.render(listing.targets)))
    expect(decoded.find((entry) => entry.label === "//app:browser")?.exclusive).toBe(true)
  })
})
