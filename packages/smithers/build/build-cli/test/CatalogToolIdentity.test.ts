import { Smithers as S } from "@smthrs/targets"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, expect, it } from "vitest"
import { execute, plan } from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"

const temporary: Array<string> = []
// These fixtures use POSIX shebangs; Windows command wrappers need their own evidence.
const posixIt = it.skipIf(process.platform === "win32")
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

// Controlled executable files exercise byte identity, not a simulated compiler
// verdict. Actual tool execution and sandbox/cache reuse remain separate gates.
const fixture = async (bunOverride = false, relativeNode = false) => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-catalog-tools-")))
  temporary.push(root)
  await Fs.mkdir(Path.join(root, "bin"))
  const write = async (name: string, text: string) => {
    await Fs.mkdir(Path.dirname(Path.join(root, name)), { recursive: true })
    await Fs.writeFile(Path.join(root, name), text, { mode: 0o755 })
  }
  await write("bin/pnpm", "#!/bin/sh\nprintf '11.21.0\\n'\n")
  await write("bin/node", "#!/bin/sh\nprintf '26.4.0\\n'\n")
  await write("bin/bun", "#!/bin/sh\nprintf '1.4.0\\n'\n")
  await write("package.json", "{}")
  await write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
  await write("config.json", "{}")
  await write("source.ts", "export const value = 1\n")
  const runtime = S.Runtime.Node({
    version: ">=26.4.0",
    executable: relativeNode ? "./bin/node" : Path.join(root, "bin/node")
  })
  await write("dependency.ts", "export const dependency = 1\n")
  const dependency = S.Filegroup({ srcs: [S.file("dependency.ts")] })
  const targets = {
    dependency,
    build: S.TsBuild({
      srcs: [S.file("source.ts")],
      entries: [S.file("source.ts")],
      deps: [dependency],
      tsconfig: S.file("config.json"),
      tool: { name: "tsc" },
      format: "esm",
      outDir: "dist"
    }),
    check: S.Typecheck({
      srcs: [S.file("source.ts")],
      deps: [dependency],
      tsconfig: S.file("config.json"),
      buildMode: false,
      incremental: false
    }),
    test: S.Vitest({
      tests: [S.file("source.ts")],
      sources: [],
      deps: [dependency],
      config: S.file("config.json"),
      environment: "node",
      passWithNoTests: false,
      coverage: false,
      ...(bunOverride ? { runtime: S.Runtime.Bun({ version: ">=1.4.0", executable: Path.join(root, "bin/bun") }) } : {})
    }),
    lint: S.EsLint({
      sources: [S.file("source.ts")],
      deps: [dependency],
      configs: [S.file("config.json")],
      maxWarnings: 0,
      fix: false
    }),
    fmt: S.Dprint({ sources: [S.file("source.ts")], deps: [dependency], config: S.file("config.json"), fix: false })
  }
  const index = PackageIndex.make({
    root,
    workspace: S.Workspace("catalog", {
      repository: "git+https://example.invalid/catalog.git",
      cache: S.Cache({ directory: ".flows" }),
      runtime,
      packageManager: S.PackageManager.Pnpm({
        manifest: S.file("//package.json"),
        lockfile: S.file("//pnpm-lock.yaml"),
        version: "11.21.0"
      }),
      nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
    }),
    factory: undefined,
    packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets }) }]
  })
  const environment = { PATH: Path.join(root, "bin") }
  const planned = (name: string, extraEnvironment: Record<string, string | undefined> = {}) =>
    plan({
      index,
      cacheDirectory: ".flows",
      verb: "auto",
      patterns: [`//:${name}`],
      environment: { ...environment, ...extraEnvironment }
    })
  const node = async (name: string, extraEnvironment: Record<string, string | undefined> = {}) =>
    (await planned(name, extraEnvironment)).nodes.get(`//:${name}`)!
  return { root, write, node, planned, index, environment }
}

