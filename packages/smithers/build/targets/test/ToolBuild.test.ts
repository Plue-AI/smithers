/**
 * The `ToolBuild` target itself, and output measurement, the shared step every
 * producing build target ends with.
 *
 * The construction cases pin what a declaration alone decides: which attrs
 * admit a cache entry, which paths the target promises, and the argv and
 * environment its body plans. The measurement cases pin the containment
 * decisions directly, because a link planted below a declared output, or an
 * ancestor that is itself a link, is awkward to arrange through a whole build
 * and is exactly what must not be followed.
 */
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"
import {
  measureOutput,
  measureOutputs,
  OutputError,
  readOutputManifest,
  ToolBuild,
  verifyOutputs
} from "../src/ToolBuild.ts"
import { plannedCalls } from "./plan.ts"

let root: string
let outside: string

const posixOnly = process.platform !== "win32"

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-outputs-"))
  outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-outside-"))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
  await Fs.rm(outside, { recursive: true, force: true })
})

describe("ToolBuild", () => {
  const dependency = ToolBuild({
    tool: "cbindgen",
    command: "cbindgen",
    args: ["--output", "include/native.h"],
    inputs: [],
    outputs: ["include/native.h"],
    deps: [],
    env: {},
    cache: true
  })

  const base = {
    tool: "cargo",
    command: "cargo",
    args: ["build", "--release"],
    inputs: [Input.file("Cargo.toml")],
    outputs: ["target/release/libnative.a"],
    deps: [dependency],
    env: { CARGO_TERM_COLOR: "never" }
  }

  it("declares a cacheable build target whose outputs hang off its own cwd", () => {
    const metadata = Target.metadata(ToolBuild({ ...base, cache: true, cwd: "packages/native" }))
    expect(metadata.target).toBe("ToolBuild")
    expect(metadata.kinds).toEqual(["build"])
    expect(metadata.cacheable).toBe(true)
    expect(metadata.outputs).toEqual({ cwd: "packages/native", paths: ["target/release/libnative.a"] })
    expect(metadata.inputs).toContainEqual(Input.file("Cargo.toml"))
    expect(metadata.dependencies).toContain(dependency)
  })

  it("admits the cache from the declaration, so a tool that is not reproducible never replays", () => {
    // `cache: (attrs) => attrs.cache` is the whole admission rule: the same
    // command, inputs and outputs are cacheable or not purely by declaration.
    const uncached = Target.metadata(ToolBuild({ ...base, cache: false, cwd: "packages/native" }))
    expect(uncached.cacheable).toBe(false)
    expect(uncached.outputs).toEqual({ cwd: "packages/native", paths: ["target/release/libnative.a"] })
  })

  it("defaults cwd to the workspace root, so a declaration without one still names where its outputs land", () => {
    const target = ToolBuild({ ...base, cache: true })
    expect(Target.metadata(target).outputs).toEqual({ cwd: ".", paths: ["target/release/libnative.a"] })
    expect(plannedCalls(target)[0]?.payload["cwd"]).toBe(".")
  })

  it("plans the command ahead of its args and captures the declared outputs after it", () => {
    const calls = plannedCalls(ToolBuild({ ...base, cache: true, cwd: "packages/native" }))
    expect(calls).toHaveLength(2)
    expect(calls[0]?.action).toBe("smithers-build/exec")
    expect(calls[0]?.payload["argv"]).toEqual(["cargo", "build", "--release"])
    expect(calls[0]?.payload["cwd"]).toBe("packages/native")
    expect(calls[0]?.payload["env"]).toEqual({ CARGO_TERM_COLOR: "never" })
    expect(calls[1]?.action).toBe("smithers-build/capture-outputs")
    expect(calls[1]?.payload).toEqual({ cwd: "packages/native", paths: ["target/release/libnative.a"] })
  })

  it("refuses a declaration with no command", () => {
    expect(() => ToolBuild({ ...base, command: "", cache: true })).toThrow()
  })

  it.each(
    [
      [undefined, 600_000],
      ["90m", 5_400_000],
      ["120m", 7_200_000],
      ["1ms", 1],
      ["24h", Exec.maximumTimeoutMs]
    ] as const
  )("plans a bounded build deadline %s without changing output capture", (timeout, milliseconds) => {
    const target = ToolBuild({
      ...base,
      cache: false,
      ...(timeout === undefined ? {} : { timeout })
    })
    const calls = plannedCalls(target)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.action).toBe("smithers-build/exec")
    expect(Exec.Payload.make(calls[0]!.payload as never).timeoutMs).toBe(milliseconds)
    expect(calls[0]?.payload["argv"]).toEqual(["cargo", "build", "--release"])
    expect(calls[1]).toEqual({
      action: "smithers-build/capture-outputs",
      payload: { cwd: ".", paths: ["target/release/libnative.a"] }
    })
    expect(Target.metadata(target).cacheable).toBe(false)
  })

  it.each(["unbounded", "0ms", "-1s", "1.5m", "25h", "86400001ms", `${"9".repeat(400)}s`])(
    "refuses an invalid build deadline %s at declaration",
    (timeout) => {
      expect(() => ToolBuild({ ...base, cache: true, timeout })).toThrow()
    }
  )
})

