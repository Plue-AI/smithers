import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import type * as Reporter from "../src/Reporter.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const workspace = `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("runner-edges", {
  repository: "git+https://example.invalid/runner-edges.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson })
})
`

const fixture = async (source: string): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-runner-edges-")))
  roots.push(root)
  await write(root, "WORKSPACE.ts", workspace)
  await write(root, "PACKAGE.ts", source)
  await write(root, "package.json", "{\"name\":\"runner-edges\",\"private\":true}\n")
  await write(root, "yarn.lock", "# yarn lockfile v1\n")
  NodeChildProcess.execFileSync("git", ["-C", root, "init", "-q"])
  NodeChildProcess.execFileSync("git", ["-C", root, "add", "-A"])
  NodeChildProcess.execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.email=t@t.t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "init"
  ])
  return root
}

const indexOf = async (root: string): Promise<PackageIndex> =>
  PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)), root)

const run = async (root: string, label: string, options: { readonly write?: boolean } = {}) =>
  PackageExec.run({
    index: await indexOf(root),
    cacheDirectory: ".flows",
    verb: "auto",
    patterns: [label],
    ...(options.write === undefined ? {} : { write: options.write })
  })

const cacheEntries = async (root: string): Promise<ReadonlyArray<string>> => {
  const directory = NodePath.join(root, ".flows", "cache")
  const paths: Array<string> = []
  for (const shard of await Fs.readdir(directory)) {
    const path = NodePath.join(directory, shard)
    if (!(await Fs.stat(path)).isDirectory()) continue
    for (const name of await Fs.readdir(path)) paths.push(NodePath.join(path, name))
  }
  return paths
}

/**
 * Waits until a heartbeat file stops growing.
 *
 * A sandboxed command runs in its own PID namespace on Linux, so any PID it
 * reports names a different host process. Liveness is observed through the
 * command's own writes instead.
 */
const waitForQuiet = async (path: string): Promise<number> => {
  const size = () => Fs.stat(path).then((stat) => stat.size, () => 0)
  const deadline = Date.now() + 5_000
  let previous = await size()
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const current = await size()
    if (current === previous) return current
    if (Date.now() >= deadline) throw new Error(`fixture command is still writing ${path}`)
    previous = current
  }
}

const malformedBuildOutputs: ReadonlyArray<readonly [string, (output: Record<string, unknown>) => unknown]> = [
  ["null output", () => null],
  ["wrong output kind", (output) => ({ ...output, kind: "other" })],
  ["nonarray directory manifests", (output) => ({ ...output, manifests: {} })],
  ["invalid directory manifest", (output) => ({ ...output, manifests: [{ outDir: "dist-one", entries: null }] })],
  ["nonarray file manifests", (output) => ({ ...output, files: {} })],
  [
    "invalid file manifest",
    (output) => ({ ...output, files: [{ path: "out-one.txt", digest: "invalid", executable: false }] })
  ],
  [
    "missing directory manifest",
    (output) => ({ ...output, manifests: (output["manifests"] as Array<unknown>).slice(0, 1) })
  ],
  [
    "duplicate directory manifest",
    (output) => ({ ...output, manifests: Array(2).fill((output["manifests"] as Array<unknown>)[0]) })
  ],
  ["missing file manifest", (output) => ({ ...output, files: (output["files"] as Array<unknown>).slice(0, 1) })],
  ["duplicate file manifest", (output) => ({ ...output, files: Array(2).fill((output["files"] as Array<unknown>)[0]) })]
]

describe("PackageRunner output boundaries", () => {
  it("restores a directory-only cached build that omits the optional file manifest list", async () => {
    const root = await fixture(`import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  build: S.Shell.Build({ shell: "mkdir -p dist && printf built > dist/a.txt", outDirs: ["dist"] })
} })
`)
    expect((await run(root, "//:build")).results).toMatchObject([{ label: "//:build", status: "ran" }])
    let changed = 0
    for (const file of await cacheEntries(root)) {
      const entry = JSON.parse(await Fs.readFile(file, "utf8")) as { output: Record<string, unknown> }
      if (entry.output["kind"] !== "build") continue
      expect(entry.output["files"]).toEqual([])
      delete entry.output["files"]
      await Fs.writeFile(file, JSON.stringify(entry))
      changed++
    }
    expect(changed).toBe(1)
    await Fs.rm(NodePath.join(root, "dist"), { recursive: true })
    expect((await run(root, "//:build")).results).toMatchObject([{ label: "//:build", status: "hit" }])
    expect(await Fs.readFile(NodePath.join(root, "dist", "a.txt"), "utf8")).toBe("built")
  })

  it.each(malformedBuildOutputs)(
    "rejects %s in a real cached build and rebuilds its exact products",
    async (_name, mutate) => {
      const root = await fixture(`import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  build: S.Shell.Build({
    shell: "mkdir -p dist-one dist-two; printf one > dist-one/a.txt; printf two > dist-two/a.txt; printf file-one > out-one.txt; printf file-two > out-two.txt",
    outDirs: ["dist-one", "dist-two"], outFiles: ["out-one.txt", "out-two.txt"]
  })
} })
`)
      expect((await run(root, "//:build")).results).toMatchObject([{ label: "//:build", status: "ran" }])
      await write(root, "sentinel.txt", "unrelated bytes")
      let poisoned = 0
      for (const file of await cacheEntries(root)) {
        const entry = JSON.parse(await Fs.readFile(file, "utf8")) as { output: Record<string, unknown> }
        if (entry.output["kind"] !== "build") continue
        expect(entry.output["manifests"]).toHaveLength(2)
        expect(entry.output["files"]).toHaveLength(2)
        await Fs.writeFile(file, JSON.stringify({ ...entry, output: mutate(entry.output) }))
        poisoned++
      }
      expect(poisoned).toBe(1)
      for (const path of ["dist-one", "dist-two", "out-one.txt", "out-two.txt"]) {
        await Fs.rm(NodePath.join(root, path), { recursive: true })
      }
      const rebuilt = await run(root, "//:build")
      expect(rebuilt.results).toMatchObject([{ label: "//:build", status: "ran" }])
      for (
        const [path, bytes] of [
          ["dist-one/a.txt", "one"],
          ["dist-two/a.txt", "two"],
          ["out-one.txt", "file-one"],
          ["out-two.txt", "file-two"],
          ["sentinel.txt", "unrelated bytes"]
        ] as const
      ) expect(await Fs.readFile(NodePath.join(root, path), "utf8")).toBe(bytes)
    }
  )

  it("refuses a valid but undeclared cached output root and reruns without touching it", async () => {
    const root = await fixture(`import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  build: S.Shell.Build({ shell: "mkdir -p dist && printf built > dist/a.txt", outDirs: ["dist"] })
} })
`)
    const first = await run(root, "//:build")
    expect(first.results).toMatchObject([{ label: "//:build", status: "ran" }])
    await write(root, "other/precious.txt", "keep me")
    let poisoned = 0
    for (const file of await cacheEntries(root)) {
      const entry = JSON.parse(await Fs.readFile(file, "utf8")) as {
        output?: { kind?: string; manifests?: Array<{ outDir: string }> }
      }
      if (entry.output?.kind !== "build" || (entry.output.manifests?.length ?? 0) === 0) continue
      for (const manifest of entry.output.manifests!) manifest.outDir = "other"
      await Fs.writeFile(file, JSON.stringify(entry))
      poisoned++
    }
    expect(poisoned).toBeGreaterThan(0)
    await Fs.rm(NodePath.join(root, "dist"), { recursive: true })
    const second = await run(root, "//:build")
    expect(second.results).toMatchObject([{ label: "//:build", status: "ran" }])
    expect(await Fs.readFile(NodePath.join(root, "dist", "a.txt"), "utf8")).toBe("built")
    expect(await Fs.readFile(NodePath.join(root, "other", "precious.txt"), "utf8")).toBe("keep me")
  })

  it("refuses a cached file manifest that names another in-workspace file", async () => {
    const root = await fixture(`import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  build: S.Shell.Build({ shell: "printf built > out.txt", outFiles: ["out.txt"] })
} })
`)
    const first = await run(root, "//:build")
    expect(first.results).toMatchObject([{ label: "//:build", status: "ran" }])
    await write(root, "other/precious.txt", "keep me")
    let poisoned = 0
    for (const file of await cacheEntries(root)) {
      const entry = JSON.parse(await Fs.readFile(file, "utf8")) as {
        output?: { kind?: string; files?: Array<{ path: string }> }
      }
      if (entry.output?.kind !== "build" || (entry.output.files?.length ?? 0) === 0) continue
      for (const manifest of entry.output.files!) manifest.path = "other/precious.txt"
      await Fs.writeFile(file, JSON.stringify(entry))
      poisoned++
    }
    expect(poisoned).toBeGreaterThan(0)
    await Fs.rm(NodePath.join(root, "out.txt"))
    const second = await run(root, "//:build")
    expect(second.results).toMatchObject([{ label: "//:build", status: "ran" }])
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("built")
    expect(await Fs.readFile(NodePath.join(root, "other", "precious.txt"), "utf8")).toBe("keep me")
  })

  it("does not publish failed command stdout over a declared output", async () => {
    const root = await fixture(`import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  gen: S.Generate({ command: "printf partial; exit 7", stdout: "out.txt" })
} })
`)
    await write(root, "out.txt", "original")
    const failed = await run(root, "//:gen", { write: true })
    expect(failed.ok).toBe(false)
    expect(failed.results).toMatchObject([{ label: "//:gen", status: "failed" }])
    expect(failed.results[0]?.error).toContain("exit 7")
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("original")
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  gen: S.Generate({ command: "printf complete", stdout: "out.txt" })
} })
`
    )
    const succeeded = await run(root, "//:gen", { write: true })
    expect(succeeded.results).toMatchObject([{ label: "//:gen", status: "ran" }])
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("complete")
  })
})

