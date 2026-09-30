import * as BrowserFileSystem from "@smthrs/platform-browser/BrowserFileSystem"
import * as TestHost from "@smthrs/testing/TestHost"
import { Effect, Exit, Fiber, FileSystem, Layer, Scope } from "effect"
import * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import * as NodeFs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as HostSuite from "../../src/HostSuite.ts"

const profile: HostSuite.HostProfile = {
  fileSystem: { supported: true },
  path: { supported: true },
  shell: { supported: true, interruptCommand: ChildProcess.make("host-suite-pending") },
  jj: { supported: false, code: "not_installed" },
  httpTransport: { supported: false, code: "TransportError" },
  clock: { supported: true },
  random: { supported: true }
}

const bundle = TestHost.layer({ commands: { "host-suite-pending": { pending: true } } })

describe("TestHost HostSuite", () => {
  for (const testCase of HostSuite.hostSuite(bundle, profile)) {
    it(testCase.name, () => Effect.runPromise(testCase.run))
  }
})

const outcome = (run: HostSuite.HostSuiteCase["run"]) =>
  run.pipe(
    Effect.match({ onSuccess: () => "passed" as const, onFailure: (error) => error })
  )

const scratchCase = (fs: FileSystem.FileSystem, scratchPath: string) =>
  HostSuite.hostSuite(Layer.merge(bundle, Layer.succeed(FileSystem.FileSystem)(fs)), {
    ...profile,
    fileSystemScratchPath: scratchPath
  })[0]!.run

const cleanupCase = (host: HostSuite.HostBundle, declared = profile) =>
  HostSuite.hostSuite(host, declared).find((testCase) =>
    testCase.name === "Scoped resources clean up on fiber interruption"
  )!
    .run

