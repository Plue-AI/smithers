import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

// SHA-256 of the literal two-byte UTF-8 payload "hi", independently authored.
const hiDigest = "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4"
const byeDigest = "b49f425a7e1f9cff3856329ada223f2f9d368f15a00cf48df16ca95986137fe8"
const baseline = (path: string): string => JSON.stringify([{ path, digest: hiDigest }])

const packageSource = (producer: string): string =>
  `import { Smithers as S } from "@smthrs/targets"
const producer = ${producer}
export const Package = S.Package({ targets: {
  producer, check: S.Test({ expect: S.Files.digest(producer), toBe: S.file("//baseline.json") })
} })
`

const fixture = async (producer: string, expected: string, packagePath = ""): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-files-digest-")))
  roots.push(root)
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("files-digest", {
  repository: "git+https://example.invalid/files-digest.git", cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson })
})
`
  )
  await write(
    root,
    NodePath.join(packagePath, "PACKAGE.ts"),
    packageSource(producer)
  )
  await write(root, "package.json", "{\"name\":\"files-digest\",\"private\":true}")
  await write(root, "yarn.lock", "# yarn lockfile v1\n")
  await write(root, "input.txt", "hi")
  await write(root, "baseline.json", expected)
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

const optionsFor = async (root: string, label = "//:check") => ({
  index: PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)), root),
  cacheDirectory: ".flows",
  verb: "auto" as const,
  patterns: [label]
})
const run = async (root: string, label = "//:check") => PackageExec.run(await optionsFor(root, label))
const directoryProducer = "S.Shell.Build({ shell: \"mkdir -p dist; printf hi > dist/a.txt\", outDirs: [\"dist\"] })"

describe("PackageRunner Files.digest", () => {
  it("executes a non-Filegroup source dependency without treating its outputs as Filegroup members", async () => {
    const root = await fixture(
      "S.Filegroup({ srcs: [S.Shell.Build({ shell: \"mkdir -p dependency-out; printf hi > dependency-out/a.txt\", outDirs: [\"dependency-out\"] })] })",
      "[]"
    )
    const options = await optionsFor(root)
    const planned = await PackageExec.plan(options)
    const dependency = planned.workList.find((node) => node.rule === "Shell.Build")
    expect(dependency).toBeDefined()
    const result = await PackageExec.execute(planned, options)
    expect(await Fs.readFile(NodePath.join(root, "dependency-out/a.txt"), "utf8")).toBe("hi")
    expect(result.ok).toBe(true)
    expect(result.results).toHaveLength(3)
    expect(result.results.find((row) => row.label === dependency!.label)).toMatchObject({ status: "ran" })
    expect(result.results.find((row) => row.label === "//:producer")).toMatchObject({ status: "ran" })
    expect(result.results.find((row) => row.label === "//:check")).toMatchObject({ status: "ran" })
  })

  it("inventories a literal metacharacter output directory instead of matching a sibling name", async () => {
    const root = await fixture(
      "S.Shell.Build({ shell: \"mkdir -p 'dist[1]'; printf hi > 'dist[1]/a.txt'\", outDirs: [\"dist[1]\"] })",
      "[]"
    )
    await write(root, "dist1/decoy.txt", "bye")
    const empty = await run(root)
    expect(await Fs.readFile(NodePath.join(root, "dist[1]/a.txt"), "utf8")).toBe("hi")
    expect(await Fs.readFile(NodePath.join(root, "dist1/decoy.txt"), "utf8")).toBe("bye")
    expect(empty.results.find((row) => row.label === "//:producer"))
      .toMatchObject({ label: "//:producer", status: "ran" })
    expect(empty.ok).toBe(false)
    expect(empty.results.find((row) => row.label === "//:check"))
      .toMatchObject({ label: "//:check", status: "failed", error: "file digest differs from baseline.json" })
    await write(root, "baseline.json", baseline("dist[1]/a.txt"))
    const corrected = await run(root)
    expect(corrected.ok).toBe(true)
    expect(corrected.results.find((row) => row.label === "//:check"))
      .toMatchObject({ label: "//:check", status: "ran" })
    expect((await run(root)).results.find((row) => row.label === "//:check"))
      .toMatchObject({ label: "//:check", status: "hit" })
  })

  it("includes nested Filegroup sources and deduplicates a shared parent and child member", async () => {
    const root = await fixture(
      "S.Filegroup({ srcs: [S.file(\"//input.txt\"), S.Filegroup({ srcs: [S.file(\"//nested/z.txt\"), S.file(\"//input.txt\")] })] })",
      JSON.stringify([{ path: "input.txt", digest: hiDigest }, { path: "nested/z.txt", digest: hiDigest }])
    )
    await write(root, "nested/z.txt", "hi")
    const result = await run(root)
    expect(await Fs.readFile(NodePath.join(root, "input.txt"), "utf8")).toBe("hi")
    expect(await Fs.readFile(NodePath.join(root, "nested/z.txt"), "utf8")).toBe("hi")
    expect(result.ok).toBe(true)
    expect(result.results.find((row) => row.label === "//:check"))
      .toMatchObject({ label: "//:check", status: "ran" })
    expect((await run(root)).results.find((row) => row.label === "//:check"))
      .toMatchObject({ label: "//:check", status: "hit" })
    await write(root, "nested/z.txt", "bye")
    const changed = await run(root)
    expect(await Fs.readFile(NodePath.join(root, "nested/z.txt"), "utf8")).toBe("bye")
    expect(changed.ok).toBe(false)
    expect(changed.results.find((row) => row.label === "//:check"))
      .toMatchObject({ label: "//:check", status: "failed", error: "file digest differs from baseline.json" })
    await write(
      root,
      "baseline.json",
      JSON.stringify([{ path: "input.txt", digest: hiDigest }, { path: "nested/z.txt", digest: byeDigest }])
    )
    const recovered = await run(root)
    expect(recovered.ok).toBe(true)
    expect(recovered.results.find((row) => row.label === "//:check"))
      .toMatchObject({ label: "//:check", status: "ran" })
  })

  it.each(
    [
      ["subpackage output", "pkg", false, ["pkg/dist/a.txt", "pkg/dist/z.txt"]],
      ["gitignored root output", "", true, ["dist/a.txt", "dist/z.txt"]],
      ["gitignored subpackage output", "pkg", true, ["pkg/dist/a.txt", "pkg/dist/z.txt"]]
    ] as const
  )("includes owned directory files for %s", async (_name, packagePath, ignored, paths) => {
    const shell = packagePath === ""
      ? "mkdir -p dist; printf hi > dist/z.txt; printf hi > dist/a.txt"
      : "mkdir -p pkg/dist; printf hi > pkg/dist/z.txt; printf hi > pkg/dist/a.txt"
    const root = await fixture(
      `S.Shell.Build({ shell: ${JSON.stringify(shell)}, outDirs: ["dist"] })`,
      "[]",
      packagePath
    )
    if (ignored) await write(root, ".gitignore", packagePath === "" ? "dist/\n" : "pkg/dist/\n")
    const label = packagePath === "" ? "//:check" : "//pkg:check"
    const emptyBaseline = await run(root, label)
    for (const path of paths) expect(await Fs.readFile(NodePath.join(root, path), "utf8")).toBe("hi")
    expect(emptyBaseline.results.find((row) => row.label === (packagePath === "" ? "//:producer" : "//pkg:producer")))
      .toMatchObject({ status: "ran" })
    expect(emptyBaseline.ok).toBe(false)
    expect(emptyBaseline.results.find((row) => row.label === label))
      .toMatchObject({ label, status: "failed", error: "file digest differs from baseline.json" })
    await write(
      root,
      "baseline.json",
      JSON.stringify([
        { path: paths[0], digest: hiDigest },
        { path: paths[1], digest: hiDigest }
      ])
    )
    const completeBaseline = await run(root, label)
    expect(completeBaseline.ok).toBe(true)
    expect(completeBaseline.results.find((row) => row.label === label))
      .toMatchObject({ label, status: "ran" })
    expect((await run(root, label)).results.find((row) => row.label === label))
      .toMatchObject({ label, status: "hit" })
  })

  it("sorts and deduplicates a mixed output-directory and output-file digest", async () => {
    const root = await fixture(
      "S.Shell.Build({ shell: \"mkdir -p dist; printf hi > dist/z.txt; printf hi > dist/a.txt; printf hi > extra.txt\", outDirs: [\"dist\"], outFiles: [\"extra.txt\", \"dist/a.txt\"] })",
      JSON.stringify([
        { path: "dist/a.txt", digest: hiDigest },
        { path: "dist/z.txt", digest: hiDigest },
        { path: "extra.txt", digest: hiDigest }
      ])
    )
    const result = await run(root)
    for (const path of ["dist/a.txt", "dist/z.txt", "extra.txt"]) {
      expect(await Fs.readFile(NodePath.join(root, path), "utf8")).toBe("hi")
    }
    expect(result.ok).toBe(true)
    expect(result.results.find((row) => row.label === "//:check"))
      .toMatchObject({ label: "//:check", status: "ran" })
  })

  it("digests source globs with exclusions and overlapping explicit files", async () => {
    const root = await fixture(
      "S.Filegroup({ srcs: [S.glob(\"src/*.txt\", { exclude: [\"src/ignore.txt\"] }), S.file(\"//src/a.txt\")] })",
      JSON.stringify([{ path: "src/a.txt", digest: hiDigest }, { path: "src/z.txt", digest: hiDigest }])
    )
    await write(root, "src/z.txt", "hi")
    await write(root, "src/ignore.txt", "excluded bytes")
    await write(root, "src/a.txt", "hi")
    const result = await run(root)
    expect(result.ok).toBe(true)
    expect(result.results.find((row) => row.label === "//:check"))
      .toMatchObject({ label: "//:check", status: "ran" })
    expect(await Fs.readFile(NodePath.join(root, "src/ignore.txt"), "utf8")).toBe("excluded bytes")
  })

  it.each(
    [
      ["default package cwd", "S.Filegroup({ srcs: [S.file(\"input.txt\")] })", "pkg/input.txt"],
      [
        "explicit workspace cwd",
        "S.Filegroup({ srcs: [S.file(\"input.txt\")], cwd: \"sources\" })",
        "sources/input.txt"
      ]
    ] as const
  )("resolves a Filegroup using its %s", async (_name, producer, path) => {
    const root = await fixture(producer, baseline(path), "pkg")
    await write(root, path, "hi")
    const result = await run(root, "//pkg:check")
    expect(await Fs.readFile(NodePath.join(root, path), "utf8")).toBe("hi")
    expect(result.ok).toBe(true)
    expect(result.results.find((row) => row.label === "//pkg:check"))
      .toMatchObject({ label: "//pkg:check", status: "ran" })
  })

  it.each(
    [
      ["no declared sources", "S.Filegroup({ srcs: [] })"],
      ["unmatched source glob", "S.Filegroup({ srcs: [S.glob(\"absent/*.txt\")] })"]
    ] as const
  )("accepts an empty supported Filegroup with %s", async (_name, producer) => {
    const root = await fixture(producer, "[]")
    const result = await run(root)
    expect(result.ok).toBe(true)
    expect(result.results.find((row) => row.label === "//:check"))
      .toMatchObject({ label: "//:check", status: "ran" })
    expect((await run(root)).results.find((row) => row.label === "//:check"))
      .toMatchObject({ label: "//:check", status: "hit" })
  })

  it("invalidates a source-byte change and recovers only with the corrected baseline", async () => {
    const root = await fixture("S.Filegroup({ srcs: [S.file(\"//input.txt\")] })", baseline("input.txt"))
    expect((await run(root)).ok).toBe(true)
    expect((await run(root)).results.find((row) => row.label === "//:check"))
      .toMatchObject({ label: "//:check", status: "hit" })
    await write(root, "input.txt", "bye")
    const changed = await run(root)
    expect(changed.ok).toBe(false)
    expect(changed.results.find((row) => row.label === "//:check")).toMatchObject({
      label: "//:check",
      status: "failed",
      error: "file digest differs from baseline.json"
    })
    expect(await Fs.readFile(NodePath.join(root, "input.txt"), "utf8")).toBe("bye")
    await write(root, "baseline.json", JSON.stringify([{ path: "input.txt", digest: byeDigest }]))
    const recovered = await run(root)
    expect(recovered.ok).toBe(true)
    expect(recovered.results.find((row) => row.label === "//:check"))
      .toMatchObject({ label: "//:check", status: "ran" })
  })

  it("does not treat a missing explicit source as a successful empty file set", async () => {
    const root = await fixture("S.Filegroup({ srcs: [S.file(\"//missing.txt\")] })", "[]")
    await expect(Fs.stat(NodePath.join(root, "missing.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    const result = await run(root)
    expect(result.ok).toBe(false)
    expect(result.results.find((row) => row.label === "//:check"))
      .toMatchObject({ label: "//:check", status: "failed", error: "file digest differs from baseline.json" })
    await write(root, "baseline.json", "[{\"path\":\"missing.txt\",\"digest\":null}]")
    const absent = await run(root)
    expect(absent.ok).toBe(true)
    expect(absent.results.find((row) => row.label === "//:check"))
      .toMatchObject({ label: "//:check", status: "ran" })
    expect((await run(root)).results.find((row) => row.label === "//:check"))
      .toMatchObject({ label: "//:check", status: "hit" })
    await write(root, "missing.txt", "hi")
    const present = await run(root)
    expect(await Fs.readFile(NodePath.join(root, "missing.txt"), "utf8")).toBe("hi")
    expect(present.ok).toBe(false)
    expect(present.results.find((row) => row.label === "//:check"))
      .toMatchObject({ label: "//:check", status: "failed", error: "file digest differs from baseline.json" })
    await write(root, "baseline.json", baseline("missing.txt"))
    const recovered = await run(root)
    expect(recovered.ok).toBe(true)
    expect(recovered.results.find((row) => row.label === "//:check"))
      .toMatchObject({ label: "//:check", status: "ran" })
  })

  it("does not treat an uncreated declared product as a successful empty file set", async () => {
    const root = await fixture("S.Shell.Build({ shell: \"true\", outFiles: [\"missing.txt\"] })", "[]")
    const result = await run(root)
    expect(result.ok).toBe(false)
    expect(result.results.find((row) => row.label === "//:producer")).toMatchObject({
      label: "//:producer",
      status: "failed",
      error: "declared output file was not created: missing.txt"
    })
    expect(result.results.find((row) => row.label === "//:check"))
      .toMatchObject({ label: "//:check", status: "skipped", error: "dependency //:producer did not succeed" })
    await expect(Fs.stat(NodePath.join(root, "missing.txt"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each(
    [
      ["source Filegroup", "S.Filegroup({ srcs: [S.file(\"//input.txt\")] })", "input.txt"],
      ["Literal file", "S.Literal({ path: \"literal.txt\", content: \"hi\" })", "literal.txt"],
      ["Shell.Build file", "S.Shell.Build({ shell: \"printf hi > out.txt\", outFiles: [\"out.txt\"] })", "out.txt"],
      ["Shell.Build directory", directoryProducer, "dist/a.txt"]
    ] as const
  )("compares the actual bytes of a %s producer to an independent digest table", async (_name, producer, path) => {
    const root = await fixture(producer, baseline(path))
    const result = await run(root)
    expect(await Fs.readFile(NodePath.join(root, path), "utf8")).toBe("hi")
    expect(result.results.find((row) => row.label === "//:producer"))
      .toMatchObject({ label: "//:producer", status: "ran" })
    expect(result.ok).toBe(true)
    expect(result.results.find((row) => row.label === "//:check"))
      .toMatchObject({ label: "//:check", status: "ran" })
    const cached = await run(root)
    expect(cached.ok).toBe(true)
    expect(cached.results.find((row) => row.label === "//:check"))
      .toMatchObject({ label: "//:check", status: "hit" })
  })

  it("reports malformed baseline JSON and retries after the baseline is repaired", async () => {
    const root = await fixture(directoryProducer, "{")
    const failed = await run(root)
    expect(failed.ok).toBe(false)
    expect(failed.results.find((row) => row.label === "//:check")).toMatchObject({
      label: "//:check",
      status: "failed",
      error:
        "could not read digest baseline baseline.json: Expected property name or '}' in JSON at position 1 (line 1 column 2)"
    })
    expect(await Fs.readFile(NodePath.join(root, "dist/a.txt"), "utf8")).toBe("hi")
    await write(root, "baseline.json", baseline("dist/a.txt"))
    const recovered = await run(root)
    expect(recovered.ok).toBe(true)
    expect(recovered.results.find((row) => row.label === "//:check"))
      .toMatchObject({ label: "//:check", status: "ran" })
  })

  it("reports a baseline removed after planning and retries after it is restored", async () => {
    const root = await fixture(directoryProducer, baseline("dist/a.txt"))
    const options = await optionsFor(root)
    const planned = await PackageExec.plan(options)
    const path = NodePath.join(root, "baseline.json")
    await Fs.rm(path)
    const failed = await PackageExec.execute(planned, options)
    expect(failed.ok).toBe(false)
    expect(failed.results.find((row) => row.label === "//:check")).toMatchObject({
      label: "//:check",
      status: "failed",
      error: `could not read digest baseline baseline.json: ENOENT: no such file or directory, open '${path}'`
    })
    await write(root, "baseline.json", baseline("dist/a.txt"))
    const recovered = await run(root)
    expect(recovered.ok).toBe(true)
    expect(recovered.results.find((row) => row.label === "//:check"))
      .toMatchObject({ label: "//:check", status: "ran" })
  })
})