describe("PackageRunner cancellation", () => {
  it("refuses an already cancelled invocation before a target starts", async () => {
    const root = await fixture(`import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  command: S.Shell.Test({ shell: "mkdir -p .flows/tmp; printf launched > .flows/tmp/preabort-sentinel; printf launched" })
} })
`)
    const events: Array<string> = []
    const reporter: Reporter.Reporter = {
      renderer: "plain",
      begin: () => events.push("begin"),
      targetStarted: () => events.push("started"),
      targetFinished: () => events.push("finished"),
      toolOutput: (_label, _stream, chunk) => events.push(`output ${chunk}`),
      note: () => undefined,
      warn: () => undefined,
      summary: () => events.push("summary"),
      close: () => undefined
    }
    const options = {
      index: await indexOf(root),
      cacheDirectory: ".flows",
      verb: "test" as const,
      patterns: ["//:command"],
      reporter
    }
    const planned = await PackageExec.plan(options)
    await expect(PackageExec.execute(planned, {
      ...options,
      signal: AbortSignal.abort(new Error("stop before command"))
    })).rejects.toThrow("All fibers interrupted without error")
    expect(events).not.toContain("started")
    expect(events).not.toContain("finished")
    expect(events.some((event) => event.startsWith("output "))).toBe(false)
    await expect(Fs.stat(NodePath.join(root, ".flows", "tmp", "preabort-sentinel")))
      .rejects.toMatchObject({ code: "ENOENT" })
  })

  it("interrupts a running command after its first live output", async () => {
    const root = await fixture(`import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  slow: S.Shell.Test({ shell: "mkdir -p .flows/tmp; i=0; (while [ $i -lt 600 ]; do printf . >> .flows/tmp/beat; [ $i -eq 0 ] && printf 'started\\n'; i=$((i+1)); sleep 0.05; done) & wait" })
} })
`)
    const beat = NodePath.join(root, ".flows", "tmp", "beat")
    const controller = new AbortController()
    const output: Array<string> = []
    const reporter: Reporter.Reporter = {
      renderer: "plain",
      begin: () => undefined,
      targetStarted: () => undefined,
      targetFinished: () => undefined,
      toolOutput: (_label, _stream, chunk) => {
        output.push(chunk)
        if (output.join("").includes("started\n")) controller.abort(new Error("stop slow test"))
      },
      note: () => undefined,
      warn: () => undefined,
      summary: () => undefined,
      close: () => undefined
    }
    const running = PackageExec.run({
      index: await indexOf(root),
      cacheDirectory: ".flows",
      verb: "test",
      patterns: ["//:slow"],
      readCache: false,
      signal: controller.signal,
      reporter
    })
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const bounded = Promise.race([
        running,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("fixture execution did not settle")), 10_000)
        })
      ])
      await expect(bounded).rejects.toThrow("All fibers interrupted without error")
      expect(controller.signal.aborted).toBe(true)
      const settled = await waitForQuiet(beat)
      expect(settled).toBeGreaterThan(0)
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect((await Fs.stat(beat).catch(() => undefined))?.size ?? 0).toBe(settled)
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      controller.abort()
    }
  }, 20_000)
})