describe("measureOutput", () => {
  it("digests a plain file", async () => {
    await write("out/artifact.txt", "built")
    expect(await measureOutput(root, ".", "out/artifact.txt")).toMatchObject({
      path: "out/artifact.txt",
      fileCount: 1
    })
  })

  it("digests a directory in sorted order, whatever the creation order", async () => {
    await write("first/b.txt", "b")
    await write("first/nested/c.txt", "c")
    await write("first/a.txt", "a")
    await write("second/a.txt", "a")
    await write("second/b.txt", "b")
    await write("second/nested/c.txt", "c")

    const first = await measureOutput(root, ".", "first")
    const second = await measureOutput(root, ".", "second")

    expect(first.fileCount).toBe(3)
    expect(first.contentDigest).toBe(second.contentDigest)
  })

  /**
   * The regression: entries sorted with `localeCompare`, whose answer depends
   * on the host locale and ICU version. In an English locale `a.txt` sorts
   * before `Z.txt`, by code unit `Z.txt` (0x5A) sorts before `a.txt` (0x61),
   * and other locales order differently again, so one tree digested to
   * different values on different machines. The digest is pinned to the
   * code-unit order here.
   */
  it("digests in code-unit order, independent of the host locale", async () => {
    const sha = (value: string): string => createHash("sha256").update(value).digest("hex")
    await write("out/a.txt", "lower")
    await write("out/Z.txt", "upper")

    const measured = await measureOutput(root, ".", "out")

    const pairs = [
      ["file", "Z.txt", false, sha("upper")],
      ["file", "a.txt", false, sha("lower")]
    ]
    expect(measured.contentDigest).toBe(sha(JSON.stringify(pairs)))
  })

  it("accepts an empty directory", async () => {
    await Fs.mkdir(NodePath.join(root, "out"), { recursive: true })
    expect(await measureOutput(root, ".", "out")).toMatchObject({ path: "out", fileCount: 0 })
  })

  it("resolves the declared path against cwd", async () => {
    await write("packages/alpha/dist/index.js", "export {}")
    expect(await measureOutput(root, "packages/alpha", "dist")).toMatchObject({ path: "dist", fileCount: 1 })
  })

  it("fails when the output was not created", async () => {
    await expect(measureOutput(root, ".", "out")).rejects.toBeInstanceOf(OutputError)
    await expect(measureOutput(root, ".", "out")).rejects.toMatchObject({
      path: "out",
      message: "declared output was not created: out"
    })
  })

  it("fails when the declared path leaves the workspace", async () => {
    await Fs.writeFile(NodePath.join(outside, "secret.txt"), "not ours", "utf8")
    // Refused either as a lexical escape from the declaring directory or as an
    // escape from the workspace; both are the same verdict for the same path.
    await expect(measureOutput(root, ".", `../${NodePath.basename(outside)}/secret.txt`))
      .rejects.toMatchObject({ message: expect.stringMatching(/leaves the (workspace|directory)/) })
    await expect(measureOutput(root, ".", NodePath.join(outside, "secret.txt")))
      .rejects.toMatchObject({ message: expect.stringMatching(/leaves the workspace|is absolute/) })
  })

  it("fails on a symbolic link below a declared directory instead of following it", async () => {
    await Fs.writeFile(NodePath.join(outside, "secret.txt"), "not ours", "utf8")
    await Fs.mkdir(NodePath.join(root, "out"), { recursive: true })
    await Fs.symlink(NodePath.join(outside, "secret.txt"), NodePath.join(root, "out/linked.txt"))

    await expect(measureOutput(root, ".", "out")).rejects.toMatchObject({
      path: "out",
      message: expect.stringContaining("contains a symbolic link")
    })
  })

  it("fails when the declared path resolves outside through a linked ancestor", async () => {
    await Fs.mkdir(NodePath.join(outside, "escaped"), { recursive: true })
    await Fs.writeFile(NodePath.join(outside, "escaped/artifact.txt"), "not ours", "utf8")
    // `out` looks like an in-workspace directory and is not itself the declared
    // output; the declared output is a real file below it, in another tree.
    await Fs.symlink(NodePath.join(outside, "escaped"), NodePath.join(root, "out"))

    await expect(measureOutput(root, ".", "out/artifact.txt")).rejects.toMatchObject({
      message: expect.stringContaining("resolves outside the workspace")
    })
  })

  it.runIf(posixOnly)("fails when the output is neither a file nor a directory", async () => {
    const { execFile } = await import("node:child_process")
    await new Promise<void>((resolve, reject) => {
      execFile("mkfifo", [NodePath.join(root, "out")], (error) => error === null ? resolve() : reject(error))
    })

    await expect(measureOutput(root, ".", "out")).rejects.toMatchObject({
      message: "declared output is not a file or a directory: out"
    })
  })
})

