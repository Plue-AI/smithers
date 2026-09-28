/**
 * Composition declarations and the executable file-set plans they produce.
 *
 * These cases pin the distinct-node contracts of aliases and materialization,
 * the resolver inputs exposed by import closures, and every refusal by which
 * file algebra avoids silently treating an unsupported target as an empty set.
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { constants as NodeFsConstants } from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof Fs>() }))
import * as Compose from "../src/Compose.ts"
import * as Filegroup from "../src/Filegroup.ts"
import * as Input from "../src/Input.ts"
import * as Reference from "../src/Reference.ts"
import * as Shell from "../src/Shell.ts"
import * as Target from "../src/Target.ts"
import { plannedCalls } from "./plan.ts"

const command = Shell.Test({ shell: "true" })

describe("composition wrappers", () => {
  it("gives an alias its own node while preserving the target kinds and dependency", () => {
    const alias = Compose.Alias(command)

    expect(alias).not.toBe(command)
    expect(Target.metadata(alias).kinds).toEqual(Target.metadata(command).kinds)
    expect(Target.metadata(alias).dependencies).toEqual([command])
    expect(plannedCalls(alias)).toEqual([
      { action: "smithers-build/not-implemented", payload: { target: "Alias" } }
    ])
  })

  it("materializes only the target it names", () => {
    const materialized = Compose.Materialize(command)

    expect(Target.metadata(materialized).dependencies).toEqual([command])
    expect(plannedCalls(materialized)).toEqual([
      { action: "smithers-build/not-implemented", payload: { target: "Materialize" } }
    ])
  })

  it("keeps suite members and clean targets as dependency edges", () => {
    const suite = Compose.Suite({ tests: [command] })
    const clean = Compose.Clean({ targets: [command], paths: ["dist"] })

    expect(Target.metadata(suite).dependencies).toEqual([command])
    expect(plannedCalls(suite)[0]?.payload).toEqual({ target: "Suite" })
    expect(Target.metadata(clean).dependencies).toEqual([command])
    expect(plannedCalls(clean)[0]?.payload).toEqual({ target: "Clean" })
  })

  it.each([
    ["Alias", () => Compose.Alias(42 as never), "Alias requires a target"],
    ["Materialize", () => Compose.Materialize(42 as never), "Materialize requires a target"]
  ])("refuses a non-target passed to %s", (_name, operation, message) => {
    expect(operation).toThrow(TypeError)
    expect(operation).toThrow(message)
  })
})

describe("Generate plans", () => {
  it("plans bin and command forms while refusing an executor-owned emit form", () => {
    const bin = Reference.NodeModule.Bin("formatter", "format")
    const binCall = plannedCalls(Compose.Generate({ bin, args: ["--write"], changes: ["out.txt"] }))[0]
    expect(binCall?.action).toBe("smithers-build/exec")
    expect(binCall?.payload["argv"]).toEqual([Shell.toolToken(bin), "--write"])

    const commandCall = plannedCalls(Compose.Generate({ command: "printf generated", changes: ["out.txt"] }))[0]
    expect(commandCall?.action).toBe("smithers-build/exec")
    expect(commandCall?.payload["argv"]).toEqual(["/bin/sh", "-c", "printf generated"])

    expect(plannedCalls(Compose.Generate({ emit: { "out.txt": "generated" } }))).toEqual([
      { action: "smithers-build/not-implemented", payload: { target: "Generate" } }
    ])
  })

  it("refuses a declaration that names no executable form or more than one", () => {
    // The four forms are alternatives, not a precedence list: a declaration
    // that names none has nothing to run, and one that names two leaves the
    // executor to guess which the author meant.
    expect(() => Compose.Generate({ changes: ["out.txt"] })).toThrow(
      "Generate requires exactly one of emit, script, bin, command; received none"
    )
    expect(() =>
      Compose.Generate({
        command: "printf generated",
        script: { path: "out.ts" },
        changes: ["out.txt"]
      })
    ).toThrow(
      "Generate requires exactly one of emit, script, bin, command; received script, command"
    )
  })
})

describe("Files declarations", () => {
  it.each([
    [42, command],
    [command, { _tag: "TargetFiles", target: 42 }]
  ])("refuses a difference with an invalid operand", (left, right) => {
    expect(() => Compose.Files.difference(left as never, right as never)).toThrow(TypeError)
    expect(() => Compose.Files.difference(left as never, right as never))
      .toThrow("Files.difference operands must be targets or target .files references")
  })

  it("exposes an import closure through a non-enumerable immutable files reference", () => {
    const closure = Compose.ImportClosure({ entries: Input.file("src/index.ts") })
    const descriptor = Object.getOwnPropertyDescriptor(closure, "files")

    expect(descriptor).toMatchObject({ configurable: false, enumerable: false, writable: false })
    expect(closure.files).toEqual({ _tag: "TargetFiles", target: closure })
    expect(Object.isFrozen(closure.files)).toBe(true)
    expect(Compose.isImportClosure(closure)).toBe(true)
    expect(Compose.isImportClosure(command)).toBe(false)
  })
})

describe("ImportClosure", () => {
  it("resolves files and globs against an explicit filegroup cwd", () => {
    const entries = Filegroup.Filegroup({
      cwd: "packages/app",
      srcs: [
        Input.file("src/index.ts"),
        Input.glob("src/**/*.ts", { exclude: ["src/**/*.test.ts"] })
      ]
    })
    const closure = Compose.ImportClosure({ entries })

    expect(plannedCalls(closure)).toEqual([
      {
        action: "smithers-build/import-closure",
        payload: {
          entries: [
            { base: "", source: { _tag: "File", path: "packages/app/src/index.ts" } },
            {
              base: "",
              source: {
                _tag: "Glob",
                pattern: "packages/app/src/**/*.ts",
                exclude: ["packages/app/src/**/*.test.ts"]
              }
            }
          ]
        }
      }
    ])
  })

  it("refuses a target that cannot expose entry files", () => {
    const closure = Compose.ImportClosure({ entries: command })

    expect(plannedCalls(closure)).toEqual([
      {
        action: "smithers-build/not-implemented",
        payload: { target: "ImportClosure: target Shell.Test cannot provide entry files yet" }
      }
    ])
  })

  it("anchors direct sources at the declaration context supplied by the caller", () => {
    expect(Compose.closureEntrySources(
      [Input.file("index.ts"), Input.glob("src/**/*.ts")],
      { sourceFile: "/workspace/packages/app/PACKAGE.ts", packageDirectory: "/workspace/packages/app" }
    )).toEqual([
      { base: "/workspace/packages/app", source: Input.file("index.ts") },
      { base: "/workspace/packages/app", source: Input.glob("src/**/*.ts") }
    ])
  })
})