const compatFixture = async (
  surface: string,
  currentManifest: string,
  baselineManifest: string | undefined,
  publicBaseline = true,
  publicSurface = true
): Promise<string> => {
  const baselineShell = "mkdir -p baseline; printf '%s' 'export declare const value: string;' > baseline/api.d.ts" +
    (baselineManifest === undefined ? "" : `; printf '%s' '${baselineManifest}' > baseline/package.json`)
  const surfaceShell = `mkdir -p surface; printf '%s' '${surface}' > surface/api.d.ts`
  const root = await fixture(`import { Smithers as S } from "@smthrs/targets"
const baseline = S.Shell.Build({ shell: ${JSON.stringify(baselineShell)}, outDirs: ["baseline"] })
const surface = S.Shell.Build({ shell: ${JSON.stringify(surfaceShell)}, outDirs: ["surface"] })
export const Package = S.Package({ targets: {
  ${publicBaseline ? "baseline," : ""} ${publicSurface ? "surface," : ""}
  compat: S.Api.Compat({ baseline, surface, manifest: S.file("//version.json") })
} })
`)
  await write(root, "version.json", currentManifest)
  return root
}

describe("PackageRunner declaration compatibility", () => {
  it.each(
    [
      ["matching", "export declare const value: string;", true],
      ["changed", "export declare const value: number;", false]
    ] as const
  )("compares %s declarations in gitignored producer output trees", async (_name, surface, compatible) => {
    const root = await compatFixture(surface, "{\"version\":\"1.0.0\"}", "{\"version\":\"1.0.0\"}")
    await write(root, ".gitignore", "baseline/\nsurface/\n")
    const result = await run(root, "//:compat")
    expect(await Fs.readFile(NodePath.join(root, "baseline/api.d.ts"), "utf8"))
      .toBe("export declare const value: string;")
    expect(await Fs.readFile(NodePath.join(root, "surface/api.d.ts"), "utf8")).toBe(surface)
    expect(
      NodeChildProcess.execFileSync("git", ["-C", root, "check-ignore", "baseline/api.d.ts", "surface/api.d.ts"], {
        encoding: "utf8"
      })
    )
      .toBe("baseline/api.d.ts\nsurface/api.d.ts\n")
    expect(result.ok).toBe(compatible)
    expect(result.results.find((row) => row.label === "//:compat")).toMatchObject(
      compatible
        ? { label: "//:compat", status: "ran" }
        : { label: "//:compat", status: "failed", error: "declaration surface changed without a version bump (1.0.0)" }
    )
    const entries = await Promise.all(
      (await cacheEntries(root)).map(async (file) =>
        JSON.parse(await Fs.readFile(file, "utf8")) as { output?: { kind?: string } }
      )
    )
    expect(entries.filter((entry) => entry.output?.kind === "api-compat")).toHaveLength(compatible ? 1 : 0)
    if (!compatible) {
      const original = await Fs.readFile(NodePath.join(root, "PACKAGE.ts"), "utf8")
      const surfaceOffset = original.indexOf("const surface =")
      expect(surfaceOffset).toBeGreaterThan(0)
      await write(
        root,
        "PACKAGE.ts",
        original.slice(0, surfaceOffset) +
          original.slice(surfaceOffset).replace("value: number;", "value: string;")
      )
      const recovered = await run(root, "//:compat")
      expect(recovered.ok).toBe(true)
      expect(recovered.results.find((row) => row.label === "//:compat")).toMatchObject({ status: "ran" })
      expect(await Fs.readFile(NodePath.join(root, "surface/api.d.ts"), "utf8"))
        .toBe("export declare const value: string;")
    }
    const cached = await run(root, "//:compat")
    expect(cached.ok).toBe(true)
    expect(cached.results.find((row) => row.label === "//:compat")).toMatchObject({ status: "hit" })
  })

  it.each(
    [
      ["matching", "export declare const value: string;", true],
      ["changed", "export declare const value: number;", false]
    ] as const
  )("compares %s declarations inside generated nested package directories", async (_name, surface, compatible) => {
    const root = await compatFixture(surface, "{\"version\":\"1.0.0\"}", "{\"version\":\"1.0.0\"}")
    const options = {
      index: await indexOf(root),
      cacheDirectory: ".flows",
      verb: "auto" as const,
      patterns: ["//:compat"]
    }
    const planned = await PackageExec.plan(options)
    // Output package markers can be materialized by producers or a prior build.
    // Planning precedes them, so this tests generated enumeration rather than discovery.
    for (const side of ["baseline", "surface"]) {
      await write(
        root,
        `${side}/PACKAGE.ts`,
        "import { Smithers as S } from \"@smthrs/targets\"; export const Package = S.Package({ targets: {} })\n"
      )
    }
    const result = await PackageExec.execute(planned, options)
    expect(await Fs.readFile(NodePath.join(root, "baseline/api.d.ts"), "utf8"))
      .toBe("export declare const value: string;")
    expect(await Fs.readFile(NodePath.join(root, "surface/api.d.ts"), "utf8")).toBe(surface)
    expect(result.ok).toBe(compatible)
    expect(result.results.find((row) => row.label === "//:compat")).toMatchObject(
      compatible
        ? { status: "ran" }
        : { status: "failed", error: "declaration surface changed without a version bump (1.0.0)" }
    )
  })

  it("executes one private producer shared by both roles once and caches the compatibility receipt", async () => {
    const shell = "mkdir -p shared .flows/tmp; printf 'run\\n' >> .flows/tmp/shared-executions; " +
      "printf '%s' 'export declare const value: string;' > shared/api.d.ts; " +
      "printf '%s' '{\"version\":\"1.0.0\"}' > shared/package.json"
    const root = await fixture(`import { Smithers as S } from "@smthrs/targets"
const producer = S.Shell.Build({ shell: ${JSON.stringify(shell)}, outDirs: ["shared"] })
export const Package = S.Package({ targets: {
  compat: S.Api.Compat({ baseline: producer, surface: producer, manifest: S.file("//version.json") })
} })
`)
    await write(root, "version.json", "{\"version\":\"1.0.0\"}")
    const first = await run(root, "//:compat")
    expect(first.ok).toBe(true)
    expect(first.results).toHaveLength(2)
    expect(first.results.map((row) => row.status)).toEqual(["ran", "ran"])
    expect(first.results.find((row) => row.label === "//:compat"))
      .toMatchObject({ label: "//:compat", status: "ran" })
    expect(await Fs.readFile(NodePath.join(root, "shared/api.d.ts"), "utf8"))
      .toBe("export declare const value: string;")
    expect(await Fs.readFile(NodePath.join(root, ".flows/tmp/shared-executions"), "utf8")).toBe("run\n")
    const second = await run(root, "//:compat")
    expect(second.ok).toBe(true)
    expect(second.results).toHaveLength(2)
    expect(second.results.map((row) => row.status)).toEqual(["hit", "hit"])
    expect(await Fs.readFile(NodePath.join(root, ".flows/tmp/shared-executions"), "utf8")).toBe("run\n")
  })

  it("keeps private producer roles when the surface must finish before the baseline", async () => {
    const surfaceShell = "mkdir -p surface; printf '%s' 'export declare const value: number;' > surface/api.d.ts; " +
      "printf surface-ready"
    const baselineShell = "set -e; test -f surface/api.d.ts; mkdir -p baseline; " +
      "printf '%s' 'export declare const value: string;' > baseline/api.d.ts; " +
      "printf '%s' '{\"version\":\"1.0.0\"}' > baseline/package.json; printf baseline-ready"
    const root = await fixture(`import { Smithers as S } from "@smthrs/targets"
const surface = S.Shell.Build({ shell: ${JSON.stringify(surfaceShell)}, outDirs: ["surface"] })
const baseline = S.Shell.Build({ shell: ${JSON.stringify(baselineShell)}, outDirs: ["baseline"], data: [surface] })
export const Package = S.Package({ targets: {
  compat: S.Api.Compat({ baseline, surface, manifest: S.file("//version.json") })
} })
`)
    await write(root, "version.json", "{\"version\":\"1.1.0\"}")
    const finished: Array<string> = []
    const output: Array<string> = []
    const reporter: Reporter.Reporter = {
      renderer: "plain",
      begin: () => undefined,
      targetStarted: () => undefined,
      targetFinished: (row) => finished.push(row.label),
      toolOutput: (_label, _stream, chunk) => output.push(chunk),
      note: () => undefined,
      warn: () => undefined,
      summary: () => undefined,
      close: () => undefined
    }
    const options = {
      index: await indexOf(root),
      cacheDirectory: ".flows",
      verb: "auto" as const,
      patterns: ["//:compat"],
      reporter
    }
    const planned = await PackageExec.plan(options)
    const surface = planned.workList.find((node) => node.outDirs.includes("surface"))!
    const baseline = planned.workList.find((node) => node.outDirs.includes("baseline"))!
    expect(surface.rule).toBe("Shell.Build")
    expect(baseline.rule).toBe("Shell.Build")
    expect(baseline.dependencies).toContain(surface.label)
    const result = await PackageExec.execute(planned, options)
    expect(result.ok).toBe(true)
    expect(finished).toEqual([surface.label, baseline.label, "//:compat"])
    expect(output.join("")).toBe("surface-ready\nbaseline-ready\n")
    expect(result.results.find((row) => row.label === "//:compat"))
      .toMatchObject({ label: "//:compat", status: "ran" })
    expect(await Fs.readFile(NodePath.join(root, "baseline/package.json"), "utf8")).toBe("{\"version\":\"1.0.0\"}")
    await expect(Fs.stat(NodePath.join(root, "surface/package.json"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await Fs.readFile(NodePath.join(root, "surface/api.d.ts"), "utf8"))
      .toBe("export declare const value: number;")
  })

  it.each(
    [
      ["private baseline", false, true],
      ["private surface", true, false],
      ["both private producers", false, false]
    ] as const
  )("resolves %s just like named producers", async (_name, publicBaseline, publicSurface) => {
    const root = await compatFixture(
      "export declare const value: string;",
      "{\"version\":\"1.0.0\"}",
      "{\"version\":\"1.0.0\"}",
      publicBaseline,
      publicSurface
    )
    const result = await run(root, "//:compat")
    expect(result.results.filter((row) => row.label !== "//:compat").map((row) => row.status)).toEqual(["ran", "ran"])
    expect(await Fs.readFile(NodePath.join(root, "baseline/api.d.ts"), "utf8"))
      .toBe("export declare const value: string;")
    expect(await Fs.readFile(NodePath.join(root, "surface/api.d.ts"), "utf8"))
      .toBe("export declare const value: string;")
    expect(result.ok).toBe(true)
    expect(result.results.find((row) => row.label === "//:compat"))
      .toMatchObject({ label: "//:compat", status: "ran" })
    const cached = await run(root, "//:compat")
    expect(cached.ok).toBe(true)
    expect(cached.results.find((row) => row.label === "//:compat"))
      .toMatchObject({ label: "//:compat", status: "hit" })
  })

  it.each(
    [
      ["unchanged declarations and unchanged version", "export declare const value: string;", "1.0.0", true],
      ["unchanged declarations and bumped version", "export declare const value: string;", "1.1.0", true],
      ["changed declarations and unchanged version", "export declare const value: number;", "1.0.0", false],
      ["changed declarations and bumped version", "export declare const value: number;", "1.1.0", true]
    ] as const
  )("checks %s against real declaration products", async (_name, surface, version, allowed) => {
    const root = await compatFixture(surface, JSON.stringify({ version }), "{\"version\":\"1.0.0\"}")
    const first = await run(root, "//:compat")
    expect(first.ok).toBe(allowed)
    const result = first.results.find((row) => row.label === "//:compat")
    if (allowed) {
      expect(result).toMatchObject({ label: "//:compat", status: "ran" })
      expect(result?.error).toBeUndefined()
      expect((await run(root, "//:compat")).results.find((row) => row.label === "//:compat"))
        .toMatchObject({ label: "//:compat", status: "hit" })
    } else {
      expect(result).toMatchObject({
        label: "//:compat",
        status: "failed",
        error: "declaration surface changed without a version bump (1.0.0)"
      })
      await write(root, "version.json", "{\"version\":\"1.1.0\"}")
      const retried = await run(root, "//:compat")
      expect(retried.ok).toBe(true)
      expect(retried.results.find((row) => row.label === "//:compat"))
        .toMatchObject({ label: "//:compat", status: "ran" })
    }
    expect(await Fs.readFile(NodePath.join(root, "baseline/api.d.ts"), "utf8"))
      .toBe("export declare const value: string;")
    expect(await Fs.readFile(NodePath.join(root, "surface/api.d.ts"), "utf8")).toBe(surface)
  })

  it.each(
    [
      ["missing current version", "{}", "{\"version\":\"1.0.0\"}"],
      ["numeric current version", "{\"version\":1}", "{\"version\":\"1.0.0\"}"],
      ["null current version", "{\"version\":null}", "{\"version\":\"1.0.0\"}"],
      ["missing baseline version", "{\"version\":\"1.0.0\"}", "{}"],
      ["numeric baseline version", "{\"version\":\"1.0.0\"}", "{\"version\":1}"],
      ["null baseline version", "{\"version\":\"1.0.0\"}", "{\"version\":null}"],
      ["absent baseline manifest", "{\"version\":\"1.0.0\"}", undefined]
    ] as const
  )("refuses %s with the version diagnostic", async (_name, current, baseline) => {
    const root = await compatFixture("export declare const value: string;", current, baseline)
    const failed = await run(root, "//:compat")
    expect(failed.ok).toBe(false)
    expect(failed.results.find((row) => row.label === "//:compat")).toMatchObject({
      label: "//:compat",
      status: "failed",
      error: "Api.Compat manifests must declare string versions"
    })
  })

  it("reports a manifest removed after planning instead of claiming compatibility", async () => {
    const root = await compatFixture(
      "export declare const value: string;",
      "{\"version\":\"1.0.0\"}",
      "{\"version\":\"1.0.0\"}"
    )
    const options = {
      index: await indexOf(root),
      cacheDirectory: ".flows",
      verb: "auto" as const,
      patterns: ["//:compat"]
    }
    const planned = await PackageExec.plan(options)
    const path = NodePath.join(root, "version.json")
    await Fs.rm(path)
    const failed = await PackageExec.execute(planned, options)
    expect(failed.ok).toBe(false)
    expect(failed.results.find((row) => row.label === "//:compat")).toMatchObject({
      label: "//:compat",
      status: "failed",
      error: `ENOENT: no such file or directory, open '${path}'`
    })
  })

  it.each(
    [
      ["array", "[]", "Api.Compat manifests must declare string versions"],
      ["boolean", "true", "Api.Compat manifests must declare string versions"],
      ["number", "1", "Api.Compat manifests must declare string versions"],
      ["string", "\"1.0.0\"", "Api.Compat manifests must declare string versions"],
      ["null", "null", "Cannot read properties of null (reading 'version')"],
      ["malformed JSON", "{", "Expected property name or '}' in JSON at position 1 (line 1 column 2)"]
    ] as const
  )("fails a %s manifest on either side without a success cache receipt", async (_name, bytes, error) => {
    for (const side of ["current", "baseline"] as const) {
      const root = await compatFixture(
        "export declare const value: string;",
        side === "current" ? bytes : "{\"version\":\"1.0.0\"}",
        side === "baseline" ? bytes : "{\"version\":\"1.0.0\"}"
      )
      const failed = await run(root, "//:compat")
      expect(failed.ok, side).toBe(false)
      expect(failed.results.find((row) => row.label === "//:compat"), side).toMatchObject({
        label: "//:compat",
        status: "failed",
        error
      })
      const entries = await Promise.all(
        (await cacheEntries(root)).map(async (file) =>
          JSON.parse(await Fs.readFile(file, "utf8")) as { output?: { kind?: string } }
        )
      )
      expect(entries.some((entry) => entry.output?.kind === "api-compat"), side).toBe(false)
    }
  })
})

const shardFixture = async (): Promise<string> => {
  const root = await fixture(`import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  check: S.Shell.Test({ script: S.file("//check.sh"), shards: 3 })
} })
`)
  await write(
    root,
    "check.sh",
    "mkdir -p .flows/tmp; printf '%s|%s\\n' \"$1\" \"$VITE_SHARD_ID\"; printf launched > .flows/tmp/shard-launched\n"
  )
  return root
}

describe("PackageRunner shard selection", () => {
  it.each(
    [
      ["", "invalid SMTHRS_SHARD \"\""],
      ["x/3", "invalid SMTHRS_SHARD \"x/3\""],
      ["1/3extra", "invalid SMTHRS_SHARD \"1/3extra\""],
      ["1/2", "SMTHRS_SHARD total 2 does not match declared shards 3"],
      ["0/3", "SMTHRS_SHARD index 0 is out of range"],
      ["4/3", "SMTHRS_SHARD index 4 is out of range"]
    ] as const
  )("refuses selection %j before launching any shard", async (selected, error) => {
    const root = await shardFixture()
    const result = await PackageExec.run({
      index: await indexOf(root),
      cacheDirectory: ".flows",
      verb: "test",
      patterns: ["//:check"],
      environment: { ...process.env, SMTHRS_SHARD: selected }
    })
    expect(result.ok).toBe(false)
    expect(result.results).toMatchObject([{ label: "//:check", status: "failed", error }])
    await expect(Fs.stat(NodePath.join(root, ".flows/tmp/shard-launched"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("executes only the selected boundary shard and keeps its cache separate", async () => {
    const root = await shardFixture()
    const output: Array<string> = []
    const reporter: Reporter.Reporter = {
      renderer: "plain",
      begin: () => undefined,
      targetStarted: () => undefined,
      targetFinished: () => undefined,
      toolOutput: (_label, _stream, chunk) => output.push(chunk),
      note: () => undefined,
      warn: () => undefined,
      summary: () => undefined,
      close: () => undefined
    }
    const index = await indexOf(root)
    for (
      const [selection, status, bytes] of [
        ["1/3", "ran", "--shard=1/3|1\n"],
        ["3/3", "ran", "--shard=3/3|3\n"],
        ["1/3", "hit", ""]
      ] as const
    ) {
      output.length = 0
      await Fs.rm(NodePath.join(root, ".flows/tmp/shard-launched"), { force: true })
      const result = await PackageExec.run({
        index,
        cacheDirectory: ".flows",
        verb: "test",
        patterns: ["//:check"],
        reporter,
        environment: { ...process.env, SMTHRS_SHARD: selection }
      })
      expect(result.ok, selection).toBe(true)
      expect(result.results, selection).toMatchObject([{ label: "//:check", status }])
      expect(output.join(""), selection).toBe(bytes)
      if (status === "ran") {
        expect(await Fs.readFile(NodePath.join(root, ".flows/tmp/shard-launched"), "utf8")).toBe("launched")
      } else {
        await expect(Fs.stat(NodePath.join(root, ".flows/tmp/shard-launched")))
          .rejects.toMatchObject({ code: "ENOENT" })
      }
    }
  })

  it("does not cache a failed selected shard and retries a corrected script", async () => {
    const root = await shardFixture()
    await write(root, "check.sh", "printf failed-shard; exit 7\n")
    const invoke = async () =>
      PackageExec.run({
        index: await indexOf(root),
        cacheDirectory: ".flows",
        verb: "test",
        patterns: ["//:check"],
        environment: { ...process.env, SMTHRS_SHARD: "2/3" }
      })
    const failed = await invoke()
    expect(failed.ok).toBe(false)
    expect(failed.results).toMatchObject([{
      label: "//:check",
      status: "failed",
      error: "command failed (exit 7): /bin/sh check.sh --shard=2/3\nfailed-shard"
    }])
    const cacheDirectory = NodePath.join(root, ".flows/cache")
    const entries = await Fs.stat(cacheDirectory).then(() => cacheEntries(root)).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return []
      throw cause
    })
    expect(entries).toEqual([])
    await write(root, "check.sh", "printf recovered-shard\n")
    const retried = await invoke()
    expect(retried.ok).toBe(true)
    expect(retried.results).toMatchObject([{ label: "//:check", status: "ran" }])
    expect((await invoke()).results).toMatchObject([{ label: "//:check", status: "hit" }])
  })
})