describe("measureOutputs", () => {
  it("measures every declared output in declaration order", async () => {
    await write("one.txt", "1")
    await write("two/inner.txt", "2")

    expect((await measureOutputs(root, ".", ["two", "one.txt"])).outputs.map((entry) => entry.path))
      .toEqual(["two", "one.txt"])
  })

  it("fails the whole capture when any one output is missing", async () => {
    await write("one.txt", "1")

    await expect(measureOutputs(root, ".", ["one.txt", "missing"])).rejects.toMatchObject({
      path: "missing"
    })
  })
})

/**
 * The manifest contract, checked directly.
 *
 * A manifest arrives either from a target implementation's success payload or
 * from a cache entry that another machine, a shared store, or a hand edit
 * wrote. Neither is trusted, and the declaration it is checked against always
 * comes from target metadata rather than from the value being checked.
 */
describe("readOutputManifest", () => {
  const declared: Target.DeclaredOutputs = { cwd: ".", paths: ["dist", "types"] }
  const entry = (path: string): Record<string, unknown> => ({
    path,
    fileCount: 1,
    contentDigest: "a".repeat(64)
  })

  it("accepts an exact, ordered manifest", () => {
    const outputs = [entry("dist"), entry("types")]
    expect(readOutputManifest(declared, { outputs })).toEqual({ outputs })
  })

  it.each([
    ["no manifest at all", { ok: true }],
    ["a null value", null],
    ["a manifest that is not a list", { outputs: "dist" }],
    ["an omitted output", { outputs: [entry("dist")] }],
    ["an extra output", { outputs: [entry("dist"), entry("types"), entry("extra")] }],
    ["a reordered manifest", { outputs: [entry("types"), entry("dist")] }],
    ["a duplicated output", { outputs: [entry("dist"), entry("dist")] }],
    ["a forged path", { outputs: [entry("dist"), entry("../../etc")] }],
    ["a bare string entry", { outputs: ["dist", "types"] }],
    ["a fractional file count", { outputs: [{ ...entry("dist"), fileCount: 0.5 }, entry("types")] }],
    ["a negative file count", { outputs: [{ ...entry("dist"), fileCount: -1 }, entry("types")] }],
    ["a non-finite file count", { outputs: [{ ...entry("dist"), fileCount: Number.NaN }, entry("types")] }],
    ["a file count that is a string", { outputs: [{ ...entry("dist"), fileCount: "1" }, entry("types")] }],
    ["a short digest", { outputs: [{ ...entry("dist"), contentDigest: "abc" }, entry("types")] }],
    ["an uppercase digest", { outputs: [{ ...entry("dist"), contentDigest: "A".repeat(64) }, entry("types")] }]
  ])("refuses %s", (_name, value) => {
    expect(typeof readOutputManifest(declared, value)).toBe("string")
  })

  it("accepts an empty manifest for a target that declares no paths", () => {
    expect(readOutputManifest({ cwd: ".", paths: [] }, { outputs: [] })).toEqual({ outputs: [] })
  })

  it("accepts a void success for a target that declares no paths", () => {
    // A generator in check mode writes nothing and declares nothing, so its
    // success value is void; there is no tree to verify a manifest against.
    expect(readOutputManifest({ cwd: ".", paths: [] }, undefined)).toEqual({ outputs: [] })
  })

  it("refuses a fabricated result for a target that declares no paths", () => {
    expect(typeof readOutputManifest({ cwd: ".", paths: [] }, { ok: true })).toBe("string")
  })

  it("refuses accessor, sparse, extra, symbol, and proxy shapes without invoking accessors", () => {
    let invocations = 0
    const accessor = {}
    Object.defineProperty(accessor, "outputs", {
      get: () => {
        invocations += 1
        return []
      },
      enumerable: true
    })
    const sparse = [entry("dist"), entry("types")]
    delete sparse[0]
    Object.assign(sparse, { extra: entry("dist") })
    const symbol = { outputs: [entry("dist"), entry("types")], [Symbol("extra")]: true }
    const extra = { outputs: [entry("dist"), entry("types")], extra: true }
    const proxy = new Proxy({ outputs: [entry("dist"), entry("types")] }, {
      ownKeys: (target) => {
        invocations += 1
        return Reflect.ownKeys(target)
      }
    })

    for (const value of [accessor, { outputs: sparse }, symbol, extra, proxy]) {
      expect(readOutputManifest(declared, value)).toBeTypeOf("string")
    }
    expect(invocations).toBe(0)
  })

  it("refuses negative zero as a file count", () => {
    expect(readOutputManifest(declared, {
      outputs: [{ ...entry("dist"), fileCount: -0 }, entry("types")]
    })).toBeTypeOf("string")
  })
})