describe("file-set checks", () => {
  const left = Filegroup.Filegroup({ cwd: "packages/app", srcs: [Input.glob("src/**/*.ts")] })
  const right = Filegroup.Filegroup({ cwd: "packages/app", srcs: [Input.glob("src/**/*.test.ts")] })

  it("plans the difference action for two resolvable source sets", () => {
    const target = Compose.Test({ expect: Compose.Files.difference(left, right), toBe: "empty" })

    expect(plannedCalls(target)).toEqual([
      {
        action: "smithers-build/files-difference",
        payload: {
          left: {
            _tag: "SourceSet",
            sources: [{ base: "", source: Input.glob("packages/app/src/**/*.ts") }]
          },
          right: {
            _tag: "SourceSet",
            sources: [{ base: "", source: Input.glob("packages/app/src/**/*.test.ts") }]
          },
          toBe: "empty"
        }
      }
    ])
  })

  it("reduces both an import closure and its .files reference to closure entries", () => {
    const closure = Compose.ImportClosure({ entries: left })
    const expected = {
      _tag: "Closure",
      entries: [{ base: "", source: Input.glob("packages/app/src/**/*.ts") }]
    }

    expect(Compose.checkOperand(closure)).toEqual(expected)
    expect(Compose.checkOperand(closure.files)).toEqual(expected)
  })

  it("names unsupported operands instead of treating them as empty", () => {
    expect(Compose.checkOperand(command)).toBe("target Shell.Test does not expose a resolvable file set yet")

    const leftUnsupported = Compose.Test({
      expect: Compose.Files.difference(command, right),
      toBe: "empty"
    })
    expect(plannedCalls(leftUnsupported)[0]?.payload).toEqual({
      target: "Test: target Shell.Test does not expose a resolvable file set yet"
    })

    const rightUnsupported = Compose.Test({
      expect: Compose.Files.difference(left, command),
      toBe: "empty"
    })
    expect(plannedCalls(rightUnsupported)[0]?.payload).toEqual({
      target: "Test: target Shell.Test does not expose a resolvable file set yet"
    })
  })

  it("leaves digest and manifest comparisons to the build system", () => {
    const digest = Compose.Test({ expect: Compose.Files.digest(left), toBe: "empty" })
    const manifest = Compose.Test({
      expect: Compose.Files.difference(left, right),
      toBe: Input.file("expected-files.json")
    })

    expect(plannedCalls(digest)[0]?.payload).toEqual({
      target: "Test: Files.digest comparison is executed by the build system"
    })
    expect(plannedCalls(manifest)[0]?.payload).toEqual({
      target: "Test: a file-set difference can only compare to empty"
    })
  })
})

