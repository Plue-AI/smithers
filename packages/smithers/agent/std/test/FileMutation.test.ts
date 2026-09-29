import { Cause, Effect, Exit, FileSystem, Option, Path, PlatformError } from "effect"
import { win32 } from "node:path"
import { describe, expect, it } from "vitest"
import * as FileMutation from "../src/internal/FileMutation.ts"

// Fault injection tests exercise portable host failures without depending on
// OS permissions or root privileges. Real host/process races live separately.
const failure = (tag: PlatformError.SystemErrorTag, method: string) =>
  Effect.fail(PlatformError.systemError({ _tag: tag, module: "FileSystem", method }))
const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
const host = () => {
  const held = new Set<string>()
  const acquired: Array<string> = []
  const fs = FileSystem.makeNoop({
    realPath: (path) => Effect.succeed(path === "/alias" ? "/file" : path),
    makeDirectory: (path) =>
      Effect.sync(() => {
        acquired.push(path)
        held.add(path)
      }),
    remove: (path) =>
      Effect.sync(() => {
        held.delete(path)
      })
  })
  return { fs, held, acquired }
}

const posix = Effect.runSync(Effect.provide(Path.Path, Path.layer))
const windows: Path.Path = { ...posix, join: win32.join, dirname: win32.dirname, basename: win32.basename }

describe("file mutation lock lifecycle", () => {
  it("keeps the on-disk lock name stable across dependency upgrades", async () => {
    const { fs, acquired } = host()
    await Effect.runPromise(Effect.scoped(FileMutation.acquire(fs, ["/file"])))
    expect(acquired).toEqual(["/.smithers-5f5558c.lock"])
  })

  it("deduplicates canonical aliases and releases after a body failure", async () => {
    const { fs, held, acquired } = host()
    const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function*() {
      yield* FileMutation.acquire(fs, ["/file", "/alias", "/other"])
      expect(held.size).toBe(2)
      return yield* Effect.fail("body failed")
    })))
    expect(failureOf(exit)).toBe("body failed")
    expect(acquired).toHaveLength(2)
    expect(held.size).toBe(0)
  })

  it.each(["AlreadyExists", "PermissionDenied", "Unknown"] as const)(
    "releases earlier locks after %s admission failure",
    async (reason) => {
      const { fs, held } = host()
      let attempts = 0
      const faulty = {
        ...fs,
        makeDirectory: (path: string) => ++attempts === 2 ? failure(reason, "makeDirectory") : fs.makeDirectory(path)
      }
      const exit = await Effect.runPromiseExit(Effect.scoped(FileMutation.acquire(faulty, ["/first", "/second"])))
      expect(failureOf(exit)?.code).toBe(
        reason === "AlreadyExists" ? "no_match" : reason === "PermissionDenied" ? "permission_denied" : "command_failed"
      )
      expect(attempts).toBe(2)
      expect(held.size).toBe(0)
    }
  )

  it.each(["PermissionDenied", "NotFound", "Unknown"] as const)(
    "refuses a %s identity failure without locking",
    async (reason) => {
      const { fs, acquired } = host()
      const exit = await Effect.runPromiseExit(
        Effect.scoped(FileMutation.acquire({ ...fs, realPath: () => failure(reason, "realPath") }, ["/parent/file"]))
      )
      expect(failureOf(exit)?.code).toBe(
        reason === "PermissionDenied" ? "permission_denied" : reason === "NotFound" ? "not_found" : "command_failed"
      )
      expect(acquired).toEqual([])
    }
  )

  it("uses the canonical parent for a missing relative destination", async () => {
    const { fs, acquired } = host()
    const paths: Array<string> = []
    const missing = {
      ...fs,
      realPath: (path: string) => {
        paths.push(path)
        return path === "new" ? failure("NotFound", "realPath") : Effect.succeed("/canonical")
      }
    }
    await Effect.runPromise(Effect.scoped(FileMutation.acquire(missing, ["new"], posix)))
    expect(paths).toEqual(["new", "."])
    expect(acquired).toHaveLength(1)
    expect(acquired[0]).toMatch(/^\/canonical\/\.smithers-.*\.lock$/)
  })

  it("uses the same root-level lock before and after creating a file", async () => {
    const { fs, acquired } = host()
    await Effect.runPromise(Effect.scoped(FileMutation.acquire(
      {
        ...fs,
        realPath: (path) => path === "/new" ? failure("NotFound", "realPath") : Effect.succeed("/")
      },
      ["/new"],
      posix
    )))
    await Effect.runPromise(Effect.scoped(FileMutation.acquire(fs, ["/new"])))
    expect(acquired).toHaveLength(2)
    expect(acquired[0]).toBe(acquired[1])
  })

  it("uses one lock for case aliases even when realPath keeps the requested spelling", async () => {
    const { fs, acquired } = host()
    await Effect.runPromise(Effect.scoped(FileMutation.acquire(fs, ["/File.txt", "/file.txt"])))
    expect(acquired).toHaveLength(1)
  })

  it("uses the same Windows lock before and after creating a file", async () => {
    const { fs, acquired } = host()
    await Effect.runPromise(Effect.scoped(FileMutation.acquire(
      {
        ...fs,
        realPath: (path) => path === "C:\\dir\\new" ? failure("NotFound", "realPath") : Effect.succeed("C:\\dir")
      },
      ["C:\\dir\\new"],
      windows
    )))
    await Effect.runPromise(Effect.scoped(FileMutation.acquire(fs, ["C:\\dir\\new"])))
    expect(acquired).toHaveLength(2)
    expect(acquired[0]).toBe(acquired[1])
  })

  it("surfaces release failure instead of reporting a clean success", async () => {
    const { fs } = host()
    const exit = await Effect.runPromiseExit(
      Effect.scoped(FileMutation.acquire({ ...fs, remove: () => failure("PermissionDenied", "remove") }, ["/file"]))
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
