import * as NodePath from "@effect/platform-node/NodePath"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as GuardedSpawner from "../src/ChildProcessSpawner.ts"
import * as CommandLine from "../src/CommandLine.ts"
import * as ContainedSpawner from "../src/ContainedSpawner.ts"
import { GrantStore } from "../src/GrantStore.ts"
import * as KernelPath from "../src/Path.ts"
import * as ProcessLedger from "../src/ProcessLedger.ts"
import * as Rooted from "../src/Rooted.ts"
import * as Workspace from "../src/Workspace.ts"

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const project = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kernel-rooted-")))
  roots.push(root)
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "src", "a.ts"), "a\n")
  return root
}

const allow = GrantStore.of({
  check: () => Effect.void,
  reply: () => Effect.void,
  list: Effect.succeed([]),
  rules: () => Effect.succeed([]),
  grantEnvelope: () => Effect.void
})

/**
 * Prints the canonical working directory natively; `pwd` under Git Bash prints
 * an MSYS path, and Windows may report an 8.3 short name.
 */
const printCwd = (options?: ChildProcess.CommandOptions) =>
  ChildProcess.make(process.execPath, [
    "-e",
    "process.stdout.write(require(\"node:fs\").realpathSync.native(process.cwd()))"
  ], options)

const canonical = (value: string) => realpathSync.native(value)

const lifecycle: ContainedSpawner.Lifecycle = (command, spawn) =>
  Effect.map(spawn(command), (handle) => ({ handle, activate: Effect.void, settled: Effect.succeed(true) }))