describe("generator backup recovery and bounds", () => {
  const temporary: Array<string> = []
  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(temporary.splice(0).map((path) => Fs.rm(path, { recursive: true, force: true })))
  })
  const directory = async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "targets-backup-test-")))
    temporary.push(root)
    return root
  }
  const check = (root: string, program: string, changes = ["out"], snapshotLimits = {}) =>
    Effect.runPromiseExit(Compose.checkGenerator({ workspaceRoot: root, snapshotLimits }, {
      run: {
        argv: [process.execPath, "-e", program],
        cwd: ".",
        env: {},
        secrets: [],
        expectedExitCodes: [0],
        timeoutMs: 30_000
      },
      changes
    } as never))

  it.each(["file", "symlink"])("restores a declared directory replaced by a %s", async (kind) => {
    const root = await directory()
    const outside = await directory()
    await Fs.mkdir(NodePath.join(root, "out/nested"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "out/nested/original.txt"), "irreplaceable bytes")
    await Fs.chmod(NodePath.join(root, "out/nested/original.txt"), 0o640)
    await Fs.writeFile(NodePath.join(outside, "sentinel.txt"), "untouched")
    const replace = kind === "file"
      ? "fs.writeFileSync('out', 'replacement')"
      : `fs.symlinkSync(${JSON.stringify(outside)}, 'out')`
    const exit = await check(root, `const fs = require('node:fs'); fs.rmSync('out', { recursive: true }); ${replace}`, [
      "out",
      "out/nested/original.txt"
    ])
    expect(Exit.isFailure(exit)).toBe(true)
    expect((await Fs.lstat(NodePath.join(root, "out"))).isDirectory()).toBe(true)
    expect(await Fs.readFile(NodePath.join(root, "out/nested/original.txt"), "utf8")).toBe("irreplaceable bytes")
    expect((await Fs.stat(NodePath.join(root, "out/nested/original.txt"))).mode & 0o777).toBe(0o640)
    expect(await Fs.readdir(outside)).toEqual(["sentinel.txt"])
    expect(await Fs.readFile(NodePath.join(outside, "sentinel.txt"), "utf8")).toBe("untouched")
  })

  it("bounds open descriptors while snapshotting many files", async () => {
    const root = await directory()
    await Fs.mkdir(NodePath.join(root, "out"))
    for (let index = 0; index < 80; index++) await Fs.writeFile(NodePath.join(root, `out/${index}.txt`), "bytes")
    const open = Fs.open
    let active = 0
    let peak = 0
    vi.spyOn(Fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args)
      active += 1
      peak = Math.max(peak, active)
      const close = handle.close.bind(handle)
      vi.spyOn(handle, "close").mockImplementation(async () => {
        try {
          await close()
        } finally {
          active -= 1
        }
      })
      return handle
    })
    expect(Exit.isSuccess(await check(root, "void 0"))).toBe(true)
    expect(active).toBe(0)
    expect(peak).toBeLessThanOrEqual(16)
  })

  it.each([
    { fileBytes: -1 },
    { totalBytes: -1 },
    { fileBytes: NaN },
    { totalBytes: 1.5 },
    { fileBytes: 256 * 1024 * 1024 + 1 },
    { totalBytes: 1024 * 1024 * 1024 + 1 }
  ])("refuses invalid snapshot budgets without starting the generator: %j", async (limits) => {
    const root = await directory()
    const result = await check(root, "require('node:fs').writeFileSync('ran', 'yes')", ["out"], limits)
    expect(Exit.isFailure(result)).toBe(true)
    expect(JSON.stringify(result)).toContain("must be an integer")
    await expect(Fs.stat(NodePath.join(root, "ran"))).rejects.toThrow()
  })

  it("restores a symlink changed by the generator without modifying either target", async () => {
    const root = await directory()
    await Fs.writeFile(NodePath.join(root, "a"), "original")
    await Fs.writeFile(NodePath.join(root, "b"), "other")
    await Fs.symlink("a", NodePath.join(root, "out"))
    const result = await check(root, "const fs=require('node:fs');fs.unlinkSync('out');fs.symlinkSync('b','out')")
    expect(Exit.isFailure(result)).toBe(true)
    expect(await Fs.readlink(NodePath.join(root, "out"))).toBe("a")
    expect(await Fs.readFile(NodePath.join(root, "a"), "utf8")).toBe("original")
    expect(await Fs.readFile(NodePath.join(root, "b"), "utf8")).toBe("other")
  })

  it("reports a generator that appends a line at the end of a checked-in file", async () => {
    const root = await directory()
    await Fs.writeFile(NodePath.join(root, "out"), "first")
    const exit = await check(root, "require('node:fs').writeFileSync('out', 'first\\nsecond')")
    expect(Exit.isFailure(exit)).toBe(true)
    const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
    expect(message).toContain("first difference at line 2: (end of file) became \"second\"")
    expect(await Fs.readFile(NodePath.join(root, "out"), "utf8")).toBe("first")
  })

  it("bounds the differing-line excerpt and restores long checked-in text", async () => {
    const root = await directory()
    const previous = "x".repeat(240)
    const current = "y".repeat(240)
    await Fs.writeFile(NodePath.join(root, "out"), previous)
    const exit = await check(root, `require('node:fs').writeFileSync('out', ${JSON.stringify(current)})`)
    expect(Exit.isFailure(exit)).toBe(true)
    const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
    expect(message).toContain(`first difference at line 1: "${"x".repeat(200)}..." became "${"y".repeat(200)}..."`)
    expect(message).not.toContain("x".repeat(240))
    expect(message).not.toContain("y".repeat(240))
    expect(await Fs.readFile(NodePath.join(root, "out"), "utf8")).toBe(previous)
  })

  it("rejects a non-directory ancestor before running a generator", async () => {
    const root = await directory()
    await Fs.writeFile(NodePath.join(root, "out"), "keep")
    const result = await check(root, "void 0", ["out/deep/file"])
    expect(Exit.isFailure(result)).toBe(true)
    expect(JSON.stringify(result)).toContain("non-directory ancestor")
    expect(await Fs.readFile(NodePath.join(root, "out"), "utf8")).toBe("keep")
  })

  it.each(["non-file", "growing-file", "growing-total", "changed-after-read"])(
    "refuses output mutation during a snapshot: %s",
    async (fault) => {
      const root = await directory()
      const path = NodePath.join(root, "out")
      await Fs.writeFile(path, "keep")
      const open = Fs.open
      vi.spyOn(Fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args)
        if (args[0] === path) {
          const stat = handle.stat.bind(handle)
          let reads = 0
          vi.spyOn(handle, "stat").mockImplementation(async () => {
            const info = await stat()
            reads++
            if (fault === "non-file") info.isFile = () => false
            if (fault.startsWith("growing")) info.size = 0
            if (fault === "changed-after-read" && reads > 1) info.mtimeMs++
            return info
          })
        }
        return handle
      })
      const limits = fault === "growing-file" ? { fileBytes: 2 } : fault === "growing-total" ? { totalBytes: 2 } : {}
      const result = await check(root, "require('node:fs').writeFileSync('ran','yes')", ["out"], limits)
      expect(Exit.isFailure(result)).toBe(true)
      expect(JSON.stringify(result)).toContain(fault.startsWith("growing") ? "byte limit" : "changed while")
      await expect(Fs.stat(NodePath.join(root, "ran"))).rejects.toThrow()
      expect(await Fs.readFile(path, "utf8")).toBe("keep")
    }
  )

  it.each(["out", "out/parent"])("preserves inspection errors at %s", async (failingPath) => {
    const root = await directory()
    await Fs.mkdir(NodePath.join(root, "out/parent"), { recursive: true })
    const lstat = Fs.lstat
    vi.spyOn(Fs, "lstat").mockImplementation(async (...args) => {
      if (args[0] === NodePath.join(root, failingPath)) {
        throw Object.assign(new Error("inspection denied"), { code: "EACCES" })
      }
      return lstat(...args)
    })
    const result = await check(root, "void 0", [failingPath === "out" ? "out" : "out/parent/file"])
    expect(Exit.isFailure(result)).toBe(true)
    expect(JSON.stringify(result)).toContain("inspection denied")
  })

  it.each([
    [{ fileBytes: 3 }, "file byte limit"],
    [{ totalBytes: 7 }, "aggregate byte limit"]
  ])("refuses snapshot limits before running the generator: %s", async (limits, message) => {
    const root = await directory()
    await Fs.mkdir(NodePath.join(root, "out"))
    await Fs.writeFile(NodePath.join(root, "out/a"), "four")
    await Fs.writeFile(NodePath.join(root, "out/b"), "four")
    const exit = await check(root, "require('node:fs').writeFileSync('ran', 'yes')", ["out"], limits)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain(message)
    await expect(Fs.stat(NodePath.join(root, "ran"))).rejects.toThrow()
    expect(await Fs.readFile(NodePath.join(root, "out/a"), "utf8")).toBe("four")
  })

  it("retains a recoverable tree and names it when restoration fails", async () => {
    const root = await directory()
    await Fs.mkdir(NodePath.join(root, "out"))
    const original = NodePath.join(root, "out/original.txt")
    await Fs.writeFile(original, "irreplaceable bytes")
    await Fs.chmod(original, 0o640)
    const originalMode = (await Fs.stat(original)).mode & 0o777
    const mkdtemp = vi.spyOn(Fs, "mkdtemp")
    const open = Fs.open
    vi.spyOn(Fs, "open").mockImplementation(async (...args) => {
      if (args[0] === original && typeof args[1] === "number" && (args[1] & NodeFsConstants.O_WRONLY) !== 0) {
        throw new Error("injected restore failure")
      }
      return open(...args)
    })
    const exit = await check(
      root,
      "const fs = require('node:fs'); fs.rmSync('out', { recursive: true }); fs.writeFileSync('out', 'replacement')"
    )
    const backup = await mkdtemp.mock.results[0]!.value as string
    temporary.push(backup)
    expect(Exit.isFailure(exit)).toBe(true)
    const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
    expect(message).toContain("injected restore failure")
    expect(message).toContain(`generator backup retained at ${backup}`)
    expect(await Fs.readFile(NodePath.join(backup, "files/out/original.txt"), "utf8")).toBe("irreplaceable bytes")
    const manifest = JSON.parse(await Fs.readFile(NodePath.join(backup, "manifest.json"), "utf8"))
    expect(manifest.root).toBe(root)
    expect(manifest.entries).toContainEqual(
      expect.objectContaining({ path: "out/original.txt", kind: "file", mode: originalMode })
    )
  })

  it("streams multi-chunk binary files back and removes successful backups", async () => {
    const root = await directory()
    await Fs.mkdir(NodePath.join(root, "out"))
    const bytes = Buffer.alloc(3 * 64 * 1024 + 7, 0xab)
    await Fs.writeFile(NodePath.join(root, "out/binary"), bytes)
    const mkdtemp = vi.spyOn(Fs, "mkdtemp")
    const exit = await check(root, "require('node:fs').writeFileSync('out/binary', 'changed')")
    const backup = await mkdtemp.mock.results[0]!.value as string
    temporary.push(backup)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("text preview limited")
    expect(await Fs.readFile(NodePath.join(root, "out/binary"))).toEqual(bytes)
    await expect(Fs.stat(backup)).rejects.toThrow()
  })

  it("drains failed snapshot workers and removes their scratch files", async () => {
    const root = await directory()
    await Fs.mkdir(NodePath.join(root, "out"))
    for (let index = 0; index < 40; index++) await Fs.writeFile(NodePath.join(root, `out/${index}`), "four")
    const mkdtemp = vi.spyOn(Fs, "mkdtemp")
    const exit = await check(root, "void 0", ["out"], { totalBytes: 7 })
    const backup = await mkdtemp.mock.results[0]!.value as string
    temporary.push(backup)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("aggregate byte limit")
    await expect(Fs.stat(backup)).rejects.toThrow()
  })
})