describe("HostSuite scratch ownership", () => {
  it("round-trips through a real owned directory and removes it", async () => {
    const directory = await NodeFs.mkdtemp(join(tmpdir(), "host-suite-owned-"))
    const scratch = join(directory, "scratch")
    try {
      expect(await Effect.runPromise(outcome(scratchCase(BrowserFileSystem.make(NodeFs), scratch)))).toBe("passed")
      expect(await NodeFs.readdir(directory)).toEqual([])
      await expect(NodeFs.stat(scratch)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await NodeFs.rm(directory, { recursive: true, force: true })
    }
  })

  it("refuses a dangling symlink without creating its target or removing the link", async () => {
    const directory = await NodeFs.mkdtemp(join(tmpdir(), "host-suite-security-"))
    const scratch = join(directory, "scratch")
    const target = join(directory, "target")
    try {
      await NodeFs.symlink(target, scratch, "file")
      const result = await Effect.runPromise(outcome(scratchCase(BrowserFileSystem.make(NodeFs), scratch)))
      expect(result).toMatchObject({ capability: "FileSystem", operation: "scratchPath" })
      expect(await NodeFs.readlink(scratch)).toBe(target)
      await expect(NodeFs.stat(target)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await NodeFs.rm(directory, { recursive: true, force: true })
    }
  })

  it("preserves a competing file created immediately before directory acquisition", async () => {
    const directory = await NodeFs.mkdtemp(join(tmpdir(), "host-suite-race-"))
    const scratch = join(directory, "scratch")
    try {
      const fs = BrowserFileSystem.make({
        ...NodeFs,
        mkdir: async (path, options) => {
          await NodeFs.writeFile(path, "competitor", { flag: "wx" })
          return NodeFs.mkdir(path, options)
        }
      })
      const result = await Effect.runPromise(outcome(scratchCase(fs, scratch)))
      expect(result).toMatchObject({ capability: "FileSystem", operation: "scratchPath" })
      expect(await NodeFs.readFile(scratch, "utf8")).toBe("competitor")
    } finally {
      await NodeFs.rm(directory, { recursive: true, force: true })
    }
  })

  it("does not remove a scratch path when acquisition fails for another reason", async () => {
    const denied = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "makeDirectory"
    })
    let removals = 0
    const fs = FileSystem.makeNoop({
      exists: () => Effect.succeed(false),
      makeDirectory: () => Effect.fail(denied),
      remove: () =>
        Effect.sync(() => {
          removals++
        })
    })
    expect(await Effect.runPromise(outcome(scratchCase(fs, "/scratch")))).toBe(denied)
    expect(removals).toBe(0)
  })

  it("waits for pending directory acquisition before completing cancellation and removing it once", async () => {
    const directory = await NodeFs.mkdtemp(join(tmpdir(), "host-suite-cancel-"))
    const scratch = join(directory, "scratch")
    const events: Array<string> = []
    const removals: Array<string> = []
    let releaseAcquisition!: () => void
    let announceAcquisition!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseAcquisition = resolve
    })
    const acquiring = new Promise<void>((resolve) => {
      announceAcquisition = resolve
    })
    const fs = BrowserFileSystem.make({
      ...NodeFs,
      mkdir: async (path, options) => {
        events.push("acquiring")
        announceAcquisition()
        await gate
        const result = await NodeFs.mkdir(path, options)
        events.push("created")
        return result
      },
      writeFile: async (path, data, options) => {
        events.push("probe-written")
        await NodeFs.writeFile(path, data, options)
      },
      rm: async (path, options) => {
        removals.push(path)
        expect(path).toBe(scratch)
        expect((await NodeFs.stat(path)).isDirectory()).toBe(true)
        await NodeFs.rm(path, options)
        events.push("removed")
      }
    })
    try {
      await Effect.runPromise(Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(scratchCase(fs, scratch), { startImmediately: true })
        yield* Effect.promise(() => acquiring)
        yield* Effect.gen(function*() {
          const cancellation = yield* Effect.forkChild(
            Fiber.interrupt(fiber).pipe(Effect.tap(() => Effect.sync(() => events.push("interrupted")))),
            { startImmediately: true }
          )
          expect(events).toEqual(["acquiring"])
          expect(removals).toEqual([])
          yield* Effect.promise(() => expect(NodeFs.stat(scratch)).rejects.toMatchObject({ code: "ENOENT" }))
          expect(events).toEqual(["acquiring"])
          releaseAcquisition()
          yield* Fiber.join(cancellation)
          const exit = yield* Fiber.await(fiber)
          expect(Exit.hasInterrupts(exit)).toBe(true)
          expect(Exit.hasDies(exit)).toBe(false)
          expect(Exit.hasFails(exit)).toBe(false)
          expect(removals).toEqual([scratch])
          expect(events).toEqual(["acquiring", "created", "removed", "interrupted"])
        }).pipe(Effect.ensuring(Effect.sync(releaseAcquisition)))
      }))
      expect(await NodeFs.readdir(directory)).toEqual([])
    } finally {
      releaseAcquisition()
      await NodeFs.rm(directory, { recursive: true, force: true })
    }
  })

  it("removes its directory and probe file even when the round-trip assertion fails", async () => {
    const fs = BrowserFileSystem.make(TestHost.makeMemoryFs())
    const broken = { ...fs, readFile: () => Effect.succeed(new TextEncoder().encode("wrong")) }
    expect(await Effect.runPromise(outcome(scratchCase(broken, "/scratch")))).toMatchObject({
      capability: "FileSystem",
      operation: "readFile"
    })
    expect(await Effect.runPromise(fs.exists("/scratch"))).toBe(false)
    expect(await Effect.runPromise(fs.exists("/scratch/probe.txt"))).toBe(false)
  })

  it("removes its directory when the probe file write fails", async () => {
    const fs = BrowserFileSystem.make(TestHost.makeMemoryFs())
    const denied = PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "writeFile" })
    const broken = { ...fs, writeFile: () => Effect.fail(denied) }
    expect(await Effect.runPromise(outcome(scratchCase(broken, "/scratch")))).toBe(denied)
    expect(await Effect.runPromise(fs.exists("/scratch"))).toBe(false)
  })

  it("preserves an existing directory and its contents", async () => {
    const directory = await NodeFs.mkdtemp(join(tmpdir(), "host-suite-existing-"))
    const scratch = join(directory, "scratch")
    try {
      await NodeFs.mkdir(scratch)
      await NodeFs.writeFile(join(scratch, "owned.txt"), "owner")
      const result = await Effect.runPromise(outcome(scratchCase(BrowserFileSystem.make(NodeFs), scratch)))
      expect(result).toMatchObject({ capability: "FileSystem", operation: "scratchPath" })
      expect(await NodeFs.readdir(scratch)).toEqual(["owned.txt"])
      expect(await NodeFs.readFile(join(scratch, "owned.txt"), "utf8")).toBe("owner")
    } finally {
      await NodeFs.rm(directory, { recursive: true, force: true })
    }
  })
})

