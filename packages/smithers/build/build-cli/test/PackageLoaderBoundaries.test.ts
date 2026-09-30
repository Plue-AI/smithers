import * as Target from "@smthrs/targets/Target"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const workspace = `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson })
})
`

const validPackage = `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {} })
`

const fixture = async (packageSource: string = validPackage): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-loader-boundaries-")))
  roots.push(root)
  await write(root, "WORKSPACE.ts", workspace)
  await write(root, "PACKAGE.ts", packageSource)
  return root
}

const loaded = async (root: string): Promise<PackageLoader.LoadedGraph> =>
  PackageLoader.load(await PackageDiscovery.discover(root))

describe("PackageLoader export and source boundaries", () => {
  it("loads a regular package beside an ordinary helper export", async () => {
    const root = await fixture(`${validPackage}export const description = "benign"\n`)
    const graph = await loaded(root)
    expect(graph.packages).toMatchObject([{ file: "PACKAGE.ts", packagePath: "" }])
    expect(graph.factory).toBeUndefined()
    expect(graph.workspace.name).toBe("fixture")
  })

  it.each(
    [
      ["wrong name", `${validPackage.replace("export const Package", "export const Other")}`, "invalid_package_export"],
      ["wrong value", "export const Package = 42\n", "invalid_package_export"],
      ["missing value", "export const help = 42\n", "package_export_missing"]
    ] as const
  )("rejects a %s package export", async (_name, source, code) => {
    const root = await fixture(source)
    await expect(loaded(root)).rejects.toMatchObject({ code, path: "PACKAGE.ts" })
  })

  it("ignores import spellings inside comments, strings, regexes, and templates", async () => {
    const root = await fixture(`${validPackage}
// import "./WORKSPACE.js"
/* import "../outside.ts" */
export const text = 'import "./WORKSPACE.js"'
export const template = \`import "./WORKSPACE.js"\`
export const regex = /import "\\.\\/WORKSPACE\\.js"/
`)
    const graph = await loaded(root)
    expect(graph.packages.map((row) => row.file)).toEqual(["PACKAGE.ts"])
  })

  it("reports a workspace-escaping import with the declaring package path", async () => {
    const root = await fixture(`import "../outside.ts"\n${validPackage}`)
    await expect(loaded(root)).rejects.toMatchObject({
      code: "module_outside_workspace",
      path: "PACKAGE.ts"
    })
  })

  it.each([
    "import \"./WORKSPACE.js\"",
    "export { Workspace } from \"./WORKSPACE.js\""
  ])("rejects the one-way workspace dependency written as %s", async (statement) => {
    const root = await fixture(`${statement}\n${validPackage}`)
    await expect(loaded(root)).rejects.toMatchObject({
      code: "unsupported_module_specifier",
      path: "PACKAGE.ts"
    })
  })

  it("scans a .mts helper through its NodeNext .mjs specifier", async () => {
    const root = await fixture(`import { Smithers as S } from "@smthrs/targets"
import { command } from "./helper.mjs"
export const Package = S.Package({ targets: { run: S.Shell.Run({ shell: command }) } })
`)
    await write(root, "helper.mts", "export const command = \"echo helper\"\n")
    const first = await loaded(root)
    expect(Target.metadata(first.packages[0]!.value["run"]!).attrs).toMatchObject({ shell: "echo helper" })
    await write(root, "helper.mts", "export const command = \"echo revised\"\n")
    const next = await loaded(root)
    expect(next).not.toBe(first)
    expect(Target.metadata(next.packages[0]!.value["run"]!).attrs).toMatchObject({ shell: "echo revised" })
  })

  it.each([
    ["plain", "./helper.ts"],
    ["unicode", "./\\u0068elper.ts"],
    ["code point", "./\\u{68}elper.ts"],
    ["hex", "./\\x68elper.ts"],
    ["identity", "./\\helper.ts"],
    ["line continuation", "./h\\\nelper.ts"]
  ])("rekeys the graph after editing a helper imported with a %s specifier", async (_name, specifier) => {
    const root = await fixture(`import { Smithers as S } from "@smthrs/targets"
import { command } from "${specifier}"
export const Package = S.Package({ targets: { run: S.Shell.Run({ shell: command }) } })
`)
    await write(root, "helper.ts", "export const command = \"echo first\"\n")
    const first = await loaded(root)
    expect(Target.metadata(first.packages[0]!.value["run"]!).attrs).toMatchObject({ shell: "echo first" })
    expect(await loaded(root)).toBe(first)
    await write(root, "helper.ts", "export const command = \"echo revised\"\n")
    const next = await loaded(root)
    expect(next).not.toBe(first)
    expect(Target.metadata(next.packages[0]!.value["run"]!).attrs).toMatchObject({ shell: "echo revised" })
  })

  it.each([
    ["./\\u0057ORKSPACE.js", "unsupported_module_specifier"],
    ["\\x2e./outside.ts", "module_outside_workspace"],
    ["./\\u{2e}./outside.ts", "module_outside_workspace"]
  ])("applies import boundaries to the decoded specifier %s", async (specifier, code) => {
    const root = await fixture(`import "${specifier}"\n${validPackage}`)
    await expect(loaded(root)).rejects.toMatchObject({ code, path: "PACKAGE.ts" })
  })

  it("reports a discovered package removed before its static scan", async () => {
    const root = await fixture()
    const discovery = await PackageDiscovery.discover(root)
    await Fs.rm(NodePath.join(root, "PACKAGE.ts"))
    await expect(PackageLoader.load(discovery)).rejects.toMatchObject({
      code: "module_missing",
      path: "PACKAGE.ts"
    })
  })

  it("retries a failed package load after the author fixes its export", async () => {
    const root = await fixture("export const Package = 42\n")
    await expect(loaded(root)).rejects.toMatchObject({ code: "invalid_package_export", path: "PACKAGE.ts" })
    await write(root, "PACKAGE.ts", validPackage)
    const graph = await loaded(root)
    expect(graph.packages).toMatchObject([{ file: "PACKAGE.ts", packagePath: "" }])
  })

  it("does not retain a rejected graph for the same source digest", async () => {
    const variable = "SMTHRS_LOADER_TRANSIENT_FAILURE_TEST"
    const previous = process.env[variable]
    const root = await fixture(`if (process.env.${variable} === "fail") throw new Error("transient fixture failure")
${validPackage}`)
    try {
      process.env[variable] = "fail"
      await expect(loaded(root)).rejects.toMatchObject({
        code: "module_import_failed",
        message: expect.stringContaining("transient fixture failure")
      })
      process.env[variable] = "ready"
      const graph = await loaded(root)
      expect(graph.packages.map((row) => row.file)).toEqual(["PACKAGE.ts"])
    } finally {
      if (previous === undefined) delete process.env[variable]
      else process.env[variable] = previous
    }
  })

  it("explains an unknown Smithers namespace when evaluation throws", async () => {
    const root = await fixture(`import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { x: S.NoSuch.Thing({}) } })
`)
    await expect(loaded(root)).rejects.toMatchObject({
      code: "module_import_failed",
      message: expect.stringContaining("this loader exports no such namespace")
    })
  })

  it("removes generated entry modules after successful and failed imports", async () => {
    const root = await fixture()
    const isolated = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-loader-cleanup-"))
    roots.push(isolated)
    const previous = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
    process.env.TMPDIR = isolated
    process.env.TMP = isolated
    process.env.TEMP = isolated
    try {
      expect(Os.tmpdir()).toBe(isolated)
      await loaded(root)
      expect((await Fs.readdir(isolated)).filter((name) => name.startsWith("smthrs-package-entry-")))
        .toEqual([])
      await write(root, "PACKAGE.ts", "export const Package = ;\n")
      await expect(loaded(root)).rejects.toMatchObject({ code: "module_import_failed" })
      expect((await Fs.readdir(isolated)).filter((name) => name.startsWith("smthrs-package-entry-")))
        .toEqual([])
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it("keeps the cache-directory probe forgiving and memoized per workspace key", async () => {
    const root = await fixture()
    const first = PackageLoader.probeCacheDirectory(root, "WORKSPACE.ts")
    const second = PackageLoader.probeCacheDirectory(root, "WORKSPACE.ts")
    expect(second).toBe(first)
    await expect(first).resolves.toBe(".flows")

    const bad = await fixture()
    await write(bad, "WORKSPACE.ts", "export const Workspace = ;\n")
    const failed = PackageLoader.probeCacheDirectory(bad, "WORKSPACE.ts")
    expect(PackageLoader.probeCacheDirectory(bad, "WORKSPACE.ts")).toBe(failed)
    await expect(failed).resolves.toBeUndefined()
    await expect(PackageLoader.loadWorkspaceDeclaration(bad, "WORKSPACE.ts"))
      .rejects.toMatchObject({ code: "module_import_failed", path: "WORKSPACE.ts" })
  })

  it("reuses an unchanged graph and rekeys after an adjacent .smithers module changes", async () => {
    const root = await fixture()
    await write(root, ".smithers/WORKSPACE.ts", workspace)
    await write(root, ".smithers/agents.ts", "export const revision = 1\n")
    const first = await loaded(root)
    expect(await loaded(root)).toBe(first)
    await write(root, ".smithers/agents.ts", "export const revision = 2\n")
    const next = await loaded(root)
    expect(next).not.toBe(first)
    expect(next.packages.map((row) => row.file)).toEqual(["PACKAGE.ts"])
  })
})