describe("verifyOutputs", () => {
  it("agrees with a manifest the tree still satisfies", async () => {
    await write("dist/a.txt", "a")
    const declared: Target.DeclaredOutputs = { cwd: ".", paths: ["dist"] }
    const measured = await measureOutputs(root, ".", ["dist"])

    expect(await verifyOutputs(root, declared, measured)).toBeUndefined()
  })

  it("reports a manifest whose tree changed underneath it", async () => {
    await write("dist/a.txt", "a")
    const declared: Target.DeclaredOutputs = { cwd: ".", paths: ["dist"] }
    const measured = await measureOutputs(root, ".", ["dist"])
    await write("dist/a.txt", "edited")

    expect(await verifyOutputs(root, declared, measured)).toMatch(/no longer matches/)
  })

  it("reports a declared output that was never produced", async () => {
    expect(
      await verifyOutputs(root, { cwd: ".", paths: ["dist"] }, {
        outputs: [{ path: "dist", fileCount: 0, contentDigest: "a".repeat(64) }]
      })
    ).toMatch(/could not be measured/)
  })
})

describe("Target.declaredOutputs", () => {
  it("refuses a declaration naming one path twice", () => {
    // The manifest contract is an exact positional match and refuses
    // duplicates, so a target declaring one twice could never be satisfied.
    // Reporting it where it is declared beats failing at every execution.
    expect(() => Target.declaredOutputs("Example", { cwd: ".", paths: ["dist", "dist"] }))
      .toThrow(/Example declared outputs it cannot produce/)
  })

  it.each([
    ["an empty cwd", { cwd: "", paths: ["dist"] }],
    ["an empty path", { cwd: ".", paths: [""] }]
  ])("refuses %s", (_name, value) => {
    expect(() => Target.declaredOutputs("Example", value)).toThrow()
  })
})

