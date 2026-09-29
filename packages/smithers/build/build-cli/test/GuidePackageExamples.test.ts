import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { write } from "./helpers/WriteFile.ts"

const docsRoot = NodePath.join(import.meta.dirname, "../../docs")

const workspace = `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("guide-example", {
  repository: "git+https://example.invalid/guide-example.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson })
})
`

const guideCode = async (page: string): Promise<ReadonlyArray<string>> => {
  const source = await Fs.readFile(NodePath.join(docsRoot, page), "utf8")
  return [...source.matchAll(/^```ts\n([\s\S]*?)^```/gm)].map((match) => match[1]!)
}

const linkDocumentedHelperDependencies = async (root: string): Promise<void> => {
  const scope = NodePath.join(root, "node_modules/@smthrs")
  await Fs.mkdir(scope, { recursive: true })
  await Fs.symlink(NodePath.join(import.meta.dirname, "../../targets"), NodePath.join(scope, "targets"), "dir")
}

describe("build guide Package examples", () => {
  it("loads the complete labels example as a package with its documented target key", async () => {
    const snippets = await guideCode("concepts/labels.md")
    const source = snippets.find((snippet) => snippet.includes("export const Package ="))
    expect(source, "labels.md needs a complete Package example").toBeDefined()
    const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-guide-package-")))
    try {
      await write(root, "WORKSPACE.ts", workspace)
      await write(root, "packages/greeter/PACKAGE.ts", source!)
      const graph = await PackageLoader.load(await PackageDiscovery.discover(root))
      expect(graph.packages).toHaveLength(1)
      expect(graph.packages[0]!.file).toBe("packages/greeter/PACKAGE.ts")
      expect(graph.packages[0]!.packagePath).toBe("packages/greeter")
      expect(Object.keys(graph.packages[0]!.value)).toEqual(["lib"])
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  it("loads the inputs guide's shared declaration without giving the helper export a label", async () => {
    const snippets = await guideCode("concepts/inputs.md")
    const rootPackage = snippets.find((snippet) => snippet.includes("export const rootJSDocConfig"))
    const greeterPackage = snippets.find((snippet) => snippet.includes("import { rootJSDocConfig }"))
    expect(rootPackage, "inputs.md needs its root PACKAGE.ts example").toBeDefined()
    expect(greeterPackage, "inputs.md needs its consuming PACKAGE.ts example").toBeDefined()
    const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-guide-inputs-")))
    try {
      await write(root, "WORKSPACE.ts", workspace)
      await write(root, "PACKAGE.ts", rootPackage!)
      await write(root, "packages/greeter/PACKAGE.ts", greeterPackage!)
      const graph = await PackageLoader.load(await PackageDiscovery.discover(root))
      expect(graph.packages.map((entry) => [entry.packagePath, Object.keys(entry.value)])).toEqual([
        ["", []],
        ["packages/greeter", ["lint"]]
      ])
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  it("loads the dependencies guide's app and imported Package map", async () => {
    const snippets = await guideCode("concepts/dependencies.md")
    const appPackage = snippets.find((snippet) => snippet.includes("// packages/app/PACKAGE.ts"))
    const [helper] = await guideCode("reference/targets/standard-package.md")
    expect(appPackage, "dependencies.md needs its app PACKAGE.ts example").toBeDefined()
    expect(helper, "standard-package.md needs the referenced helper").toBeDefined()
    const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-guide-deps-")))
    try {
      await write(root, "WORKSPACE.ts", workspace)
      await linkDocumentedHelperDependencies(root)
      await write(
        root,
        "packages/flow/PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const lib = S.Filegroup({ srcs: [S.file("README.md")] })
export const Package = S.Package({ targets: { lib } })
`
      )
      await write(root, "packages/app/package-targets.ts", helper!)
      await write(root, "packages/app/PACKAGE.ts", appPackage!)
      const graph = await PackageLoader.load(await PackageDiscovery.discover(root))
      expect(graph.packages.map((entry) => [entry.packagePath, Object.keys(entry.value)])).toEqual([
        ["packages/app", ["lib", "test", "lint"]],
        ["packages/flow", ["lib"]]
      ])
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  it("loads the structure guide's root Package beside PackageDefaults", async () => {
    const snippets = await guideCode("workspace/structure.md")
    const rootPackage = snippets.find((snippet) => snippet.includes("export const packageDefaults"))
    const [helper] = await guideCode("reference/targets/standard-package.md")
    expect(rootPackage, "structure.md needs its root PACKAGE.ts example").toBeDefined()
    expect(helper, "standard-package.md needs the referenced helper").toBeDefined()
    const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-guide-structure-")))
    try {
      await linkDocumentedHelperDependencies(root)
      await write(root, "WORKSPACE.ts", workspace)
      await write(root, "package-targets.ts", helper!)
      await write(root, "PACKAGE.ts", rootPackage!)
      const graph = await PackageLoader.load(await PackageDiscovery.discover(root))
      expect(graph.packages).toHaveLength(1)
      expect(graph.packages[0]!.packagePath).toBe("")
      expect(Object.keys(graph.packages[0]!.value)).toEqual([])
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })
})