describe("HostSuite observes Host process cleanup", () => {
  it("rejects a Host whose process resource escapes the interrupted scope", async () => {
    const escaped = Scope.makeUnsafe()
    const leaking = Layer.merge(
      bundle,
      Layer.effect(ChildProcessSpawner.ChildProcessSpawner)(
        Effect.map(ChildProcessSpawner.ChildProcessSpawner, (spawner) => ({
          ...spawner,
          spawn: (command: ChildProcess.Command) =>
            spawner.spawn(command).pipe(Effect.provideService(Scope.Scope, escaped))
        }))
      ).pipe(Layer.provide(bundle))
    )
    const result = await Effect.runPromise(
      outcome(cleanupCase(leaking)).pipe(
        Effect.ensuring(Scope.close(escaped, Exit.void))
      )
    )
    expect(result).toMatchObject({ capability: "Scope", operation: "interrupt_cleanup" })
  })

  it("rejects a command that has already exited", async () => {
    const stopped = Layer.merge(
      bundle,
      Layer.effect(ChildProcessSpawner.ChildProcessSpawner)(
        Effect.map(ChildProcessSpawner.ChildProcessSpawner, (spawner) => ({
          ...spawner,
          spawn: (command: ChildProcess.Command) =>
            spawner.spawn(command).pipe(
              Effect.tap((handle) => handle.kill())
            )
        }))
      ).pipe(Layer.provide(bundle))
    )
    expect(await Effect.runPromise(outcome(cleanupCase(stopped)))).toMatchObject({
      capability: "Scope",
      operation: "interrupt_running"
    })
  })

  it("reports acquisition failure instead of waiting forever for a handle", async () => {
    const denied = PlatformError.systemError({ _tag: "PermissionDenied", module: "ChildProcess", method: "spawn" })
    const refusing = Layer.merge(
      bundle,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
        ChildProcessSpawner.make(() => Effect.fail(denied))
      )
    )
    expect(await Effect.runPromise(outcome(cleanupCase(refusing)))).toBe(denied)
  })

  it("checks the declared refusal when shell support is unavailable", async () => {
    const denied = PlatformError.systemError({ _tag: "PermissionDenied", module: "ChildProcess", method: "spawn" })
    const refusing = Layer.merge(
      bundle,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
        ChildProcessSpawner.make(() => Effect.fail(denied))
      )
    )
    expect(
      await Effect.runPromise(outcome(cleanupCase(refusing, {
        ...profile,
        shell: { supported: false, code: "PermissionDenied" }
      })))
    ).toBe("passed")
    expect(
      await Effect.runPromise(outcome(cleanupCase(refusing, {
        ...profile,
        shell: { supported: false, code: "wrong" }
      })))
    ).toMatchObject({ expectedCode: "wrong", actualCode: "PermissionDenied" })
  })
})