posixIt.each(["build", "check", "test", "lint", "fmt"])(
  "%s keys the body runner's manager and interpreter bytes without Nix",
  async (name) => {
    const { write, node } = await fixture()
    const original = await node(name)
    expect(original.refusal).toBeUndefined()
    expect((await node(name)).keyPreview).toBe(original.keyPreview)
    await write("source.ts", "export const value = 2\n")
    expect((await node(name)).keyPreview).not.toBe(original.keyPreview)
    await write("source.ts", "export const value = 1\n")
    await write("dependency.ts", "export const dependency = 2\n")
    expect((await node(name)).keyPreview).not.toBe(original.keyPreview)
    await write("dependency.ts", "export const dependency = 1\n")
    expect((await node(name)).keyPreview).toBe(original.keyPreview)
    await write("README.md", "unrelated documentation\n")
    expect((await node(name)).keyPreview).toBe(original.keyPreview)
    await write("package.json", "{\"changed\":true}")
    expect((await node(name)).keyPreview).not.toBe(original.keyPreview)
    await write("package.json", "{}")
    // Same version, different executable bytes: a version probe alone is insufficient.
    await write("bin/pnpm", "#!/bin/sh\n# replacement\nprintf '11.21.0\\n'\n")
    expect((await node(name)).keyPreview).not.toBe(original.keyPreview)
    await write("bin/pnpm", "#!/bin/sh\nprintf '11.21.0\\n'\n")
    await write("bin/node", "#!/bin/sh\n# replacement\nprintf '26.4.0\\n'\n")
    expect((await node(name)).keyPreview).not.toBe(original.keyPreview)
    await write("bin/node", "#!/bin/sh\nprintf '26.4.0\\n'\n")
    expect((await node(name)).keyPreview).toBe(original.keyPreview)
    await write("config.json", "{\"changed\":true}")
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

posixIt.each(["build", "check", "test", "lint", "fmt"])(
  "%s refuses a missing manager without ambient PATH fallback",
  async (name) => {
    const { root, node } = await fixture()
    await Fs.rm(Path.join(root, "bin/pnpm"))
    const result = await node(name)
    expect(result.refusal).toContain("cannot identify declared pnpm executable")
    expect(result.cacheable).toBe(false)
  }
)

posixIt("excludes unrelated ambient environment from catalog keys", async () => {
  const { node } = await fixture()
  const original = await node("check")
  const previous = process.env["SMITHERS_CATALOG_UNRELATED_CANARY"]
  try {
    process.env["SMITHERS_CATALOG_UNRELATED_CANARY"] = "changed ambient value"
    expect((await node("check")).keyPreview).toBe(original.keyPreview)
  } finally {
    if (previous === undefined) delete process.env["SMITHERS_CATALOG_UNRELATED_CANARY"]
    else process.env["SMITHERS_CATALOG_UNRELATED_CANARY"] = previous
  }
})

posixIt.each(["build", "check", "test", "lint", "fmt"])(
  "%s rejects executable replacement after planning before the body runs",
  async (name) => {
    const { root, write, planned, index, environment } = await fixture()
    const candidate = await planned(name)
    const marker = Path.join(root, "body-ran")
    await write("bin/pnpm", `#!/bin/sh\nprintf ran > '${marker}'\n`)
    const logs: Array<string> = []
    const result = await execute(candidate, {
      index,
      cacheDirectory: ".flows",
      verb: "auto",
      patterns: [`//:${name}`],
      environment,
      log: (line) => logs.push(line)
    })
    expect(result.ok).toBe(false)
    expect(result.counts.failed).toBe(1)
    expect(logs.join("\n")).toContain("executable changed since planning")
    await expect(Fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
  }
)

posixIt("keys nested env-selected interpreter bytes and refuses a missing interpreter", async () => {
  const { write, root, node } = await fixture()
  await write("bin/pnpm", "#!/usr/bin/env catalog-interpreter\n")
  await write("bin/catalog-interpreter", "#!/bin/sh\nprintf '11.21.0\\n'\n")
  const original = await node("check")
  expect(original.refusal).toBeUndefined()
  await write("bin/catalog-interpreter", "#!/bin/sh\n# replaced interpreter\nprintf '11.21.0\\n'\n")
  expect((await node("check")).keyPreview).not.toBe(original.keyPreview)
  await Fs.rm(Path.join(root, "bin/catalog-interpreter"))
  const missing = await node("check")
  expect(missing.refusal).toContain("shebang interpreter \"catalog-interpreter\" is not on PATH")
  expect(missing.cacheable).toBe(false)
})

posixIt("refuses an unidentifiable env shebang", async () => {
  const { write, node } = await fixture()
  await write("bin/pnpm", "#!/usr/bin/env -i node\n")
  const result = await node("check")
  expect(result.refusal).toContain("cannot identify env shebang interpreter")
  expect(result.cacheable).toBe(false)
})

posixIt("keys the interpreter selected by PATH rather than an unused interpreter", async () => {
  const { root, write, node } = await fixture()
  await write("bin/pnpm", "#!/usr/bin/env catalog-interpreter\n")
  await write("bin/catalog-interpreter", "#!/bin/sh\nprintf '11.21.0\\n'\n")
  await write("alternate/catalog-interpreter", "#!/bin/sh\n# alternate\nprintf '11.21.0\\n'\n")
  const original = await node("check")
  const alternatePath = [Path.join(root, "alternate"), Path.join(root, "bin")].join(Path.delimiter)
  const selectedAlternate = await node("check", { PATH: alternatePath })
  expect(selectedAlternate.keyPreview).not.toBe(original.keyPreview)
  await write("alternate/catalog-interpreter", "#!/bin/sh\n# selected replacement\nprintf '11.21.0\\n'\n")
  expect((await node("check", { PATH: alternatePath })).keyPreview).not.toBe(selectedAlternate.keyPreview)
  await Fs.mkdir(Path.join(root, "empty"))
  const emptyPrefix = [Path.join(root, "empty"), Path.join(root, "bin")].join(Path.delimiter)
  expect((await node("check", { PATH: emptyPrefix })).keyPreview).toBe(original.keyPreview)
  await write("alternate/catalog-interpreter", "#!/bin/sh\n# unused replacement\nprintf '11.21.0\\n'\n")
  expect((await node("check")).keyPreview).toBe(original.keyPreview)
})

posixIt("refuses a manager without executable permission", async () => {
  const { root, node } = await fixture()
  await Fs.chmod(Path.join(root, "bin/pnpm"), 0o644)
  const result = await node("check")
  expect(result.refusal).toContain("cannot identify declared pnpm executable")
  expect(result.cacheable).toBe(false)
})

posixIt("rejects an interpreter replacement after planning before the body runs", async () => {
  const { root, write, planned, index, environment } = await fixture()
  await write("bin/pnpm", "#!/usr/bin/env catalog-interpreter\n")
  await write("bin/catalog-interpreter", "#!/bin/sh\nprintf '11.21.0\\n'\n")
  const candidate = await planned("check")
  const marker = Path.join(root, "body-ran")
  await write("bin/catalog-interpreter", `#!/bin/sh\nprintf ran > '${marker}'\n`)
  const logs: Array<string> = []
  const result = await execute(candidate, {
    index,
    cacheDirectory: ".flows",
    verb: "auto",
    patterns: ["//:check"],
    environment,
    log: (line) => logs.push(line)
  })
  expect(result.ok).toBe(false)
  expect(result.counts.failed).toBe(1)
  expect(logs.join("\n")).toContain("executable changed since planning")
  await expect(Fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
})

posixIt("refuses a cwd-relative declared interpreter", async () => {
  const { node } = await fixture(false, true)
  const result = await node("check")
  expect(result.refusal).toContain("cwd-relative executable is unsupported")
  expect(result.cacheable).toBe(false)
})

posixIt.each(["relative", ""])("refuses cwd-dependent PATH entry %j", async (entry) => {
  const { root, node } = await fixture()
  const result = await node("check", { PATH: [entry, Path.join(root, "bin")].join(Path.delimiter) })
  expect(result.refusal).toContain("cwd-relative PATH entry is unsupported")
  expect(result.cacheable).toBe(false)
})

posixIt(
  "never executes a nested package interpreter whose bytes differ from the planned relative runtime",
  async () => {
    const { root, write, index, environment } = await fixture(false, true)
    await write("nested/source.ts", "export const value = 1\n")
    await write("nested/config.json", "{}")
    const unplannedMarker = Path.join(root, "unplanned-runtime-ran")
    await write("nested/bin/node", `#!/bin/sh\nprintf ran > '${unplannedMarker}'\nprintf '26.4.0\\n'\n`)
    const target = S.Typecheck({
      srcs: [S.file("source.ts")],
      deps: [],
      tsconfig: S.file("config.json"),
      buildMode: false,
      incremental: false,
      cwd: "nested"
    })
    const nestedIndex = PackageIndex.make({
      root,
      workspace: index.workspace,
      factory: undefined,
      packages: [{ file: "nested/PACKAGE.ts", packagePath: "nested", value: S.Package({ targets: { check: target } }) }]
    })
    const candidate = await plan({
      index: nestedIndex,
      cacheDirectory: ".flows",
      verb: "auto",
      patterns: ["//nested:check"],
      environment
    })
    expect(candidate.nodes.get("//nested:check")?.refusal).toContain("cwd-relative executable is unsupported")
    const logs: Array<string> = []
    const result = await execute(candidate, {
      index: nestedIndex,
      cacheDirectory: ".flows",
      verb: "auto",
      patterns: ["//nested:check"],
      environment,
      log: (line) => logs.push(line)
    })
    expect(result.ok).toBe(false)
    expect(result.counts.failed).toBe(1)
    expect(logs.join("\n")).toContain("cwd-relative executable is unsupported")
    await expect(Fs.stat(unplannedMarker)).rejects.toMatchObject({ code: "ENOENT" })
  }
)

posixIt("refuses an absent PATH without falling back to the host manager", async () => {
  const { node } = await fixture()
  const result = await node("check", { PATH: undefined })
  expect(result.refusal).toContain("cannot identify declared pnpm executable")
  expect(result.refusal).toContain("executable is not on PATH")
  expect(result.refusal).not.toContain("cannot identify declared node executable")
  expect(result.cacheable).toBe(false)
})