describe("concurrent capture", () => {
  /**
   * Recomputes the manifest digest independently of the implementation: the
   * sorted list of entries, hashed as JSON. If the concurrent pool ever let
   * completion order, a stale buffer, or a misfiled slot into the result, this
   * oracle disagrees.
   */
  const expectedDigest = async (
    directory: string,
    entries: ReadonlyArray<readonly [kind: "directory" | "file", relative: string]>
  ): Promise<string> => {
    const manifest = await Promise.all(entries.map(async ([kind, relative]) => {
      if (kind === "directory") return ["directory", relative] as const
      const contents = await Fs.readFile(NodePath.join(directory, relative))
      return ["file", relative, false, createHash("sha256").update(contents).digest("hex")] as const
    }))
    const sorted = [...manifest].sort((left, right) => left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0)
    return createHash("sha256").update(JSON.stringify(sorted)).digest("hex")
  }

  it("digests a tree wider than the worker pool exactly as a serial pass would", async () => {
    // 200 files multiplexes across the 32 workers many times over, so a
    // shared-buffer or misfiled-slot regression cannot hide behind a tree
    // small enough to drain in one wave.
    const names = Array.from({ length: 200 }, (_, index) => `file-${String(index).padStart(3, "0")}.txt`)
    for (const name of names) await write(`wide/${name}`, `contents of ${name}`)
    const measured = await measureOutput(root, ".", "wide")
    expect(measured.fileCount).toBe(200)
    expect(measured.contentDigest).toBe(
      await expectedDigest(NodePath.join(root, "wide"), names.map((name) => ["file", name] as const))
    )
  })

  it("digests nested directories and files identically to the oracle", async () => {
    await write("tree/a.txt", "a")
    await write("tree/nested/b.txt", "b")
    await write("tree/nested/deeper/c.txt", "c")
    for (let index = 0; index < 40; index += 1) await write(`tree/nested/bulk-${index}.txt`, `bulk ${index}`)
    const measured = await measureOutput(root, ".", "tree")
    expect(measured.contentDigest).toBe(
      await expectedDigest(NodePath.join(root, "tree"), [
        ["file", "a.txt"],
        ["directory", "nested"],
        ["file", "nested/b.txt"],
        ["directory", "nested/deeper"],
        ["file", "nested/deeper/c.txt"],
        ...Array.from({ length: 40 }, (_, index) => ["file", `nested/bulk-${index}.txt`] as const)
      ])
    )
  })

  it("is deterministic across repeated captures of one tree", async () => {
    for (let index = 0; index < 120; index += 1) await write(`repeat/f-${index}.txt`, `payload ${index}`)
    const digests = new Set<string>()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      digests.add((await measureOutput(root, ".", "repeat")).contentDigest)
    }
    expect([...digests]).toHaveLength(1)
  })

  it("still refuses the earliest symbolic link before any file is hashed", async () => {
    for (let index = 0; index < 60; index += 1) await write(`fail/f-${String(index).padStart(2, "0")}.txt`, "x")
    // Deferring the reads must not defer this rejection: a link is refused
    // during the ordered walk, before the pool runs, and the earliest one in
    // traversal order is still the one reported.
    await Fs.symlink(NodePath.join(root, "fail/f-00.txt"), NodePath.join(root, "fail/f-10.link"))
    await Fs.symlink(NodePath.join(root, "fail/f-00.txt"), NodePath.join(root, "fail/f-50.link"))
    await expect(measureOutput(root, ".", "fail")).rejects.toThrow(/f-10\.link/)
  })
})
