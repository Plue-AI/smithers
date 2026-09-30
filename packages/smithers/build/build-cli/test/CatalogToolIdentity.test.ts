import { Smithers as S } from "@smthrs/targets"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, expect, it } from "vitest"
import { plan } from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"

const temporary: Array<string> = []
// These fixtures use POSIX shebangs; Windows command wrappers need their own evidence.
const posixIt = it.skipIf(process.platform === "win32")
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

// Controlled executable files exercise byte identity, not a simulated compiler
// verdict. Actual tool execution and sandbox/cache reuse remain separate gates.
const fixture = async (bunOverride = false) => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-catalog-tools-")))
  temporary.push(root)
  await Fs.mkdir(Path.join(root, "bin"))
  const write = (name: string, text: string) => Fs.writeFile(Path.join(root, name), text, { mode: 0o755 })
  await write("bin/pnpm", "#!/bin/sh\nprintf '11.21.0\\n'\n")
  await write("bin/node", "#!/bin/sh\nprintf '26.4.0\\n'\n")
  await write("bin/bun", "#!/bin/sh\nprintf '1.4.0\\n'\n")
  await write("package.json", "{}")
  await write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
  await write("config.json", "{}")
  await write("source.ts", "export const value = 1\n")
  const runtime = S.Runtime.Node({ version: ">=26.4.0", executable: Path.join(root, "bin/node") })
  const targets = {
    build: S.TsBuild({
      srcs: [S.file("source.ts")], entries: [S.file("source.ts")], deps: [],
      tsconfig: S.file("config.json"), tool: { name: "tsc" }, format: "esm", outDir: "dist"
    }),
    check: S.Typecheck({
      srcs: [S.file("source.ts")], deps: [], tsconfig: S.file("config.json"),
      buildMode: false, incremental: false
    }),
    test: S.Vitest({
      tests: [S.file("source.ts")], sources: [], deps: [], config: S.file("config.json"),
      environment: "node", passWithNoTests: false, coverage: false,
      ...(bunOverride ? { runtime: S.Runtime.Bun({ version: ">=1.4.0", executable: Path.join(root, "bin/bun") }) } : {})
    }),
    lint: S.EsLint({
      sources: [S.file("source.ts")], deps: [], configs: [S.file("config.json")], maxWarnings: 0, fix: false
    }),
    fmt: S.Dprint({ sources: [S.file("source.ts")], deps: [], config: S.file("config.json"), fix: false })
  }
  const index = PackageIndex.make({
    root,
    workspace: S.Workspace("catalog", {
      repository: "git+https://example.invalid/catalog.git", cache: S.Cache({ directory: ".flows" }), runtime,
      packageManager: S.PackageManager.Pnpm({
        manifest: S.file("//package.json"), lockfile: S.file("//pnpm-lock.yaml"), version: "11.21.0"
      }),
      nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
    }),
    factory: undefined,
    packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets }) }]
  })
  const node = async (name: string) => {
    const result = await plan({
      index, cacheDirectory: ".flows", verb: "ci", patterns: [`//:${name}`],
      environment: { PATH: `${Path.join(root, "bin")}${Path.delimiter}${process.env["PATH"] ?? ""}` }
    })
    return result.nodes.get(`//:${name}`)!
  }
  return { root, write, node }
}

posixIt.each(["build", "check", "test", "lint", "fmt"])(
  "%s keys the body runner's manager and interpreter bytes without Nix", async (name) => {
    const { write, node } = await fixture()
    const original = await node(name)
    expect(original.refusal).toBeUndefined()
    expect((await node(name)).keyPreview).toBe(original.keyPreview)
    await write("source.ts", "export const value = 2\n")
    expect((await node(name)).keyPreview).not.toBe(original.keyPreview)
    await write("source.ts", "export const value = 1\n")
    await write("README.md", "unrelated documentation\n")
    expect((await node(name)).keyPreview).toBe(original.keyPreview)
    // Same version, different executable bytes: a version probe alone is insufficient.
    await write("bin/pnpm", "#!/bin/sh\n# replacement\nprintf '11.21.0\\n'\n")
    expect((await node(name)).keyPreview).not.toBe(original.keyPreview)
    await write("bin/pnpm", "#!/bin/sh\nprintf '11.21.0\\n'\n")
    await write("bin/node", "#!/bin/sh\n# replacement\nprintf '26.4.0\\n'\n")
    expect((await node(name)).keyPreview).not.toBe(original.keyPreview)
    await write("bin/node", "#!/bin/sh\nprintf '26.4.0\\n'\n")
    expect((await node(name)).keyPreview).toBe(original.keyPreview)
    await write("config.json", '{"changed":true}')
    expect((await node(name)).keyPreview).not.toBe(original.keyPreview)
    await write("config.json", "{}")
    await write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n# changed\n")
    expect((await node(name)).keyPreview).not.toBe(original.keyPreview)
    // Launcher identity alone cannot promise a complete installed-tool/output contract.
    expect((await node(name)).cacheable).toBe(false)
  }
)

posixIt.each(["build", "check", "test", "lint", "fmt"])("%s refuses a missing declared interpreter", async (name) => {
  const { root, node } = await fixture()
  await Fs.rm(Path.join(root, "bin/node"))
  const planned = await node(name)
  expect(planned.refusal).toContain("cannot identify declared node executable")
  expect(planned.cacheable).toBe(false)
})

posixIt("keys Vitest's selected Bun executable rather than the unused workspace manager", async () => {
  const { root, write, node } = await fixture(true)
  const original = await node("test")
  expect(original.refusal).toBeUndefined()
  await Fs.rm(Path.join(root, "bin/node"))
  await write("bin/pnpm", "#!/bin/sh\n# unused replacement\nprintf '11.21.0\\n'\n")
  expect((await node("test")).keyPreview).toBe(original.keyPreview)
  await write("bin/bun", "#!/bin/sh\n# replacement\nprintf '1.4.0\\n'\n")
  expect((await node("test")).keyPreview).not.toBe(original.keyPreview)
})

posixIt("refuses an executable whose interpreter chain is cyclic", async () => {
  const { root, write, node } = await fixture()
  await write("bin/node", `#!${Path.join(root, "bin/node")}\n`)
  const planned = await node("check")
  expect(planned.refusal).toContain("cyclic executable interpreter")
  expect(planned.cacheable).toBe(false)
})