describe("Rooted", () => {
  it("resolves paths, globs and commands against the root, not the process cwd", async () => {
    const root = project()
    expect(process.cwd()).not.toBe(root)
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const spawner = yield* ChildProcessSpawner
        return {
          resolved: path.resolve("src"),
          relative: path.relative(".", "src/a.ts"),
          read: yield* fs.readFileString("src/a.ts"),
          glob: yield* fs.glob("src/*.ts"),
          pwd: yield* spawner.string(printCwd()),
          nested: yield* spawner.string(printCwd({ cwd: "src" })),
          piped: (yield* spawner.string(ChildProcess.make`ls`.pipe(ChildProcess.pipeTo(ChildProcess.make`cat`))))
            .trim()
        }
      }).pipe(Effect.provide(Rooted.layer(root).pipe(Layer.provideMerge(NodeServices.layer))))
    )
    expect(result).toEqual({
      resolved: join(root, "src"),
      relative: join("src", "a.ts"),
      read: "a\n",
      glob: [join("src", "a.ts")],
      pwd: canonical(root),
      nested: canonical(join(root, "src")),
      piped: "src"
    })
  })

  it("passes absolute paths through", async () => {
    const root = project()
    const other = project()
    await Effect.runPromise(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(join(other, "b.ts"), "b\n")).pipe(
        Effect.provide(Rooted.layer(root).pipe(Layer.provideMerge(NodeServices.layer)))
      )
    )
    expect(readFileSync(join(other, "b.ts"), "utf8")).toBe("b\n")
  })

  it("resolves every relative filesystem argument against the root", () => {
    const calls: Array<ReadonlyArray<unknown>> = []
    const base = new Proxy({} as FileSystem.FileSystem, {
      get: (_, name) => (...args: ReadonlyArray<unknown>) => calls.push([name, ...args])
    })
    const rooted = Rooted.path(Effect.runSync(Effect.provide(Path.Path, Path.layer)), "/root")
    const fs = Rooted.fileSystem(base, rooted)
    const data = new Uint8Array()
    fs.access("a", { ok: true })
    fs.copy("a", "b", { overwrite: true })
    fs.copyFile("a", "b")
    fs.chmod("a", 0o644)
    fs.chown("a", 1, 2)
    fs.glob("*.ts", { root: "src" })
    fs.glob("*.ts")
    fs.exists("a")
    fs.link("a", "b")
    fs.makeDirectory("a", { recursive: true })
    fs.makeTempDirectory({ directory: "tmp" })
    fs.makeTempDirectoryScoped()
    fs.makeTempFile({ prefix: "p" })
    fs.makeTempFileScoped({ directory: "tmp" })
    fs.open("a", { flag: "r" })
    fs.readDirectory("a", { recursive: true })
    fs.readFile("a")
    fs.readFileString("a", "utf8")
    fs.readLink("a")
    fs.realPath("a")
    fs.remove("a", { recursive: true })
    fs.rename("a", "b")
    fs.sink("a", { flag: "w" })
    fs.stat("a")
    fs.stream("a")
    fs.symlink("target", "a")
    fs.truncate("a", 1)
    fs.utimes("a", 1, 2)
    fs.watch("a", { recursive: true })
    fs.writeFile("a", data, { flag: "w" })
    fs.writeFileString("/abs", "text", { flag: "w" })
    expect(calls).toEqual([
      ["access", "/root/a", { ok: true }],
      ["copy", "/root/a", "/root/b", { overwrite: true }],
      ["copyFile", "/root/a", "/root/b"],
      ["chmod", "/root/a", 0o644],
      ["chown", "/root/a", 1, 2],
      ["glob", "*.ts", { root: "/root/src" }],
      ["glob", "*.ts", { root: "/root" }],
      ["exists", "/root/a"],
      ["link", "/root/a", "/root/b"],
      ["makeDirectory", "/root/a", { recursive: true }],
      ["makeTempDirectory", { directory: "/root/tmp" }],
      ["makeTempDirectoryScoped", undefined],
      ["makeTempFile", { prefix: "p" }],
      ["makeTempFileScoped", { directory: "/root/tmp" }],
      ["open", "/root/a", { flag: "r" }],
      ["readDirectory", "/root/a", { recursive: true }],
      ["readFile", "/root/a"],
      ["readFileString", "/root/a", "utf8"],
      ["readLink", "/root/a"],
      ["realPath", "/root/a"],
      ["remove", "/root/a", { recursive: true }],
      ["rename", "/root/a", "/root/b"],
      ["sink", "/root/a", { flag: "w" }],
      ["stat", "/root/a"],
      ["stream", "/root/a", undefined],
      ["symlink", "target", "/root/a"],
      ["truncate", "/root/a", 1],
      ["utimes", "/root/a", 1, 2],
      ["watch", "/root/a", { recursive: true }],
      ["writeFile", "/root/a", data, { flag: "w" }],
      ["writeFileString", "/abs", "text", { flag: "w" }]
    ])
    expect(String(Effect.runSync(rooted.toFileUrl("a")))).toBe("file:///root/a")
  })

  it("roots relative win32 paths and passes drive and UNC paths through", () => {
    const calls: Array<ReadonlyArray<unknown>> = []
    const base = new Proxy({} as FileSystem.FileSystem, {
      get: (_, name) => (...args: ReadonlyArray<unknown>) => calls.push([name, ...args])
    })
    const rooted = Rooted.path(Effect.runSync(Effect.provide(Path.Path, NodePath.layerWin32)), "D:\\root")
    const fs = Rooted.fileSystem(base, rooted)
    fs.readFile("src\\a.ts")
    fs.readFile("E:\\other\\a.ts")
    fs.readFile("\\\\server\\share\\a.ts")
    expect(calls).toEqual([
      ["readFile", "D:\\root\\src\\a.ts"],
      ["readFile", "E:\\other\\a.ts"],
      ["readFile", "\\\\server\\share\\a.ts"]
    ])
    expect(rooted.resolve("E:\\other")).toBe("E:\\other")
    expect(rooted.resolve("\\\\server\\share\\dir")).toBe("\\\\server\\share\\dir")
    expect(rooted.relative(".", "src\\a.ts")).toBe("src\\a.ts")
    expect(String(Effect.runSync(rooted.toFileUrl("src")))).toBe("file:///D:/root/src")
    const cwds = [undefined, "src", "E:\\other", "\\\\server\\share\\dir"].map((cwd) =>
      CommandLine.cwd(Rooted.command(ChildProcess.make("tool", [], cwd === undefined ? {} : { cwd }), rooted))
    )
    expect(cwds).toEqual(["D:\\root", "D:\\root\\src", "E:\\other", "\\\\server\\share\\dir"])
  })

  for (const owned of [true, false]) {
    it(`keeps a spawner's containment (owned=${owned})`, () =>
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const path = yield* Path.Path
        expect(ContainedSpawner.isContained(Rooted.spawner(spawner, path))).toBe(owned)
      }).pipe(
        Effect.provide(ContainedSpawner.layer({}, owned ? lifecycle : undefined)),
        Effect.provide(GuardedSpawner.layerNoop()),
        Effect.provide(ProcessLedger.layerMemory({ hostId: "rooted", ownerPid: 1 })),
        Effect.provide(NodeServices.layer),
        Effect.runPromise
      ))
  }

  it("roots the kernel spawner and path at Workspace.root", async () => {
    const root = project()
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const path = yield* Path.Path
        return {
          resolved: path.resolve("src"),
          pwd: yield* spawner.string(printCwd()),
          nested: yield* spawner.string(printCwd({ cwd: "src" }))
        }
      }).pipe(
        Effect.provide(Layer.merge(GuardedSpawner.layer, KernelPath.layer)),
        Effect.provide([Workspace.layer(root), Layer.succeed(GrantStore, allow)]),
        Effect.provide(NodeServices.layer)
      )
    )
    expect(result).toEqual({
      resolved: join(root, "src"),
      pwd: canonical(root),
      nested: canonical(join(root, "src"))
    })
  })
})
