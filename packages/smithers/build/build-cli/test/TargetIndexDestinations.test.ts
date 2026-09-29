/**
 * Network destinations and environment toolchain pins as index data: what a
 * real PACKAGE.ts declares is what the row carries, so an environment builder
 * reads hosts and digests from the graph rather than keeping its own list.
 *
 * @since 1.0.0
 */
import * as TargetIndexRule from "@smthrs/targets/TargetIndex"
import * as Schema from "effect/Schema"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import * as TargetIndex from "../src/TargetIndex.ts"

let root: string
let listing: TargetIndex.Listing

const digest = "a".repeat(64)

beforeAll(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-index-destinations-")))
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
    JSON.stringify({ name: "index-destinations-fixture", private: true, packageManager: "pnpm@11.25.0" })
  )
  await Fs.writeFile(Path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
  await Fs.mkdir(Path.join(root, "tools"), { recursive: true })
  await Fs.writeFile(Path.join(root, "tools/fetch.mjs"), "")
  await Fs.writeFile(
    Path.join(root, "tools/PACKAGE.ts"),
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  devkit: S.NodeBinary({
    entry: S.file("fetch.mjs"),
    args: [],
    srcs: [S.file("//pnpm-lock.yaml")],
    deps: [],
    destinations: ["release-assets.githubusercontent.com", "github.com", "github.com"]
  }),
  undeclared: S.NodeBinary({ entry: S.file("fetch.mjs"), args: [], srcs: [], deps: [] }),
  offline: S.NodeBinary({ entry: S.file("fetch.mjs"), args: [], srcs: [], deps: [], destinations: [] }),
  modules: S.Go.ModDownload({
    mod: S.file("//go.mod"),
    sum: S.file("//go.sum"),
    outDirs: ["//.gomod"],
    destinations: ["proxy.golang.org"]
  }),
  toolchain: S.Environment.Toolchain({
    downloads: { jq: { version: "1.7.1", url: "https://github.com/jq", sha256: "${digest}" } },
    rust: { channel: "1.98.0", components: ["clippy"], targets: [] },
    postgres: "18",
    destinations: ["github.com"]
  })
} })
`
  )
  const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)))
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

describe("declared network destinations", () => {
  it("records the declared hosts sorted and deduplicated", () => {
    expect(row("//tools:devkit").destinations).toEqual(["github.com", "release-assets.githubusercontent.com"])
    expect(row("//tools:modules").destinations).toEqual(["proxy.golang.org"])
  })

  it("keeps an undeclared list absent and a declared empty list empty", () => {
    expect(row("//tools:undeclared")).not.toHaveProperty("destinations")
    expect(row("//tools:offline").destinations).toEqual([])
  })

  it("carries an environment toolchain's pins beside its destinations", () => {
    const toolchain = row("//tools:toolchain")
    expect(toolchain.rule).toBe("Environment.Toolchain")
    expect(toolchain.kinds).toEqual([])
    expect(toolchain.destinations).toEqual(["github.com"])
    expect(toolchain.toolchain).toEqual({
      downloads: { jq: { version: "1.7.1", url: "https://github.com/jq", sha256: digest } },
      rust: { channel: "1.98.0", components: ["clippy"], targets: [] },
      postgres: "18"
    })
    expect(row("//tools:devkit")).not.toHaveProperty("toolchain")
  })

  it("writes rows the checked-in index schema accepts", () => {
    const decode = Schema.decodeUnknownSync(Schema.Array(TargetIndexRule.Row))
    expect(decode(JSON.parse(TargetIndexRule.render(listing.targets)))).toHaveLength(listing.targets.length)
  })
})
